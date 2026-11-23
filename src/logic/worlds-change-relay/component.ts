import { Readable } from 'stream'
import { streamToBuffer } from '@dcl/catalyst-storage'
import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { AppComponents } from '../../types'
import { getPositiveInt } from '../tuning'
import { isAllowedContentServerUrl, parseAllowedContentServerHosts } from '../validation'
import { isValidWorldsChangesCursor, WorldsChange } from '../../adapters/worlds-changes-client'
import { InvalidStoredCursorError, InvalidWorldsChangesConfigError } from './errors'
import { IWorldsChangeRelayComponent, WorldsChangeDropReason, WorldsChangesFeed } from './types'

const WORLD_EVENT_TYPE = 'world'

/**
 * The worlds-content-server events the relay forwards (`Events.SubType.Worlds` values). Pinned as
 * literals because the installed @dcl/schemas predates all but `deployment`.
 */
export const WORLD_EVENT_SUBTYPES: ReadonlySet<string> = new Set([
  'deployment',
  'world_scenes_undeployment',
  'world_undeployment',
  'world_settings_changed',
  'world_spawn_coordinate_set'
])

/** SNS rejects a publish whose body plus attributes exceed 256 KiB. */
const SNS_MAX_MESSAGE_BYTES = 262_144
/** SNS allows 10 attributes; three are ours (type, subType, sourceContentServerUrl). */
const MAX_FEED_ATTRIBUTES = 7
const MAX_ATTRIBUTE_VALUE_LENGTH = 1024
const ATTRIBUTE_NAME = /^(?!(?:aws|amazon)\.)[A-Za-z0-9_\-.]{1,256}$/i
const RESERVED_ATTRIBUTES = new Set(['type', 'subType', 'sourceContentServerUrl'])

type ValidatedChange =
  | { kind: 'publish'; subType: string; message: string; attributes: Record<string, string> }
  | { kind: 'drop'; reason: WorldsChangeDropReason }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cursorKey(host: string): string {
  return `worlds-changes-cursor-${host}`
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function assertPlainHttpsUrl(raw: string, allowedHosts: Set<string>, name: string): URL {
  if (!isAllowedContentServerUrl(raw, allowedHosts)) {
    throw new InvalidWorldsChangesConfigError(`${name} entry ${raw} is not an allowlisted HTTPS URL`)
  }
  const url = new URL(raw)
  if (url.search || url.hash || url.username || url.password) {
    throw new InvalidWorldsChangesConfigError(`${name} entry ${raw} must not carry a query, fragment or credentials`)
  }
  return url
}

/**
 * Parses the relay's feed configuration.
 *
 * `sourceContentServerUrl` defaults to the feed URL minus its trailing `/changes` (a feed at
 * `https://worlds-content-server.dcl.dev/changes` sources `https://worlds-content-server.dcl.dev`).
 * WORLDS_CHANGES_SOURCE_URLS overrides it positionally, for a feed served under a different base
 * (e.g. `https://dcl.dev/worlds-content-server/changes`).
 *
 * @param rawUrls - WORLDS_CHANGES_URLS.
 * @param rawSourceUrls - WORLDS_CHANGES_SOURCE_URLS.
 * @param rawTokens - WORLDS_CHANGES_TOKENS: one bearer token per feed, positional; an empty entry sends none.
 * @param allowedHosts - Parsed ALLOWED_CONTENT_SERVER_HOSTS.
 * @returns The feeds; empty when WORLDS_CHANGES_URLS is unset or blank.
 * @throws InvalidWorldsChangesConfigError on a non-allowlisted, malformed or duplicated entry.
 */
export function parseWorldsChangesFeeds(
  rawUrls: string | undefined,
  rawSourceUrls: string | undefined,
  allowedHosts: Set<string>,
  rawTokens?: string
): WorldsChangesFeed[] {
  const urls = parseList(rawUrls)
  const sourceUrls = parseList(rawSourceUrls)
  if (sourceUrls.length > 0 && sourceUrls.length !== urls.length) {
    throw new InvalidWorldsChangesConfigError('WORLDS_CHANGES_SOURCE_URLS must have one entry per WORLDS_CHANGES_URLS')
  }
  // Positional and empty entries kept, so "a,,b" gates feeds 1 and 3 only.
  const tokens = rawTokens && rawTokens.trim().length > 0 ? rawTokens.split(',').map((token) => token.trim()) : []
  if (tokens.length > 0 && tokens.length !== urls.length) {
    throw new InvalidWorldsChangesConfigError('WORLDS_CHANGES_TOKENS must have one entry per WORLDS_CHANGES_URLS')
  }
  // The value is never echoed: only its position.
  tokens.forEach((token, index) => {
    if (token.length > 0 && !/^[\x21-\x7e]+$/.test(token)) {
      throw new InvalidWorldsChangesConfigError(`WORLDS_CHANGES_TOKENS entry ${index + 1} has invalid characters`)
    }
  })

  const seenHosts = new Set<string>()
  return urls.map((raw, index) => {
    const url = assertPlainHttpsUrl(raw, allowedHosts, 'WORLDS_CHANGES_URLS')
    const path = url.pathname.replace(/\/+$/, '')
    if (!path.endsWith('/changes')) {
      throw new InvalidWorldsChangesConfigError(`WORLDS_CHANGES_URLS entry ${raw} must end with /changes`)
    }
    // The host names the cursor object, so two feeds on one host would share a cursor.
    if (seenHosts.has(url.hostname)) {
      throw new InvalidWorldsChangesConfigError(`WORLDS_CHANGES_URLS has more than one feed on ${url.hostname}`)
    }
    seenHosts.add(url.hostname)

    const source =
      sourceUrls.length > 0
        ? assertPlainHttpsUrl(sourceUrls[index], allowedHosts, 'WORLDS_CHANGES_SOURCE_URLS')
        : new URL(`${url.origin}${path.slice(0, -'/changes'.length)}`)

    return {
      url: `${url.origin}${path}`,
      host: url.hostname,
      sourceContentServerUrl: `${source.origin}${source.pathname.replace(/\/+$/, '')}`,
      ...(tokens[index] ? { token: tokens[index] } : {})
    }
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Creates the worlds change relay: one polling loop per WORLDS_CHANGES_URLS feed that forwards
 * worlds-content-server events, byte for byte, to EVENTS_SNS_ARN.
 *
 * Per feed:
 * 1. Load the cursor from `worlds-changes-cursor-<host>` in the bucket (absent = oldest retained row).
 * 2. Fetch a page after the cursor.
 * 3. For each change in order: validate it (known world type/subType, allowlisted
 *    `contentServerUrls`, attributes, SNS size bound) and publish it with attributes `type`,
 *    `subType`, the feed's attributes and `sourceContentServerUrl`; a change that fails validation
 *    is dropped and skipped. The in-memory cursor moves past a change only once it is published
 *    or dropped.
 * 4. Persist the cursor after the page, or when a publish fails (at-least-once delivery).
 * 5. Fetch again at once while the page made progress and `next` is set, else wait
 *    WORLDS_CHANGES_POLL_INTERVAL_MS; on any failure back off exponentially up to
 *    WORLDS_CHANGES_MAX_BACKOFF_MS and retry from the last cursor.
 *
 * @param components - Config, logs, metrics, bucket storage, the feed client and the events publisher.
 * @returns The relay; inert (nothing started) when WORLDS_CHANGES_URLS is unset or blank.
 * @throws InvalidWorldsChangesConfigError when a configured feed or source URL is invalid.
 */
export async function createWorldsChangeRelayComponent(
  components: Pick<
    AppComponents,
    'config' | 'logs' | 'metrics' | 'storage' | 'worldsChangesClient' | 'snsEventPublisher'
  >
): Promise<IWorldsChangeRelayComponent> {
  const { config, logs, metrics, storage, worldsChangesClient, snsEventPublisher } = components
  const logger = logs.getLogger('WorldsChangeRelay')

  const rawUrls = await config.getString('WORLDS_CHANGES_URLS')
  if (parseList(rawUrls).length === 0) {
    logger.info('WORLDS_CHANGES_URLS is unset; worlds change relay disabled')
    return {}
  }

  const allowedHosts = parseAllowedContentServerHosts(await config.requireString('ALLOWED_CONTENT_SERVER_HOSTS'))
  const feeds = parseWorldsChangesFeeds(
    rawUrls,
    await config.getString('WORLDS_CHANGES_SOURCE_URLS'),
    allowedHosts,
    await config.getString('WORLDS_CHANGES_TOKENS')
  )
  const pollIntervalMs = await getPositiveInt(config, 'WORLDS_CHANGES_POLL_INTERVAL_MS', 5_000)
  const maxBackoffMs = await getPositiveInt(config, 'WORLDS_CHANGES_MAX_BACKOFF_MS', 60_000)
  const pageLimit = await getPositiveInt(config, 'WORLDS_CHANGES_PAGE_LIMIT', 100)
  const maxMessageBytes = await getPositiveInt(config, 'WORLDS_CHANGES_MAX_MESSAGE_BYTES', SNS_MAX_MESSAGE_BYTES)
  if (maxMessageBytes > SNS_MAX_MESSAGE_BYTES) {
    throw new InvalidWorldsChangesConfigError(`WORLDS_CHANGES_MAX_MESSAGE_BYTES must be <= ${SNS_MAX_MESSAGE_BYTES}`)
  }

  let abortController: AbortController | undefined
  let loops: Promise<void>[] = []

  function validateChange(change: WorldsChange, feed: WorldsChangesFeed): ValidatedChange {
    const { event } = change
    if (!isPlainObject(event)) return { kind: 'drop', reason: 'invalid_event' }
    const { type, subType } = event
    if (type !== WORLD_EVENT_TYPE || typeof subType !== 'string' || !WORLD_EVENT_SUBTYPES.has(subType)) {
      return { kind: 'drop', reason: 'unknown_type' }
    }

    if (subType === 'deployment') {
      const urls = event.contentServerUrls
      if (!Array.isArray(urls) || urls.length === 0 || !urls.every((url) => typeof url === 'string')) {
        return { kind: 'drop', reason: 'invalid_event' }
      }
      if (!urls.every((url) => isAllowedContentServerUrl(url, allowedHosts))) {
        return { kind: 'drop', reason: 'disallowed_content_server' }
      }
      if (!urls.some((url) => url.replace(/\/+$/, '') === feed.sourceContentServerUrl)) {
        // Consumers fetch from the body's own URLs, so a mismatch only signals a misconfigured source.
        logger.warn('Deployment contentServerUrls do not include the feed source URL', {
          feed: feed.host,
          cursor: change.cursor,
          sourceContentServerUrl: feed.sourceContentServerUrl
        })
      }
    }

    const feedAttributes = change.attributes ?? {}
    if (!isPlainObject(feedAttributes)) return { kind: 'drop', reason: 'invalid_attributes' }
    const entries = Object.entries(feedAttributes).filter(([name]) => !RESERVED_ATTRIBUTES.has(name))
    if (entries.length > MAX_FEED_ATTRIBUTES) return { kind: 'drop', reason: 'invalid_attributes' }
    const attributes: Record<string, string> = {}
    for (const [name, value] of entries) {
      if (
        !ATTRIBUTE_NAME.test(name) ||
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_ATTRIBUTE_VALUE_LENGTH
      ) {
        return { kind: 'drop', reason: 'invalid_attributes' }
      }
      attributes[name] = value
    }
    // Ours last: the feed cannot override them.
    attributes.type = type
    attributes.subType = subType
    attributes.sourceContentServerUrl = feed.sourceContentServerUrl

    const message = JSON.stringify(event)
    const size =
      Buffer.byteLength(message) +
      Object.entries(attributes).reduce(
        (sum, [name, value]) => sum + Buffer.byteLength(name) + 'String'.length + Buffer.byteLength(value),
        0
      )
    if (size > maxMessageBytes) return { kind: 'drop', reason: 'too_large' }

    return { kind: 'publish', subType, message, attributes }
  }

  async function loadCursor(feed: WorldsChangesFeed): Promise<string | undefined> {
    const key = cursorKey(feed.host)
    const item = await storage.retrieve(key)
    if (!item) return undefined
    const value = (await streamToBuffer(await item.asStream())).toString('utf8').trim()
    if (!isValidWorldsChangesCursor(value)) {
      throw new InvalidStoredCursorError(key)
    }
    return value
  }

  async function saveCursor(feed: WorldsChangesFeed, cursor: string): Promise<void> {
    await storage.storeStream(cursorKey(feed.host), Readable.from([Buffer.from(cursor, 'utf8')]))
  }

  async function runFeed(feed: WorldsChangesFeed, signal: AbortSignal): Promise<void> {
    let failures = 0
    const backOff = async (operation: string, error: unknown): Promise<void> => {
      failures++
      const delay = Math.min(pollIntervalMs * 2 ** (failures - 1), maxBackoffMs)
      logger.error(`Worlds change relay ${operation} failed; retrying`, {
        feed: feed.host,
        retryInMs: delay,
        error: error instanceof Error ? error.message : String(error)
      })
      metrics.increment('worlds_changes_relay_failure', {
        feed: feed.host,
        operation,
        error: error instanceof Error ? error.name : 'unknown'
      })
      await sleep(delay, signal)
    }

    let cursor: string | undefined
    let persistedCursor: string | undefined
    for (;;) {
      if (signal.aborted) return
      try {
        cursor = await loadCursor(feed)
        persistedCursor = cursor
        failures = 0
        break
      } catch (error: unknown) {
        await backOff('load_cursor', error)
      }
    }
    logger.info('Worlds change relay started', { feed: feed.host, cursor: cursor ?? 'none' })

    const persist = async (): Promise<void> => {
      if (cursor !== undefined && cursor !== persistedCursor) {
        await saveCursor(feed, cursor)
        persistedCursor = cursor
      }
    }

    while (!signal.aborted) {
      let caughtUp = true
      const cursorBeforePage = cursor
      try {
        const page = await worldsChangesClient.fetchChanges(feed.url, {
          after: cursor,
          limit: pageLimit,
          signal,
          token: feed.token
        })
        try {
          for (const change of page.changes) {
            if (signal.aborted) break
            const validated = validateChange(change, feed)
            if (validated.kind === 'publish') {
              await snsEventPublisher.publishRawMessage(validated.message, validated.attributes)
              metrics.increment('worlds_changes_relayed', { feed: feed.host, subType: validated.subType })
            } else {
              logger.warn('Dropping worlds change', {
                feed: feed.host,
                cursor: change.cursor,
                reason: validated.reason
              })
              metrics.increment('worlds_changes_dropped', { feed: feed.host, reason: validated.reason })
            }
            cursor = change.cursor
          }
        } finally {
          // Persist whatever was published, also when a publish failed mid-page.
          await persist()
        }
        // A page that did not move the cursor waits too, so a stuck producer cannot hot-loop us.
        caughtUp = page.next === null || cursor === cursorBeforePage
        failures = 0
      } catch (error: unknown) {
        if (signal.aborted) break
        await backOff('poll', error)
        continue
      }
      if (caughtUp) await sleep(pollIntervalMs, signal)
    }
    logger.info('Worlds change relay stopped', { feed: feed.host, cursor: cursor ?? 'none' })
  }

  return {
    async [START_COMPONENT]() {
      const controller = new AbortController()
      abortController = controller
      loops = feeds.map((feed) =>
        // Long-running by design: start must not wait on it; stop awaits it.
        runFeed(feed, controller.signal).catch((error: unknown) => {
          logger.error('Worlds change relay loop crashed', {
            feed: feed.host,
            error: error instanceof Error ? error.message : String(error)
          })
        })
      )
    },
    async [STOP_COMPONENT]() {
      abortController?.abort()
      await Promise.allSettled(loops)
      loops = []
      abortController = undefined
    }
  }
}
