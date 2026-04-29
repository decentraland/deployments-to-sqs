import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import { AppComponents, ContentChangeCheckerComponent, ContentChangeResult, RegistryEntity } from '../../types'

const PLATFORMS = ['windows', 'mac', 'webgl'] as const

export async function createContentChangeCheckerComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'fetch' | 'metrics'>
): Promise<ContentChangeCheckerComponent> {
  const logger = components.logs.getLogger('ContentChangeChecker')

  const registryUrl = (
    (await components.config.getString('ASSET_BUNDLE_REGISTRY_URL')) ||
    'https://asset-bundle-registry.decentraland.zone'
  ).replace(/\/$/, '')

  const abVersion = await components.config.getString('ASSET_BUNDLE_VERSION')

  if (!abVersion) {
    logger.info('Content change checker disabled (ASSET_BUNDLE_VERSION not configured)')
  }

  return {
    async check(entity: DeployableEntity, contentServerUrls: string[]): Promise<ContentChangeResult> {
      if (!abVersion) {
        return { changed: true }
      }

      if (entity.entityType !== 'scene') {
        return { changed: true }
      }

      try {
        // 1. Query registry for active entity at these pointers
        const registryEntity = await fetchRegistryEntity(entity.pointers)
        if (!registryEntity) {
          logger.debug('No active entity in registry', { entityId: entity.entityId })
          return { changed: true }
        }

        // 2. Check AB version - if any platform has a different version, reconvert
        for (const platform of PLATFORMS) {
          const platformVersion = registryEntity.versions.assets[platform]?.version
          if (platformVersion !== abVersion) {
            logger.info('AB version mismatch, reconverting', {
              entityId: entity.entityId,
              platform,
              registryVersion: platformVersion,
              expectedVersion: abVersion
            })
            return { changed: true }
          }
        }

        // 3. Fetch new entity data from Catalyst to get content hashes
        const newEntityContent = await fetchEntityContent(entity.entityId, contentServerUrls)
        if (!newEntityContent) {
          logger.warn('Could not fetch entity content from Catalyst', { entityId: entity.entityId })
          return { changed: true }
        }

        // 4. Compare content hashes
        if (contentHashesMatch(newEntityContent, registryEntity.content)) {
          logger.info('Content unchanged', {
            entityId: entity.entityId,
            registryEntityId: registryEntity.id
          })
          return { changed: false, registryEntity }
        }

        logger.debug('Content changed', { entityId: entity.entityId })
        return { changed: true }
      } catch (error: any) {
        logger.warn('Content change check failed, proceeding with deployment', {
          entityId: entity.entityId,
          error: error?.message
        })
        return { changed: true }
      }
    }
  }

  async function fetchRegistryEntity(pointers: string[]): Promise<RegistryEntity | null> {
    const response = await components.fetch.fetch(`${registryUrl}/entities/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointers })
    })

    if (!response.ok) {
      throw new Error(`Registry returned status ${response.status}`)
    }

    const entities: RegistryEntity[] = await response.json()
    return entities.length > 0 ? entities[0] : null
  }

  async function fetchEntityContent(
    entityId: string,
    servers: string[]
  ): Promise<{ file: string; hash: string }[] | null> {
    for (const server of servers) {
      try {
        const url = `${server.replace(/\/$/, '')}/content/entities/${entityId}`
        const response = await components.fetch.fetch(url)
        if (response.ok) {
          const entity = await response.json()
          return entity.content || null
        }
      } catch {
        // Try next server
      }
    }
    return null
  }
}

function contentHashesMatch(
  newContent: { file: string; hash: string }[],
  registryContent: { file: string; hash: string }[]
): boolean {
  if (newContent.length !== registryContent.length) return false

  const newHashes = new Set(newContent.map((c) => c.hash))
  const registryHashes = new Set(registryContent.map((c) => c.hash))

  if (newHashes.size !== registryHashes.size) return false

  for (const hash of newHashes) {
    if (!registryHashes.has(hash)) return false
  }

  return true
}
