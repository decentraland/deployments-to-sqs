import { downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import { AppComponents, EntityDownloaderComponent } from '../../types'

export function createEntityDownloaderComponent(
  components: Pick<AppComponents, 'logs' | 'storage' | 'fetch' | 'metrics'>
): EntityDownloaderComponent {
  const logger = components.logs.getLogger('EntityDownloader')

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
          10,
          1000
        )
      } catch (error: any) {
        logger.error('Failed to download entity', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          errorMessage: error.message
        })

        const isNonRetryable = error.message?.match(/status: 4\d{2}/)

        if (isNonRetryable) {
          await markAsDeployed()
        }

        return
      }

      logger.info('Entity stored', { entityId: entity.entityId, entityType: entity.entityType })
    }
  }
}
