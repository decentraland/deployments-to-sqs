import { IFetchComponent } from '@well-known-components/http-server'
import { createFetchComponent as createCoreFetchComponent } from '@dcl/fetch-component'

export async function createFetchComponent(): Promise<IFetchComponent> {
  // `@dcl/fetch-component` is typed against the native (undici) fetch API, while
  // `@dcl/snapshots-fetcher` — the only consumer of this component — types its
  // `fetcher` against `node-fetch`'s `IFetchComponent`. The two Response types
  // differ structurally, but are compatible at runtime for the calls the
  // synchronizer actually makes through the fetcher: JSON polling
  // (`/pointer-changes`, snapshots), which only touches `.ok`/`.status`/`.json()`.
  // The content-file download path in snapshots-fetcher uses raw `http(s).get`
  // and does not go through this fetcher at all, so there is no stream-API
  // mismatch. The type bridge is contained to this single boundary.
  const fetch = createCoreFetchComponent()

  return fetch as unknown as IFetchComponent
}
