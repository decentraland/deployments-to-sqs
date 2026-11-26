/**
 * Whether a download/publish error should drop the entity for good (markAsDeployed).
 * A 4xx from the content server is permanent, except 429, which is a rate limit and clears on retry.
 *
 * @param message - The error message; snapshots-fetcher reports HTTP failures as `... status: NNN`.
 * @returns True for any 4xx other than 429.
 */
export function isNonRetryableErrorMessage(message: string | undefined): boolean {
  const match = /status: (4\d{2})\b/.exec(message ?? '')
  return match !== null && match[1] !== '429'
}
