import { IDeployerComponent } from '@dcl/snapshots-fetcher/dist/types'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { AppComponents } from '../../types'
import { createContentClient } from 'dcl-catalyst-client'
import { CatalystDeploymentEvent, Entity, Events } from '@dcl/schemas'

export function createDeployerComponent(
  components: Pick<AppComponents, 'logs' | 'storage' | 'downloadQueue' | 'fetch' | 'metrics' | 'sns'>
): IDeployerComponent {
  const logger = components.logs.getLogger('downloader')

  const client = new SNSClient({
    endpoint: components.sns.optionalSnsEndpoint
  })

  return {
    async deployEntity(entity, servers) {
      const markEntityAsDeployed = entity.markAsDeployed ? entity.markAsDeployed : async () => {}

      try {
        const contentClient = createContentClient({ fetcher: components.fetch, url: servers[0] })
        const fetchedEntity: Entity | undefined = await contentClient.fetchEntityById(entity.entityId)

        if (!fetchedEntity) {
          logger.info('Entity not found on Catalyst, marking it as deployed', { entityId: entity.entityId })
          await markEntityAsDeployed()
        }

        logger.info('Entity downloaded correctly from Catalyst', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          pointers: fetchedEntity.pointers.join(' - ')
        })

        const eventToPublish: CatalystDeploymentEvent = {
          type: Events.Type.CATALYST_DEPLOYMENT,
          subType: entity.entityType as Events.SubType.CatalystDeployment,
          key: entity.entityId,
          timestamp: fetchedEntity.timestamp,
          entity: fetchedEntity,
          contentServerUrls: servers
        }

        const receipt = await client.send(
          new PublishCommand({
            TopicArn: components.sns.arn,
            Message: JSON.stringify(eventToPublish)
          })
        )

        logger.info('Notification sent', {
          messageId: receipt.MessageId as any,
          sequenceNumber: receipt.SequenceNumber as any,
          entityId: entity.entityId,
          entityPointers: fetchedEntity.pointers.join(' - ')
        })

        await markEntityAsDeployed()
      } catch (error: any) {
        logger.error('Failure while processing entity', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          error: error?.message
        })

        logger.debug('Error details', {
          entityId: entity.entityId,
          stack: error.stack,
          message: error.message
        })

        const isNotRetryable = /status: 4\d{2}/.test(error.message)
        if (isNotRetryable) {
          logger.error('Failed to download entity', {
            entityId: entity.entityId,
            entityType: entity.entityType,
            error: error?.message
          })
          await markEntityAsDeployed()
        }
      }
    },
    async onIdle() {}
  }
}
