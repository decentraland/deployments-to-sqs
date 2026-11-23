/**
 * Operator script: marks every snapshot a content server lists as processed, so adding that server to
 * CONTENT_SERVER_URLS skips the one-time snapshot backfill. Pointer changes then start after the
 * newest snapshot; entities only in older snapshots are never announced.
 *
 * Dry run by default; writes only with --apply.
 *
 *   node dist/scripts/seed-snapshot-markers.js <content-server-url> (--bucket <name> | --folder <path>) [--apply]
 */
import { parseArgs } from 'node:util'
import { Readable } from 'stream'
import {
  createAwsS3BasedFileSystemContentStorage,
  createFolderBasedFileSystemContentStorage,
  createFsComponent,
  IContentStorageComponent
} from '@dcl/catalyst-storage'
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { parseSnapshotHashes, snapshotMarkerKey } from '../logic/snapshot-markers'

const SNAPSHOTS_TIMEOUT_MS = 30_000

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export type SeedOptions = {
  contentServerUrl: string
  bucket?: string
  folder?: string
  apply: boolean
}

export type SeedReport = {
  listed: number
  invalid: number
  existing: string[]
  missing: string[]
  written: string[]
  /** Markers still absent after writing (only with --apply). */
  unconfirmed: string[]
}

const ARG_OPTIONS = {
  bucket: { type: 'string' },
  folder: { type: 'string' },
  apply: { type: 'boolean' }
} as const

function readArgs(argv: string[]) {
  return parseArgs({ args: argv, options: ARG_OPTIONS, allowPositionals: true })
}

/**
 * Parses and validates the command line.
 *
 * @param argv - Arguments after the script path.
 * @returns The validated options.
 * @throws UsageError on a missing or malformed argument.
 */
export function parseSeedArgs(argv: string[]): SeedOptions {
  let parsed: ReturnType<typeof readArgs>
  try {
    parsed = readArgs(argv)
  } catch (error: unknown) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }

  const { values, positionals } = parsed
  if (positionals.length !== 1) {
    throw new UsageError('Expected exactly one content server URL')
  }
  if (!values.bucket === !values.folder) {
    throw new UsageError('Pass exactly one of --bucket <name> or --folder <path>')
  }

  let url: URL
  try {
    url = new URL(positionals[0])
  } catch {
    throw new UsageError(`Invalid content server URL: ${positionals[0]}`)
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new UsageError('The content server URL must be https (http only for localhost)')
  }

  return {
    contentServerUrl: url.toString().replace(/\/+$/, ''),
    bucket: values.bucket,
    folder: values.folder,
    apply: values.apply ?? false
  }
}

/**
 * Fetches `<contentServerUrl>/snapshots` and extracts the valid snapshot hashes.
 *
 * @param fetchFn - The fetch implementation.
 * @param contentServerUrl - Base content server URL, without a trailing slash.
 * @returns The unique valid hashes and the number of rejected entries.
 * @throws Error on a network error, a non-2xx response, a timeout or an invalid body.
 */
export async function fetchSnapshotHashes(
  fetchFn: typeof fetch,
  contentServerUrl: string
): Promise<ReturnType<typeof parseSnapshotHashes>> {
  const url = `${contentServerUrl}/snapshots`
  const response = await fetchFn(url, { signal: AbortSignal.timeout(SNAPSHOTS_TIMEOUT_MS) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`GET ${url} failed with status: ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`GET ${url} did not return JSON`)
  }
  return parseSnapshotHashes(body)
}

/**
 * Reports which markers exist and, with `apply`, writes the missing ones and re-checks them.
 *
 * @param storage - The storage the service reads markers from.
 * @param hashes - Snapshot hashes to mark.
 * @param apply - Whether to write.
 * @returns What exists, what is missing, what was written and what could not be confirmed.
 */
export async function seedSnapshotMarkers(
  storage: Pick<IContentStorageComponent, 'exist' | 'storeStream'>,
  hashes: string[],
  apply: boolean
): Promise<Omit<SeedReport, 'listed' | 'invalid'>> {
  const existing: string[] = []
  const missing: string[] = []
  for (const hash of hashes) {
    if (await storage.exist(snapshotMarkerKey(hash))) {
      existing.push(hash)
    } else {
      missing.push(hash)
    }
  }

  const written: string[] = []
  const unconfirmed: string[] = []
  if (apply) {
    for (const hash of missing) {
      // Same body as the service's markSnapshotAsProcessed: an empty object.
      await storage.storeStream(snapshotMarkerKey(hash), Readable.from([]))
      written.push(hash)
    }
    for (const hash of written) {
      if (!(await storage.exist(snapshotMarkerKey(hash)))) {
        unconfirmed.push(hash)
      }
    }
  }

  return { existing, missing, written, unconfirmed }
}

/**
 * Formats the report for the operator.
 *
 * @param options - The run's options.
 * @param report - The outcome.
 * @returns Lines to print.
 */
export function formatReport(options: SeedOptions, report: SeedReport): string[] {
  const target = options.bucket ? `bucket ${options.bucket}` : `folder ${options.folder}`
  const lines = [
    `Content server: ${options.contentServerUrl}`,
    `Target: ${target}`,
    `Snapshots listed: ${report.listed} valid, ${report.invalid} invalid (skipped)`,
    `Markers already present: ${report.existing.length}`,
    ...report.existing.map((hash) => `  exists  ${snapshotMarkerKey(hash)}`)
  ]

  if (options.apply) {
    lines.push(
      `Markers written: ${report.written.length}`,
      ...report.written.map((h) => `  wrote   ${snapshotMarkerKey(h)}`)
    )
    if (report.unconfirmed.length > 0) {
      lines.push(
        `Markers NOT confirmed after writing: ${report.unconfirmed.length}`,
        ...report.unconfirmed.map((h) => `  missing ${snapshotMarkerKey(h)}`)
      )
    } else {
      lines.push('All listed snapshots are marked as processed.')
    }
  } else {
    lines.push(
      `Markers that would be written: ${report.missing.length}`,
      ...report.missing.map((h) => `  would write ${snapshotMarkerKey(h)}`),
      'Dry run: nothing was written. Re-run with --apply to write.'
    )
  }
  return lines
}

async function createStorage(options: SeedOptions): Promise<IContentStorageComponent> {
  const logs = await createLogComponent({})
  if (options.bucket) {
    // Only AWS_REGION is read from config; the bucket is always the one passed explicitly, never BUCKET.
    const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
    return await createAwsS3BasedFileSystemContentStorage({ config, logs }, options.bucket)
  }
  if (!options.folder) {
    throw new UsageError('Pass exactly one of --bucket <name> or --folder <path>')
  }
  return await createFolderBasedFileSystemContentStorage({ fs: createFsComponent(), logs }, options.folder)
}

async function main(): Promise<number> {
  const print = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  let options: SeedOptions
  try {
    options = parseSeedArgs(process.argv.slice(2))
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write(
      'Usage: node dist/scripts/seed-snapshot-markers.js <content-server-url> (--bucket <name> | --folder <path>) [--apply]\n'
    )
    return 2
  }

  const { hashes, invalid } = await fetchSnapshotHashes(fetch, options.contentServerUrl)
  const storage = await createStorage(options)
  try {
    await storage.start?.({ started: () => true, live: () => true, getComponents: () => ({}) })
    const result = await seedSnapshotMarkers(storage, hashes, options.apply)
    formatReport(options, { listed: hashes.length, invalid, ...result }).forEach(print)
    return result.unconfirmed.length > 0 ? 1 : 0
  } finally {
    await storage.stop?.()
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
