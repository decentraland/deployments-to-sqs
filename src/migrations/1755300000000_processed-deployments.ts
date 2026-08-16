/* eslint-disable @typescript-eslint/naming-convention */
import { PgType } from 'node-pg-migrate'
import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate'

export const shorthands: ColumnDefinitions | undefined = undefined

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Replaces "an object exists in the bucket" as the record of what has been processed. A row is
  // claimed before the download and stamped with published_at only after both SNS publishes
  // succeed, so a publish failure stays retryable instead of being read as done.
  pgm.createTable('processed_entities', {
    entity_id: { type: PgType.TEXT, primaryKey: true },
    entity_type: { type: PgType.TEXT, notNull: true },
    entity_timestamp: { type: PgType.BIGINT, notNull: true },
    published_at: { type: PgType.TIMESTAMP_WITH_TIME_ZONE },
    created_at: { type: PgType.TIMESTAMP_WITH_TIME_ZONE, notNull: true, default: pgm.func('now()') }
  })

  // Finds entities claimed but never published — the set the pre-fix bug stranded. Partial so it
  // stays small: rows are only in it while unpublished, which is normally near-zero.
  pgm.createIndex('processed_entities', 'created_at', {
    name: 'processed_entities_unpublished_idx',
    where: 'published_at IS NULL'
  })

  // Replaces the zero-byte `stored-snapshot-<hash>` objects.
  pgm.createTable('processed_snapshots', {
    snapshot_hash: { type: PgType.TEXT, primaryKey: true },
    created_at: { type: PgType.TIMESTAMP_WITH_TIME_ZONE, notNull: true, default: pgm.func('now()') }
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('processed_snapshots')
  pgm.dropTable('processed_entities')
}
