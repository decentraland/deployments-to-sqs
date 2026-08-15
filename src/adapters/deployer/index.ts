import { DeployableEntity, IDeployerComponent, TimeRange } from '@dcl/snapshots-fetcher'
import { AppComponents, EntityDownloadError, SnsPublisherComponent } from '../../types'
import { isValidEntityId } from '../../logic/validation'
import { toEntityTypeLabel } from '../../logic/entity-type-label'
import { getPositiveInt } from '../../logic/tuning'

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
  >
): Promise<IDeployerComponent> {
  const logger = components.logs.getLogger('Deployer')

  const maxAgeInSeconds = parseInt((await components.config.getString('ENTITY_MAX_AGE_IN_SECONDS')) ?? '', 10)

  // Blocks the stream, not just the queue: scheduleEntityDeployment is awaited per entity.
  const maxPendingDeployments = await getPositiveInt(components.config, 'DOWNLOAD_QUEUE_MAX_PENDING', 1000)

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

      // Remote input: clamp before it reaches a label. Log fields keep the raw value.
      const entityTypeLabel = toEntityTypeLabel(entity.entityType)

      components.metrics.increment('schedule_entity_deployment_attempt', {
        entityType: entityTypeLabel
      })

      // entityId comes from the (external) content server and flows into storage
      // keys. A real entity id is a bare CID; reject anything with separators or
      // `..` to prevent path traversal / S3-key injection. Drop it permanently
      // (markAsDeployed) so snapshot-fetcher doesn't retry an unprocessable entity.
      if (!isValidEntityId(entity.entityId)) {
        logger.warn('Skipping entity: entityId is not a bare CID (path/key-injection guard)', {
          entityId: String(entity.entityId).slice(0, 80),
          entityType: entity.entityType
        })
        components.metrics.increment('entity_skipped_invalid_id', { entityType: entityTypeLabel })
        return await markAsDeployed()
      }

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
            components.metrics.increment('entity_skipped_old', { entityType: entityTypeLabel })
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
            entityType: entityTypeLabel
          })
          return await markAsDeployed()
        }

        await components.downloadQueue.onSizeLessThan(maxPendingDeployments)

        // IJobQueue exposes no size/pending, so count the transitions here.
        components.metrics.increment('download_queue_size')

        // scheduleJob throws synchronously on a stopped queue, so .catch cannot see it.
        try {
          // The queue's promise, not the job's: p-queue rejects it on timeout, and discarding that
          // aborts the process under --unhandled-rejections=strict. Not awaited, to stay non-blocking.
          void components.downloadQueue
            .scheduleJob(async () => {
              // Queued -> running; the finally below settles it even if the job throws.
              components.metrics.decrement('download_queue_size')
              components.metrics.increment('download_queue_pending')
              try {
                const metadata = await components.entityDownloader.downloadEntity(entity, servers)

                await publishDeploymentNotifications({ ...entity, metadata }, servers)

                await markAsDeployed()

                components.metrics.increment('entity_deployment_success', {
                  entityType: entityTypeLabel
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
                  entityType: entityTypeLabel
                })

                if (isNotRetryable) {
                  logger.error('Failed to download entity', {
                    entityId: entity.entityId,
                    entityType: entity.entityType,
                    error: error?.message
                  })

                  await markAsDeployed()
                }
              } finally {
                components.metrics.decrement('download_queue_pending')
              }
            })
            .catch((error: any) => {
              // Observe only: a timed-out job keeps running and may still markAsDeployed.
              logger.error('Download queue rejected a scheduled deployment', {
                entityId: entity.entityId,
                entityType: entity.entityType,
                error: error?.message
              })

              components.metrics.increment('entity_deployment_queue_failure', {
                entityType: entityTypeLabel
              })
            })
        } catch (error: any) {
          components.metrics.decrement('download_queue_size')
          throw error
        }
      } catch (error: any) {
        logger.error('Failed to schedule entity deployment', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          error: error?.message,
          stack: error?.stack
        })

        // Scheduling failed, so the entity was never marked deployed and will be re-streamed.
        components.metrics.increment('entity_deployment_failure', {
          entityType: entityTypeLabel,
          retryable: 'true'
        })
      }
    },
    // The drain signal, not a formality: snapshots-fetcher awaits this before it advances a
    // server's pointer-changes timestamp, before it commits bootstrap marks, and inside stop().
    // scheduleEntityDeployment returns as soon as the job is queued, so reporting idle while the
    // queue still holds work would let sync resume past entities that were only ever scheduled.
    async onIdle() {
      await components.downloadQueue.onIdle()
    },
    async prepareForDeploymentsIn(_timeRanges: TimeRange[]) {}
  }
}
