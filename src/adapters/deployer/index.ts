import { downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { IDeployerComponent } from '@dcl/snapshots-fetcher/dist/types'
import { SNS } from 'aws-sdk'
import { AppComponents } from '../../types'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'

export function createDeployerComponent(
  components: Pick<AppComponents, 'logs' | 'storage' | 'downloadQueue' | 'fetch' | 'metrics' | 'sns'>
): IDeployerComponent {
  const logger = components.logs.getLogger('downloader')

  const sns = new SNS()

  return {
    async deployEntity(entity, servers) {
      const markAsDeployed = entity.markAsDeployed ? entity.markAsDeployed : async () => {}
      try {
        if (entity.entityType === 'scene' || entity.entityType === 'wearable' || entity.entityType === 'emote') {
          const exists = await components.storage.exist(entity.entityId)

          if (!exists) {
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

              const deploymentToSqs: DeploymentToSqs = {
                entity,
                contentServerUrls: servers
              }
              // send sns
              if (components.sns.arn) {
                const receipt = await sns
                  .publish({
                    TopicArn: components.sns.arn,
                    Message: JSON.stringify(deploymentToSqs)
                  })
                  .promise()
                logger.info('Notification sent', {
                  MessageId: receipt.MessageId as any,
                  SequenceNumber: receipt.SequenceNumber as any
                })
              }

              if (components.sns.eventArn) {
                const receipt = await sns
                  .publish({
                    TopicArn: components.sns.eventArn,
                    Message: JSON.stringify(deploymentToSqs)
                  })
                  .promise()
                logger.info('Notification sent to events SNS', {
                  MessageId: receipt.MessageId as any,
                  SequenceNumber: receipt.SequenceNumber as any
                })
              }
              await markAsDeployed()
            })
          } else {
            await markAsDeployed()
          }
        } else {
          await markAsDeployed()
        }
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
