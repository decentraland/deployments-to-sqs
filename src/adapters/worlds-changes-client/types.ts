import { IBaseComponent } from '@well-known-components/interfaces'

/** One row of a worlds change feed. `event` and `attributes` are untrusted and validated by the relay. */
export type WorldsChange = {
  /** Opaque, producer-ordered position of this row. */
  cursor: string
  /** The worlds-content-server SNS message body, as the producer emitted it. */
  event: unknown
  /** SNS message attributes the producer set besides `type`/`subType`. */
  attributes: unknown
}

/** One page of `GET <feed>?after=<cursor>&limit=<n>`. */
export type WorldsChangesPage = {
  changes: WorldsChange[]
  /** Cursor to request the next page with; `null` once the reader is caught up. */
  next: string | null
}

export type FetchChangesOptions = {
  /** Exclusive lower bound; omitted to read from the oldest retained row. */
  after?: string
  limit: number
  /** Aborts the in-flight request (e.g. on shutdown). */
  signal?: AbortSignal
}

export interface IWorldsChangesClientComponent extends IBaseComponent {
  /**
   * Fetches one page of a worlds change feed.
   *
   * @param feedUrl - Absolute HTTPS URL of the feed; its host must be on ALLOWED_CONTENT_SERVER_HOSTS.
   * @param options - Cursor, page size and abort signal.
   * @returns The validated page envelope. Each change's `event`/`attributes` are left unvalidated.
   * @throws WorldsChangesUrlNotAllowedError when the URL is not an allowlisted HTTPS URL.
   * @throws WorldsChangesRequestError on network failure, timeout or abort.
   * @throws WorldsChangesHttpError on a non-2xx response.
   * @throws WorldsChangesResponseTooLargeError when the body exceeds the configured bound.
   * @throws WorldsChangesInvalidResponseError when the body is not a valid page.
   */
  fetchChanges(feedUrl: string, options: FetchChangesOptions): Promise<WorldsChangesPage>
}
