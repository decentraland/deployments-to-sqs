import { DeployableEntity, IDeployerComponent, TimeRange } from '@dcl/snapshots-fetcher/dist/types'
import { AppComponents, EntityDownloadError, SnsPublisherComponent } from '../../types'

export async function createDeployerComponent(
  components: Pick<
    AppComponents,
    | 'config'
    | 'logs'
    | 'storage'
    | 'downloadQueue'
    | 'fetch'
    | 'metrics'
    | 'snsPublisher'
    | 'snsEventPublisher'
    | 'entityDownloader'
    | 'contentChangeChecker'
    | 'manifestCopier'
  >
): Promise<IDeployerComponent> {
  const logger = components.logs.getLogger('Deployer')

  const maxAgeInSeconds = parseInt((await components.config.getString('ENTITY_MAX_AGE_IN_SECONDS')) ?? '', 10)

  if (maxAgeInSeconds > 0) {
    logger.info('Entity age filter enabled', { maxAgeInSeconds })
  } else {
    logger.info('Entity age filter disabled')
  }

  async function publishDeploymentNotifications(entity: DeployableEntity & { metadata: any }, servers: string[]) {
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
        if (maxAgeInSeconds > 0) {
          const entityAgeInSeconds = (Date.now() - entity.entityTimestamp) / 1000
          if (entityAgeInSeconds > maxAgeInSeconds) {
            logger.debug('Skipping old entity', {
              entityId: entity.entityId,
              entityType: entity.entityType,
              entityAgeInSeconds,
              maxAgeInSeconds
            })
            components.metrics.increment('entity_skipped_old', { entityType: entity.entityType })
            return await markAsDeployed()
          }
        }

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

        // Check if content has changed compared to the registry
        const changeResult = await components.contentChangeChecker.check(entity, servers)
        if (changeResult.changed === false) {
          const { registryEntity } = changeResult
          logger.info('Content unchanged, copying manifests', {
            entityId: entity.entityId,
            registryEntityId: registryEntity.id
          })
          try {
            await components.manifestCopier.copyAndNotify(entity, registryEntity)
            components.metrics.increment('entity_skipped_content_unchanged', {
              entityType: entity.entityType
            })
            return await markAsDeployed()
          } catch (error: any) {
            logger.warn('Manifest copy failed, falling back to normal deployment', {
              entityId: entity.entityId,
              error: error?.message
            })
          }
        }

        await components.downloadQueue.onSizeLessThan(1000)

        void components.downloadQueue.scheduleJob(async () => {
          try {
            const metadata = await components.entityDownloader.downloadEntity(entity, servers)

            await publishDeploymentNotifications({ ...entity, metadata }, servers)

            await markAsDeployed()

            components.metrics.increment('entity_deployment_success', {
              entityType: entity.entityType
            })
          } catch (error: any) {
            if (error instanceof EntityDownloadError) {
              return
            }

            const isNotRetryable = /status: 4\d{2}/.test(error.message)

            logger.error('Failed to publish entity', {
              entityId: entity.entityId,
              entityType: entity.entityType,
              error: error?.message,
              stack: error?.stack
            })

            components.metrics.increment('entity_deployment_failure', {
              retryable: isNotRetryable ? 'false' : 'true',
              entityType: entity.entityType
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
        })
      } catch (error: any) {
        logger.error('Failed to schedule entity deployment', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          error: error?.message,
          stack: error?.stack
        })

        components.metrics.increment('entity_deployment_failure', {
          entityType: entity.entityType
        })
      }
    },
    async onIdle() {},
    async prepareForDeploymentsIn(_timeRanges: TimeRange[]) {}
  }
}
