import { ContentMapping, DeployableEntity, downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { AppComponents, EntityDownloaderComponent, EntityDownloadError } from '../../types'
import { toEntityTypeLabel } from '../../logic/entity-type-label'
import { getPositiveInt } from '../../logic/tuning'

export async function createEntityDownloaderComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'storage' | 'fetch' | 'metrics'>
): Promise<EntityDownloaderComponent> {
  const logger = components.logs.getLogger('EntityDownloader')
  const maxRetries: number = (await components.config.getNumber('MAX_RETRIES')) || 10
  const waitTimeBetweenRetries: number = (await components.config.getNumber('WAIT_TIME_BETWEEN_RETRIES')) || 1000

  // Per entity, and there is no global bound, so the in-flight ceiling is
  // DOWNLOAD_QUEUE_CONCURRENCY x this. Lowered from the library default of 10.
  const contentFilesConcurrency = await getPositiveInt(components.config, 'CONTENT_FILES_CONCURRENCY', 4)

  return {
    async downloadEntity(entity: DeployableEntity, servers: string[]): Promise<any> {
      const markAsDeployed = entity.markAsDeployed || (async () => {})
      const entityTypeLabel = toEntityTypeLabel(entity.entityType)

      logger.info('Downloading entity', {
        entityId: entity.entityId,
        entityType: entity.entityType,
        servers: servers.join(',')
      })

      try {
        const { metadata } = (await downloadEntityAndContentFiles(
          { ...components, fetcher: components.fetch },
          entity.entityId,
          servers,
          new Map(),
          'content',
          maxRetries,
          waitTimeBetweenRetries,
          contentFilesConcurrency
        )) as {
          type: string
          metadata?: any
          content?: ContentMapping[]
        }

        components.metrics.increment('entity_download_success', { entityType: entityTypeLabel })
        logger.info('Entity stored', { entityId: entity.entityId, entityType: entity.entityType })
        return metadata
      } catch (error: any) {
        logger.error('Failed to download entity', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          errorMessage: error.message
        })

        const isNonRetryable = error.message?.match(/status: 4\d{2}/)

        components.metrics.increment('entity_download_failure', {
          entityType: entityTypeLabel,
          retryable: isNonRetryable ? 'false' : 'true'
        })

        if (isNonRetryable) {
          await markAsDeployed()
        }

        throw new EntityDownloadError(error.message, {
          entity,
          error
        })
      }
    }
  }
}
