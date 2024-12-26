import { downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import { AppComponents, EntityDownloaderComponent, EntityDownloadError } from '../../types'

export async function createEntityDownloaderComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'storage' | 'fetch' | 'metrics'>
): Promise<EntityDownloaderComponent> {
  const logger = components.logs.getLogger('EntityDownloader')
  const maxRetries: number = (await components.config.getNumber('MAX_RETRIES')) || 10
  const waitTimeBetweenRetries: number = (await components.config.getNumber('WAIT_TIME_BETWEEN_RETRIES')) || 1000

  return {
    async downloadEntity(entity: DeployableEntity, servers: string[]) {
      const markAsDeployed = entity.markAsDeployed || (async () => {})

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
          maxRetries,
          waitTimeBetweenRetries
        )

        components.metrics.increment('entity_download_success', { entityType: entity.entityType })
      } catch (error: any) {
        logger.error('Failed to download entity', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          errorMessage: error.message
        })

        components.metrics.increment('entity_download_failure', { entityType: entity.entityType })

        const isNonRetryable = error.message?.match(/status: 4\d{2}/)

        if (isNonRetryable) {
          await markAsDeployed()
        }

        throw new EntityDownloadError(error.message, {
          entity,
          error
        })
      }

      logger.info('Entity stored', { entityId: entity.entityId, entityType: entity.entityType })
    }
  }
}
