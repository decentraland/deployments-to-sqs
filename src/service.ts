import { Lifecycle } from '@well-known-components/interfaces'
import { setupRouter } from './controllers/routes'
import { AppComponents, GlobalContext, TestComponents } from './types'
import { isAllowedContentServerUrl, parseAllowedContentServerHosts } from './logic/validation'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  const globalContext: GlobalContext = {
    components
  }

  // wire the HTTP router (make it automatic? TBD)
  const router = await setupRouter(globalContext)
  // register routes middleware
  components.server.use(router.middleware())
  // register not implemented/method not allowed/cors responses middleware
  components.server.use(router.allowedMethods())
  // set the context to be passed to the handlers
  components.server.setContext(globalContext)

  const contentServerUrls = await components.config.requireString('CONTENT_SERVER_URLS')
  const servers = contentServerUrls
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0)

  // Fail fast on a misconfigured content server: we only ever sync from — and
  // publish messages pointing at — allowlisted catalyst hosts. This keeps the
  // downstream asset-bundle-converter's SSRF allowlist (issue #306) and ours in
  // agreement, and surfaces a typo'd/rogue CONTENT_SERVER_URLS at boot instead
  // of silently syncing from an unexpected host. The allowlist is sourced
  // entirely from ALLOWED_CONTENT_SERVER_HOSTS (set per-env in the definitions repo).
  const allowedContentServerHosts = parseAllowedContentServerHosts(
    await components.config.requireString('ALLOWED_CONTENT_SERVER_HOSTS')
  )
  if (allowedContentServerHosts.size === 0) {
    throw new Error('ALLOWED_CONTENT_SERVER_HOSTS is set but contains no valid catalyst hosts')
  }
  const disallowed = servers.filter((url) => !isAllowedContentServerUrl(url, allowedContentServerHosts))
  if (disallowed.length > 0) {
    throw new Error(
      `CONTENT_SERVER_URLS contains hosts that are not on the catalyst allowlist: ${disallowed.join(', ')}. ` +
        `Add them to ALLOWED_CONTENT_SERVER_HOSTS or remove them from CONTENT_SERVER_URLS.`
    )
  }

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  await components.synchronizer.syncWithServers(new Set(servers))
}
