import { isValidEntityId } from './validation'

/** Snapshot hashes are content hashes; the fetcher rejects longer ones, so a marker for them is never read. */
const MAX_SNAPSHOT_HASH_LENGTH = 128
const MAX_REPLACED_HASHES = 1000
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

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
  /** Entries the synchronizer would discard. */
  invalid: number
}

function isUsableTimestamp(value: unknown, latest: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= latest
}

// Match the fields snapshots-fetcher checks before it advances a server's pointer-change cursor.
function hasUsableSnapshotMetadata(entry: unknown, latest: number): entry is { hash: string } {
  if (!entry || typeof entry !== 'object' || !('hash' in entry) || !isValidSnapshotHash(entry.hash)) return false
  if (!('timeRange' in entry)) return false
  const range = entry.timeRange
  if (!range || typeof range !== 'object' || !('initTimestamp' in range) || !('endTimestamp' in range)) return false
  const { initTimestamp, endTimestamp } = range
  if (
    !isUsableTimestamp(initTimestamp, latest) ||
    !isUsableTimestamp(endTimestamp, latest) ||
    initTimestamp > endTimestamp
  ) {
    return false
  }
  if (!('replacedSnapshotHashes' in entry) || entry.replacedSnapshotHashes === undefined) return true
  const hashes = entry.replacedSnapshotHashes
  return Array.isArray(hashes) && hashes.length <= MAX_REPLACED_HASHES && hashes.every(isValidSnapshotHash)
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
  const latest = Date.now() + MAX_CLOCK_SKEW_MS
  for (const entry of body) {
    if (hasUsableSnapshotMetadata(entry, latest)) {
      hashes.add(entry.hash)
    } else {
      invalid++
    }
  }

  return { hashes: Array.from(hashes), invalid }
}
