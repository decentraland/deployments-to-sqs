/**
 * Shared security validations for the deployments pipeline. Mirrors the guards
 * the asset-bundle-converter applies when it consumes our SQS messages
 * (asset-bundle-converter issue #306): a strict catalyst host allowlist for the
 * content-server URLs we sync from / publish, and a bare-CID check on the
 * entityId before it is used as a storage key. Validating here too means a
 * misconfigured content server fails fast at startup and a malformed entityId
 * is dropped before it can reach the storage layer.
 */

/**
 * Normalize one allowlist entry to a bare lowercase hostname. Accepts a bare
 * host or a full URL (`https://peer…/content`) — the latter is tolerated because
 * CONTENT_SERVER_URLS is itself a list of full URLs. Returns undefined for
 * blank/unparseable entries so the caller can drop them.
 */
function normalizeContentServerHost(entry: string): string | undefined {
  const trimmed = entry.trim().toLowerCase()
  if (trimmed.length === 0) return undefined
  if (trimmed.includes('/')) {
    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
      const host = new URL(withScheme).hostname.replace(/^\[|\]$/g, '').toLowerCase()
      return host.length > 0 ? host : undefined
    } catch {
      return undefined
    }
  }
  return trimmed
}

/**
 * Parse the `ALLOWED_CONTENT_SERVER_HOSTS` env var (a comma-separated list of catalyst
 * hosts) into a Set of normalized hostnames. There is no built-in fallback list:
 * the allowlist is sourced entirely from config (set per-environment in the
 * `definitions` repo); the caller requires the var and rejects an empty result.
 */
export function parseAllowedContentServerHosts(raw: string | undefined): Set<string> {
  const hosts = (raw ?? '')
    .split(',')
    .map(normalizeContentServerHost)
    .filter((h): h is string => h !== undefined)
  return new Set(hosts)
}

/**
 * True when `raw` is an HTTPS URL whose host is exactly on the allowlist. An
 * exact host match (not a suffix) is intentional — it's the whole point of an
 * allowlist and the catalyst hosts are a known finite set.
 */
export function isAllowedContentServerUrl(raw: string, allowedHosts: Set<string>): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return allowedHosts.has(host)
}

/**
 * A real entity id is a bare CID (`[a-zA-Z0-9]`). Anything with separators or
 * `..` is rejected so it can't be interpolated into a filesystem path or an S3
 * key (path traversal / key injection).
 */
export function isValidEntityId(entityId: unknown): entityId is string {
  return typeof entityId === 'string' && /^[a-zA-Z0-9]+$/.test(entityId)
}
