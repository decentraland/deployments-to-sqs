import SQL from 'sql-template-strings'
import { AppComponents, ProcessedRegistryComponent } from '../../types'

/**
 * Records what has been processed, in Postgres.
 *
 * Replaces the previous scheme where an object's presence in the bucket meant "done". That
 * conflated "downloaded" with "published", so a failed SNS publish left the entity looking
 * processed and it was never retried.
 */
export function createProcessedRegistryComponent(
  components: Pick<AppComponents, 'pg' | 'storage' | 'logs'>
): ProcessedRegistryComponent {
  const { pg, storage } = components
  const logger = components.logs.getLogger('ProcessedRegistry')

  const snapshotKey = (hash: string) => `stored-snapshot-${hash}`

  return {
    async wasEntityPublished(entityId: string): Promise<boolean> {
      const result = await pg.query<{ published_at: Date | null }>(
        SQL`SELECT published_at FROM processed_entities WHERE entity_id = ${entityId}`
      )

      // A row is claimed before the download, so its absence means this entity predates the table.
      // Those live only in the bucket, and treating them as unprocessed would replay every
      // deployment since 2022. Removed in the PR that stops writing objects.
      if (result.rowCount === 0) {
        return storage.exist(entityId)
      }

      return result.rows[0].published_at !== null
    },

    async claimEntity(entity): Promise<void> {
      await pg.query(
        SQL`INSERT INTO processed_entities (entity_id, entity_type, entity_timestamp)
            VALUES (${entity.entityId}, ${entity.entityType}, ${entity.entityTimestamp})
            ON CONFLICT (entity_id) DO NOTHING`
      )
    },

    async markEntityPublished(entityId: string): Promise<void> {
      await pg.query(
        SQL`UPDATE processed_entities SET published_at = now()
            WHERE entity_id = ${entityId} AND published_at IS NULL`
      )
    },

    async wasSnapshotProcessed(snapshotHash: string): Promise<boolean> {
      const result = await pg.query(SQL`SELECT 1 FROM processed_snapshots WHERE snapshot_hash = ${snapshotHash}`)

      return result.rowCount > 0 ? true : storage.exist(snapshotKey(snapshotHash))
    },

    async markSnapshotProcessed(snapshotHash: string): Promise<void> {
      await pg.query(
        SQL`INSERT INTO processed_snapshots (snapshot_hash) VALUES (${snapshotHash})
            ON CONFLICT (snapshot_hash) DO NOTHING`
      )
    },

    async filterProcessedSnapshots(snapshotHashes: string[]): Promise<Set<string>> {
      if (snapshotHashes.length === 0) {
        return new Set()
      }

      // One round trip for what used to be one S3 HEAD per hash, in sequence, for chunks of up to
      // 1000. Hashes with no row still need the bucket check for the same pre-table reason as
      // entities, but only those.
      const result = await pg.query<{ snapshot_hash: string }>(
        SQL`SELECT snapshot_hash FROM processed_snapshots WHERE snapshot_hash = ANY(${snapshotHashes})`
      )

      const processed = new Set(result.rows.map((row) => row.snapshot_hash))
      const unknown = snapshotHashes.filter((hash) => !processed.has(hash))

      for (const hash of unknown) {
        if (await storage.exist(snapshotKey(hash))) {
          processed.add(hash)
        }
      }

      return processed
    },

    async countUnpublishedEntities(): Promise<number> {
      const result = await pg.query<{ count: string }>(
        SQL`SELECT count(*) AS count FROM processed_entities WHERE published_at IS NULL`
      )

      return Number(result.rows[0]?.count ?? 0)
    },

    async reportUnpublishedEntities(): Promise<void> {
      try {
        const stranded = await this.countUnpublishedEntities()
        logger.info('Entities claimed but not published', { stranded })
      } catch (error: any) {
        // Reporting only — never block startup on it.
        logger.warn('Could not count unpublished entities', { error: error?.message })
      }
    }
  }
}
