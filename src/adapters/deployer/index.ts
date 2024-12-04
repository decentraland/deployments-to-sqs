import { downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { IDeployerComponent } from '@dcl/snapshots-fetcher/dist/types'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { AppComponents } from '../../types'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { Events } from '@dcl/schemas/dist/platform/events'

export function createDeployerComponent(
  components: Pick<AppComponents, 'logs' | 'storage' | 'downloadQueue' | 'fetch' | 'metrics' | 'sns'>
): IDeployerComponent {
  const logger = components.logs.getLogger('downloader')

  const client = new SNSClient({
    endpoint: components.sns.optionalSnsEndpoint ? components.sns.optionalSnsEndpoint : undefined
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

        logger.debug('Handling entity', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          exists: exists ? 'true' : 'false',
          isSnsEntityToSend: isSnsEntityToSend ? 'true' : 'false',
          isSnsEventToSend: isSnsEventToSend ? 'true' : 'false'
        })

        if (exists) {
          return await markAsDeployed()
        }

        await components.downloadQueue.onSizeLessThan(1000)

        void components.downloadQueue.scheduleJob(async () => {
          logger.info('Downloading entity', {
            entityId: entity.entityId,
            entityType: entity.entityType,
            servers: servers.join(',')
          })

          try {
            await downloadEntityAndContentFiles(
              { ...components, fetcher: components.fetch },
              entity.entityId,
              servers,
              new Map(),
              'content',
              10,
              1000
            )
          } catch (error: any) {
            logger.error('Failed to download entity', {
              entityId: entity.entityId,
              entityType: entity.entityType,
              errorMessage: error.message
            })

            const match = error.message?.match(/status: 4\d{2}/)

            if (match) {
              await markAsDeployed()
            }

            return
          }

          logger.info('Entity stored', { entityId: entity.entityId, entityType: entity.entityType })

          const deploymentToSqs: DeploymentToSqs = {
            entity,
            contentServerUrls: servers
          }

          // send sns
          if (isSnsEntityToSend) {
            const receipt = await client.send(
              new PublishCommand({
                TopicArn: components.sns.arn,
                Message: JSON.stringify(deploymentToSqs)
              })
            )
            logger.info('Notification sent', {
              messageId: receipt.MessageId as any,
              sequenceNumber: receipt.SequenceNumber as any,
              entityId: entity.entityId,
              entityType: entity.entityType
            })
          }

          if (isSnsEventToSend) {
            // TODO: this should be a CatalystDeploymentEvent
            const deploymentEvent = {
              type: Events.Type.CATALYST_DEPLOYMENT,
              subType: entity.entityType as Events.SubType.CatalystDeployment,
              ...deploymentToSqs
            } as any

            const receipt = await client.send(
              new PublishCommand({
                TopicArn: components.sns.eventArn,
                Message: JSON.stringify(deploymentEvent),
                MessageAttributes: {
                  type: { DataType: 'String', StringValue: deploymentEvent.type },
                  subType: { DataType: 'String', StringValue: deploymentEvent.subType }
                }
              })
            )
            logger.info('Notification sent to events SNS', {
              MessageId: receipt.MessageId as any,
              SequenceNumber: receipt.SequenceNumber as any,
              entityId: entity.entityId,
              entityType: entity.entityType
            })
          }
          await markAsDeployed()
        })
      } catch (error: any) {
        const isNotRetryable = /status: 4\d{2}/.test(error.message)
        logger.error('Failed to publish entity', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          error: error?.message,
          stack: error?.stack
        })

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
