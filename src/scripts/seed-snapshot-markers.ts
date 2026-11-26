/**
 * Operator script: marks every snapshot a content server lists as processed, so adding that server to
 * CONTENT_SERVER_URLS skips the one-time snapshot backfill. Pointer polling overlaps the newest
 * snapshot by 20 minutes; entities only in older history outside that window are never announced.
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
import { createConfigComponent, createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { ParsedSnapshotHashes, parseSnapshotHashes, snapshotMarkerKey } from '../logic/snapshot-markers'
import { isAllowedContentServerUrl, parseAllowedContentServerHosts } from '../logic/validation'

const SNAPSHOTS_TIMEOUT_MS = 30_000

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export class SnapshotsListingError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'SnapshotsListingError'
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

function isLocalHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
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
    throw new UsageError('Invalid content server URL')
  }
  if (url.protocol !== 'https:' && !isLocalHttp(url)) {
    throw new UsageError('The content server URL must be https (http only for localhost)')
  }
  if (url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new UsageError('Use a content server base URL without credentials, a query or a fragment')
  }

  return {
    contentServerUrl: url.toString().replace(/\/+$/, ''),
    bucket: values.bucket,
    folder: values.folder,
    apply: values.apply ?? false
  }
}

/**
 * Checks the source of hash-only markers. An S3 write requires HTTPS and an explicit allowlist.
 * Dry runs and folder rehearsals use the allowlist when supplied and permit local HTTP fixtures.
 *
 * @param contentServerUrl - The validated content server URL.
 * @param rawAllowedHosts - ALLOWED_CONTENT_SERVER_HOSTS from the environment, if set.
 * @param writingToBucket - Shared markers require an explicit allowlisted HTTPS source.
 * @throws UsageError when the source or its configuration does not meet the selected write policy.
 */
export function assertAllowedContentServer(
  contentServerUrl: string,
  rawAllowedHosts: string | undefined,
  writingToBucket = false
): void {
  if (!rawAllowedHosts?.trim()) {
    if (writingToBucket) throw new UsageError('Export ALLOWED_CONTENT_SERVER_HOSTS before using --bucket with --apply')
    return
  }
  const allowedHosts = parseAllowedContentServerHosts(rawAllowedHosts)
  const url = new URL(contentServerUrl)
  if (writingToBucket && url.protocol !== 'https:') throw new UsageError('S3 marker writes require an HTTPS source')
  // Loopback over http stays allowed for local rehearsals.
  if ((writingToBucket || !isLocalHttp(url)) && !isAllowedContentServerUrl(contentServerUrl, allowedHosts)) {
    throw new UsageError(`${url.hostname} is not in ALLOWED_CONTENT_SERVER_HOSTS`)
  }
}

/**
 * Explains why a listing must not be seeded as is.
 *
 * @param listing - The parsed `/snapshots` response.
 * @param apply - Whether the run would write.
 * @returns The problem, or undefined when the listing can be used.
 */
export function listingProblem(listing: ParsedSnapshotHashes, apply: boolean): string | undefined {
  if (listing.hashes.length === 0) {
    return 'The server listed no valid snapshots; adding it would replay its pointer changes from the start.'
  }
  if (apply && listing.invalid > 0) {
    return `The server listed ${listing.invalid} invalid snapshot entries; refusing to write an incomplete seed.`
  }
  return undefined
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
  // No redirects: one could leave the checked host or downgrade to http.
  const response = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(SNAPSHOTS_TIMEOUT_MS) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`GET ${url} failed with status: ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error: unknown) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw new SnapshotsListingError(`GET ${url} did not return JSON (${reason})`, error)
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
    ...(report.invalid > 0
      ? [`WARNING: ${report.invalid} invalid entries cannot be marked; the seed may be incomplete.`]
      : []),
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
    // The bucket comes from the CLI. Loaded AWS settings can also affect the SDK credential chain.
    const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
    return await createAwsS3BasedFileSystemContentStorage({ config, logs }, options.bucket)
  }
  if (!options.folder) {
    throw new UsageError('Pass exactly one of --bucket <name> or --folder <path>')
  }
  return await createFolderBasedFileSystemContentStorage({ fs: createFsComponent(), logs }, options.folder)
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const print = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  let options: SeedOptions
  try {
    options = parseSeedArgs(argv)
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write(
      'Usage: node dist/scripts/seed-snapshot-markers.js <content-server-url> (--bucket <name> | --folder <path>) [--apply]\n'
    )
    return 2
  }

  try {
    // The real environment only: .env.default would always set it.
    const env = createConfigComponent(process.env)
    assertAllowedContentServer(
      options.contentServerUrl,
      await env.getString('ALLOWED_CONTENT_SERVER_HOSTS'),
      Boolean(options.bucket && options.apply)
    )
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const listing = await fetchSnapshotHashes(fetch, options.contentServerUrl)
  const problem = listingProblem(listing, options.apply)
  if (problem) {
    process.stderr.write(`${problem}\n`)
    return 1
  }

  const { hashes, invalid } = listing
  const storage = await createStorage(options)
  try {
    await storage.start?.({ started: () => true, live: () => true, getComponents: () => ({}) })
    const result = await seedSnapshotMarkers(storage, hashes, options.apply)
    formatReport(options, { listed: hashes.length, invalid, ...result }).forEach(print)
    return result.unconfirmed.length > 0 ? 1 : 0
  } finally {
    try {
      await storage.stop?.()
    } catch (error: unknown) {
      // Never hide the run's own outcome or error.
      process.stderr.write(`Failed to stop the storage: ${error instanceof Error ? error.message : String(error)}\n`)
    }
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
