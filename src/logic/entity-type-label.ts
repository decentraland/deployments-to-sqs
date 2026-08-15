import { EntityType } from '@dcl/schemas/dist/platform/entity'

/** Bucket for any entity type outside the known set. */
export const OTHER_ENTITY_TYPE = 'other'

const KNOWN_ENTITY_TYPES: ReadonlySet<string> = new Set(Object.values(EntityType))

/**
 * Clamps an entity type for use as a Prometheus label. It is remote input that @dcl/schemas
 * validates only as `{ type: 'string' }`, and prom-client never evicts label sets. Sourced from
 * EntityType so new deployable types are reported by name after a dependency bump.
 */
export function toEntityTypeLabel(entityType: unknown): string {
  return typeof entityType === 'string' && KNOWN_ENTITY_TYPES.has(entityType) ? entityType : OTHER_ENTITY_TYPE
}
