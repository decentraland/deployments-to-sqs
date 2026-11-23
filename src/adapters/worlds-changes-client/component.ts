import { AppComponents } from '../../types'
import { getPositiveInt } from '../../logic/tuning'
import { isAllowedContentServerUrl, parseAllowedContentServerHosts } from '../../logic/validation'
import {
  WorldsChangesHttpError,
  WorldsChangesInvalidResponseError,
  WorldsChangesRequestError,
  WorldsChangesResponseTooLargeError,
  WorldsChangesUrlNotAllowedError
} from './errors'
import { FetchChangesOptions, IWorldsChangesClientComponent, WorldsChange, WorldsChangesPage } from './types'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
// A page of 100 changes at the 256 KiB SNS ceiling each is 25 MiB.
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/**
 * True for a producer cursor this relay will send back and persist: 1-256 printable ASCII
 * characters. The cursor is otherwise opaque (`<txid>:<id>` today).
 *
 * @param value - Candidate cursor.
 * @returns Whether `value` is a usable cursor.
 */
export function isValidWorldsChangesCursor(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the body up to `maxBytes`, cancelling the stream as soon as it grows past the bound.
 */
async function readBoundedBody(response: Response, url: string, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new WorldsChangesResponseTooLargeError(url, maxBytes)
  }
  if (!response.body) {
    return ''
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new WorldsChangesResponseTooLargeError(url, maxBytes)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parsePage(url: string, text: string): WorldsChangesPage {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new WorldsChangesInvalidResponseError(url, 'body is not JSON')
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.changes)) {
    throw new WorldsChangesInvalidResponseError(url, 'missing changes array')
  }
  const rawNext = parsed.next
  if (rawNext !== null && !isValidWorldsChangesCursor(rawNext)) {
    throw new WorldsChangesInvalidResponseError(url, 'next is neither null nor a valid cursor')
  }
  const next = rawNext === null ? null : String(rawNext)

  const changes: WorldsChange[] = parsed.changes.map((change: unknown, index: number) => {
    // A row whose cursor is unusable cannot be skipped past, so it fails the whole page.
    if (!isPlainObject(change) || !isValidWorldsChangesCursor(change.cursor)) {
      throw new WorldsChangesInvalidResponseError(url, `change ${index} has no valid cursor`)
    }
    return { cursor: String(change.cursor), event: change.event, attributes: change.attributes }
  })

  return { changes, next }
}

/**
 * Creates the HTTP client for dcl-one worlds change feeds
 * (`GET <feed>?after=<cursor>&limit=<n>` → `{ changes, next }`).
 *
 * Every request is checked against ALLOWED_CONTENT_SERVER_HOSTS, refuses redirects (a redirect
 * could leave the allowlist), runs a single attempt under one deadline that covers headers and
 * body, and reads at most WORLDS_CHANGES_MAX_RESPONSE_BYTES.
 *
 * @param components - `config` for the allowlist and bounds, `fetch` for the request.
 * @returns The worlds changes client.
 * @throws Error when ALLOWED_CONTENT_SERVER_HOSTS is unset, or a bound is not a positive integer.
 */
export async function createWorldsChangesClientComponent(
  components: Pick<AppComponents, 'config' | 'fetch'>
): Promise<IWorldsChangesClientComponent> {
  const { config, fetch } = components

  const allowedHosts = parseAllowedContentServerHosts(await config.requireString('ALLOWED_CONTENT_SERVER_HOSTS'))
  const timeoutMs = await getPositiveInt(config, 'WORLDS_CHANGES_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS)
  const maxResponseBytes = await getPositiveInt(config, 'WORLDS_CHANGES_MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES)

  async function fetchChanges(feedUrl: string, options: FetchChangesOptions): Promise<WorldsChangesPage> {
    if (!isAllowedContentServerUrl(feedUrl, allowedHosts)) {
      throw new WorldsChangesUrlNotAllowedError(feedUrl)
    }

    const url = new URL(feedUrl)
    if (options.after !== undefined) {
      url.searchParams.set('after', options.after)
    }
    url.searchParams.set('limit', String(options.limit))

    // Our own controller, so the deadline and the caller's signal also cover the body read
    // (the fetch component's own timeout stops once headers arrive).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onCallerAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (options.signal?.aborted) controller.abort()

    try {
      let response: Response
      try {
        response = await fetch.fetch(url.toString(), {
          method: 'GET',
          redirect: 'error',
          attempts: 1,
          abortController: controller,
          headers: {
            accept: 'application/json',
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
          }
        })
      } catch (error: unknown) {
        throw new WorldsChangesRequestError(feedUrl, error instanceof Error ? error.message : String(error))
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new WorldsChangesHttpError(feedUrl, response.status)
      }

      let text: string
      try {
        text = await readBoundedBody(response, feedUrl, maxResponseBytes)
      } catch (error: unknown) {
        if (error instanceof WorldsChangesResponseTooLargeError) throw error
        throw new WorldsChangesRequestError(feedUrl, error instanceof Error ? error.message : String(error))
      }

      return parsePage(feedUrl, text)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  return { fetchChanges }
}
