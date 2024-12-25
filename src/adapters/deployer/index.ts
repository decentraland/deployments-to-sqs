import { downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { IDeployerComponent, TimeRange } from '@dcl/snapshots-fetcher/dist/types'
import { AppComponents } from '../../types'

export function createDeployerComponent(
  components: Pick<
    AppComponents,
    'logs' | 'storage' | 'downloadQueue' | 'fetch' | 'metrics' | 'snsPublisher' | 'snsEventPublisher'
  >
): IDeployerComponent {
  const logger = components.logs.getLogger('downloader')

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

        const shouldSendEntityToSns = ['scene', 'wearable', 'emote'].includes(entity.entityType)

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

          if (shouldSendEntityToSns) {
            await components.snsPublisher.publishMessage(entity, servers)
          }

          await components.snsEventPublisher.publishMessage(entity, servers)

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
