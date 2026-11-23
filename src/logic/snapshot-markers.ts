import { isValidEntityId } from './validation'

/** Snapshot hashes are content hashes; the fetcher rejects longer ones, so a marker for them is never read. */
const MAX_SNAPSHOT_HASH_LENGTH = 128

/**
 * Storage key of the marker that records a snapshot as processed. Shared by the synchronizer's
 * snapshot storage and the seeding script so both read and write the same keys.
 *
 * @param snapshotHash - The snapshot's content hash.
 * @returns The storage key, `stored-snapshot-<hash>`.
 */
export function snapshotMarkerKey(snapshotHash: string): string {
  return `stored-snapshot-${snapshotHash}`
}

/** Whether a snapshot hash is safe to use in a storage key and would be accepted by the fetcher. */
export function isValidSnapshotHash(hash: unknown): hash is string {
  return isValidEntityId(hash) && hash.length <= MAX_SNAPSHOT_HASH_LENGTH
}

export type ParsedSnapshotHashes = {
  /** Unique valid hashes, in response order. */
  hashes: string[]
  /** Entries without a valid `hash`. */
  invalid: number
}

/**
 * Extracts the snapshot hashes from a content server's `/snapshots` response.
 *
 * @param body - The parsed JSON body.
 * @returns The unique valid hashes and how many entries were rejected.
 * @throws Error when the body is not an array.
 */
export function parseSnapshotHashes(body: unknown): ParsedSnapshotHashes {
  if (!Array.isArray(body)) {
    throw new Error('Invalid /snapshots response: expected an array')
  }

  const hashes = new Set<string>()
  let invalid = 0
  for (const entry of body) {
    const hash: unknown = typeof entry === 'object' && entry !== null && 'hash' in entry ? entry.hash : undefined
    if (isValidSnapshotHash(hash)) {
      hashes.add(hash)
    } else {
      invalid++
    }
  }

  return { hashes: Array.from(hashes), invalid }
}
