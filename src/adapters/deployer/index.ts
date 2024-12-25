import { DeployableEntity, IDeployerComponent, TimeRange } from '@dcl/snapshots-fetcher/dist/types'
import { AppComponents, SnsPublisherComponent } from '../../types'

export function createDeployerComponent(
  components: Pick<
    AppComponents,
    | 'logs'
    | 'storage'
    | 'downloadQueue'
    | 'fetch'
    | 'metrics'
    | 'snsPublisher'
    | 'snsEventPublisher'
    | 'entityDownloader'
  >
): IDeployerComponent {
  const logger = components.logs.getLogger('Deployer')

  async function publishDeploymentNotifications(entity: DeployableEntity, servers: string[]) {
    const { snsPublisher, snsEventPublisher } = components

    const shouldSendEntityToSns = ['scene', 'wearable', 'emote'].includes(entity.entityType)

    const publishers = [shouldSendEntityToSns && snsPublisher, snsEventPublisher]
      .filter((publisher): publisher is SnsPublisherComponent => !!publisher)
      .map(async (publisher) => await publisher.publishMessage(entity, servers))

    await Promise.all(publishers)
  }

  return {
    async scheduleEntityDeployment(entity, servers) {
      logger.debug('Scheduling entity deployment', {
        entityId: entity.entityId,
        entityType: entity.entityType
      })

      const markAsDeployed = entity.markAsDeployed || (async () => {})

      components.metrics.increment('schedule_entity_deployment_attempt', {
        entityType: entity.entityType
      })

      try {
        const exists = await components.storage.exist(entity.entityId)

        if (exists) {
          logger.debug('Entity already stored', {
            entityId: entity.entityId,
            entityType: entity.entityType
          })
          components.metrics.increment('entity_already_stored', {
            entityType: entity.entityType
          })
          return await markAsDeployed()
        }

        await components.downloadQueue.onSizeLessThan(1000)

        void components.downloadQueue.scheduleJob(async () => {
          await components.entityDownloader.downloadEntity(entity, servers)
          await publishDeploymentNotifications(entity, servers)
          await markAsDeployed()

          components.metrics.increment('entity_deployment_success', {
            entityType: entity.entityType
          })
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

        components.metrics.increment('entity_deployment_failure', {
          retryable: isNotRetryable ? 'false' : 'true',
          entityType: entity.entityType
        })
      }
    },
    async onIdle() {},
    async prepareForDeploymentsIn(_timeRanges: TimeRange[]) {}
  }
}
