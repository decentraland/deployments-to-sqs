import { ContentMapping, DeployableEntity, downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { AppComponents, EntityDownloaderComponent, EntityDownloadError } from '../../types'
import { toEntityTypeLabel } from '../../logic/entity-type-label'
import { getPositiveInt } from '../../logic/tuning'
import { isNonRetryableErrorMessage } from '../../logic/retryable'

// snapshots-fetcher keeps a hash-valid stored file that is not entity JSON: it may be legitimate content.
const LIBRARY_KEPT_STORED_FILE = /the local copy was kept/

export async function createEntityDownloaderComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'storage' | 'fetch' | 'metrics'>
): Promise<EntityDownloaderComponent> {
  const logger = components.logs.getLogger('EntityDownloader')
  const maxRetries: number = (await components.config.getNumber('MAX_RETRIES')) || 10
  const waitTimeBetweenRetries: number = (await components.config.getNumber('WAIT_TIME_BETWEEN_RETRIES')) || 1000

  // Per entity, and there is no global bound, so the in-flight ceiling is
  // DOWNLOAD_QUEUE_CONCURRENCY x this. Lowered from the library default of 10.
  const contentFilesConcurrency = await getPositiveInt(components.config, 'CONTENT_FILES_CONCURRENCY', 4)

  async function discardEntityFile(entity: DeployableEntity): Promise<void> {
    try {
      await components.storage.delete([entity.entityId])
    } catch (error: unknown) {
      logger.error('Failed to remove the stored entity file', {
        entityId: entity.entityId,
        entityType: entity.entityType,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return {
    discardEntityFile,
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
          errorMessage: error?.message
        })

        const isNonRetryable = isNonRetryableErrorMessage(error?.message)

        components.metrics.increment('entity_download_failure', {
          entityType: entityTypeLabel,
          retryable: isNonRetryable ? 'false' : 'true'
        })

        // The entity file is stored before its content files, so a failure can leave it behind;
        // the deployer's dedup check would then skip every retry and the event would be lost.
        if (!LIBRARY_KEPT_STORED_FILE.test(error?.message ?? '')) {
          await discardEntityFile(entity)
        }

        if (isNonRetryable) {
          await markAsDeployed()
        }

        throw new EntityDownloadError(error?.message, {
          entity,
          error
        })
      }
    }
  }
}
