import { DeployableEntity, IDeployerComponent, TimeRange } from '@dcl/snapshots-fetcher/dist/types'
import { AppComponents } from '../../types'

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

  async function notifyDeployment(entity: DeployableEntity, servers: string[]) {
    const { snsPublisher, snsEventPublisher } = components

    const shouldSendEntityToSns = ['scene', 'wearable', 'emote'].includes(entity.entityType)

    if (shouldSendEntityToSns) {
      await snsPublisher.publishMessage(entity, servers)
    }

    await snsEventPublisher.publishMessage(entity, servers)
  }

  return {
    async scheduleEntityDeployment(entity, servers) {
      const markAsDeployed = entity.markAsDeployed || (async () => {})

      try {
        const exists = await components.storage.exist(entity.entityId)

        if (exists) {
          logger.debug('Entity already stored', {
            entityId: entity.entityId,
            entityType: entity.entityType
          })
          return await markAsDeployed()
        }

        await components.downloadQueue.onSizeLessThan(1000)

        void components.downloadQueue.scheduleJob(async () => {
          await components.entityDownloader.downloadEntity(entity, servers)
          await notifyDeployment(entity, servers)
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
    async onIdle() {},
    async prepareForDeploymentsIn(_timeRanges: TimeRange[]) {}
  }
}
