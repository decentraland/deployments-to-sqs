import { downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { IDeployerComponent } from '@dcl/snapshots-fetcher/dist/types'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { AppComponents } from '../../types'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'

export function createDeployerComponent(
  components: Pick<AppComponents, 'logs' | 'storage' | 'downloadQueue' | 'fetch' | 'metrics' | 'sns'>
): IDeployerComponent {
  const logger = components.logs.getLogger('downloader')

  const client = new SNSClient({
    endpoint: components.sns.optionalSnsEndpoint
  })

  return {
    async deployEntity(entity, servers) {
      const markAsDeployed = entity.markAsDeployed ? entity.markAsDeployed : async () => {}
      try {
        const exists = await components.storage.exist(entity.entityId)

        const isSnsEntityToSend =
          (entity.entityType === 'scene' || entity.entityType === 'wearable' || entity.entityType === 'emote') &&
          !!components.sns.arn

        const isSnsEventToSend = !!components.sns.eventArn

        if (exists) {
          return await markAsDeployed()
        }

        const deploymentToSqs: DeploymentToSqs = {
          entity,
          contentServerUrls: servers
        }

        if (isSnsEntityToSend) {
          await components.downloadQueue.onSizeLessThan(1000)

          void components.downloadQueue.scheduleJob(async () => {
            logger.info('Downloading entity', {
              entityId: entity.entityId,
              entityType: entity.entityType,
              servers: servers.join(',')
            })

            await downloadEntityAndContentFiles(
              { ...components, fetcher: components.fetch },
              entity.entityId,
              servers,
              new Map(),
              'content',
              10,
              1000
            )

            logger.info('Entity stored', { entityId: entity.entityId, entityType: entity.entityType })
            // send sns
            const receipt = await client.send(
              new PublishCommand({
                TopicArn: components.sns.arn,
                Message: JSON.stringify(deploymentToSqs)
              })
            )
            logger.info('Notification sent', {
              messageId: receipt.MessageId as any,
              sequenceNumber: receipt.SequenceNumber as any
            })
          })
        }

        if (isSnsEventToSend) {
          const receipt = await client.send(
            new PublishCommand({
              TopicArn: components.sns.eventArn,
              Message: JSON.stringify(deploymentToSqs)
            })
          )
          logger.info('Notification sent to events SNS', {
            messageId: receipt.MessageId as any,
            sequenceNumber: receipt.SequenceNumber as any,
            entityId: deploymentToSqs.entity.entityId
          })
        }

        await markAsDeployed()
      } catch (error: any) {
        const isNotRetryable = /status: 4\d{2}/.test(error.message)
        if (isNotRetryable) {
          logger.error('Failed to download entity', {
            entityId: entity.entityId,
            entityType: entity.entityType,
            error: error?.message
          })
          await markAsDeployed()
        }
      }
    },
    async onIdle() {}
  }
}
