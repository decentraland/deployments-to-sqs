import { IBaseComponent } from '@well-known-components/interfaces'

/** A configured worlds change feed. */
export type WorldsChangesFeed = {
  /** Full URL of the `/changes` route, without query. */
  url: string
  /** Host of `url`; also names the cursor object in the bucket. */
  host: string
  /** Public worlds base sent as the `sourceContentServerUrl` message attribute. */
  sourceContentServerUrl: string
  /** Bearer token for the feed, if it is gated. Never logged. */
  token?: string
}

/** Why a change was skipped instead of relayed. Bounded set; used as a metric label. */
export type WorldsChangeDropReason =
  | 'invalid_event'
  | 'unknown_type'
  | 'invalid_attributes'
  | 'disallowed_content_server'
  | 'too_large'

/**
 * Relays a dcl-one worlds change feed to EVENTS_SNS_ARN. Started and stopped by the lifecycle; it
 * exposes no methods and does nothing when WORLDS_CHANGES_URLS is unset.
 */
export type IWorldsChangeRelayComponent = IBaseComponent
