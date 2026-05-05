import { CopyObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { Events } from '@dcl/schemas/dist/platform/events'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import { AppComponents, ManifestCopierComponent, RegistryEntity } from '../../types'

const PLATFORMS = ['windows', 'mac', 'webgl'] as const

type Manifest = {
  version: string
  files: string[]
  exitCode: number
  contentServerUrl?: string
  date: string
}

export async function createManifestCopierComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'fetch' | 'metrics'>
): Promise<ManifestCopierComponent> {
  const logger = components.logs.getLogger('ManifestCopier')

  const cdnBucket = await components.config.getString('ASSET_BUNDLE_CDN_BUCKET')
  const cdnUrl = ((await components.config.getString('ASSET_BUNDLE_CDN_URL')) || '').replace(/\/$/, '')
  const abVersion = await components.config.getString('ASSET_BUNDLE_VERSION')
  const snsEndpoint = await components.config.getString('SNS_ENDPOINT')
  const eventsArn = await components.config.getString('EVENTS_SNS_ARN')

  const s3 = cdnBucket ? new S3Client({}) : null
  const sns = eventsArn
    ? new SNSClient({
        endpoint: snsEndpoint ? snsEndpoint : undefined
      })
    : null

  return {
    async copyAndNotify(entity: DeployableEntity, registryEntity: RegistryEntity): Promise<void> {
      if (!s3 || !cdnBucket || !cdnUrl || !abVersion || !sns || !eventsArn) {
        throw new Error(
          'ManifestCopier not configured: missing ASSET_BUNDLE_CDN_BUCKET, CDN_URL, VERSION, or EVENTS_SNS_ARN'
        )
      }

      const oldEntityId = registryEntity.id
      const newEntityId = entity.entityId

      for (const platform of PLATFORMS) {
        const oldManifest = await fetchManifest(oldEntityId, platform)
        if (!oldManifest) {
          throw new Error(`Could not fetch manifest for ${oldEntityId} platform ${platform}`)
        }

        // Copy converted files from old entity path to new entity path
        const version = oldManifest.version
        for (const file of oldManifest.files) {
          const sourceKey = `${version}/${oldEntityId}/${file}`
          const destKey = `${version}/${newEntityId}/${file}`

          logger.debug('Copying S3 object', { sourceKey, destKey })

          await s3.send(
            new CopyObjectCommand({
              Bucket: cdnBucket,
              CopySource: `${cdnBucket}/${sourceKey}`,
              Key: destKey
            })
          )
        }

        // Upload new manifest for the new entity ID
        const newManifest: Manifest = {
          version: oldManifest.version,
          files: oldManifest.files,
          exitCode: 0,
          contentServerUrl: oldManifest.contentServerUrl,
          date: new Date().toISOString()
        }

        const manifestKey =
          platform !== 'webgl' ? `manifest/${newEntityId}_${platform}.json` : `manifest/${newEntityId}.json`

        logger.debug('Uploading manifest', { manifestKey })

        await s3.send(
          new PutObjectCommand({
            Bucket: cdnBucket,
            Key: manifestKey,
            Body: JSON.stringify(newManifest),
            ContentType: 'application/json',
            CacheControl: 'private, max-age=0, no-cache'
          })
        )

        // Publish AssetBundleConversionFinishedEvent
        const event = {
          type: Events.Type.ASSET_BUNDLE,
          subType: Events.SubType.AssetBundle.CONVERTED,
          key: newEntityId,
          timestamp: Date.now(),
          metadata: {
            entityId: newEntityId,
            platform,
            statusCode: 0,
            isLods: false,
            isWorld: false,
            version: abVersion
          }
        }

        await sns.send(
          new PublishCommand({
            TopicArn: eventsArn,
            Message: JSON.stringify(event)
          })
        )

        logger.info('Published conversion event', { entityId: newEntityId, platform })
      }

      logger.info('Manifest copy completed', {
        oldEntityId,
        newEntityId,
        platforms: PLATFORMS.join(',')
      })
    }
  }

  async function fetchManifest(entityId: string, platform: string): Promise<Manifest | null> {
    const manifestName = platform !== 'webgl' ? `${entityId}_${platform}` : entityId
    const manifestUrl = `${cdnUrl}/manifest/${manifestName}.json`

    const response = await components.fetch.fetch(manifestUrl)
    if (!response.ok) {
      logger.warn('Failed to fetch manifest', { entityId, platform, status: response.status })
      return null
    }

    return response.json()
  }
}
