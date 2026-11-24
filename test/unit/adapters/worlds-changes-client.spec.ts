import { IFetchComponent } from '@dcl/core-commons'
import { IConfigComponent } from '@well-known-components/interfaces'
import {
  createWorldsChangesClientComponent,
  IWorldsChangesClientComponent,
  WorldsChangesHttpError,
  WorldsChangesInvalidResponseError,
  WorldsChangesPage,
  WorldsChangesRequestError,
  WorldsChangesResponseTooLargeError,
  WorldsChangesUrlNotAllowedError
} from '../../../src/adapters/worlds-changes-client'

const FEED_URL = 'https://worlds-content-server.dcl.dev/changes'

function createConfig(values: Record<string, string>): jest.Mocked<IConfigComponent> {
  return {
    getString: jest.fn().mockImplementation(async (key: string) => values[key]),
    getNumber: jest.fn(),
    requireString: jest.fn().mockImplementation(async (key: string) => {
      if (values[key] === undefined) throw new Error(`missing ${key}`)
      return values[key]
    }),
    requireNumber: jest.fn()
  }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init })
}

describe('when fetching a page of worlds changes', () => {
  let fetch: jest.Mocked<IFetchComponent>
  let config: jest.Mocked<IConfigComponent>
  let client: IWorldsChangesClientComponent

  beforeEach(async () => {
    fetch = { fetch: jest.fn() }
    config = createConfig({
      ALLOWED_CONTENT_SERVER_HOSTS: 'worlds-content-server.dcl.dev',
      WORLDS_CHANGES_MAX_RESPONSE_BYTES: '1024'
    })
    client = await createWorldsChangesClientComponent({ config, fetch })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and the feed host is not allowlisted', () => {
    let url: string

    beforeEach(() => {
      url = 'https://evil.example.com/changes'
    })

    it('should reject with a WorldsChangesUrlNotAllowedError', async () => {
      await expect(client.fetchChanges(url, { limit: 10 })).rejects.toBeInstanceOf(WorldsChangesUrlNotAllowedError)
    })

    it('should not issue a request', async () => {
      await client.fetchChanges(url, { limit: 10 }).catch(() => undefined)
      expect(fetch.fetch).not.toHaveBeenCalled()
    })
  })

  describe('and the feed url is plain http', () => {
    let url: string

    beforeEach(() => {
      url = 'http://worlds-content-server.dcl.dev/changes'
    })

    it('should reject with a WorldsChangesUrlNotAllowedError', async () => {
      await expect(client.fetchChanges(url, { limit: 10 })).rejects.toBeInstanceOf(WorldsChangesUrlNotAllowedError)
    })
  })

  describe('and the feed answers a valid page', () => {
    let page: WorldsChangesPage

    beforeEach(() => {
      page = {
        changes: [
          {
            cursor: '10:1',
            event: { type: 'world', subType: 'world_undeployment', metadata: { worldName: 'a.dcl.eth' } },
            attributes: {}
          }
        ],
        next: '10:1'
      }
      fetch.fetch.mockResolvedValueOnce(jsonResponse(page))
    })

    it('should resolve to the page', async () => {
      await expect(client.fetchChanges(FEED_URL, { after: '9:4', limit: 10 })).resolves.toEqual(page)
    })

    it('should request the page after the cursor with the given limit', async () => {
      await client.fetchChanges(FEED_URL, { after: '9:4', limit: 10 })
      expect(fetch.fetch).toHaveBeenCalledWith(`${FEED_URL}?after=9%3A4&limit=10`, expect.anything())
    })

    it('should make a single attempt and refuse redirects', async () => {
      await client.fetchChanges(FEED_URL, { after: '9:4', limit: 10 })
      expect(fetch.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: 'error', attempts: 1, abortController: expect.any(AbortController) })
      )
    })
  })

  describe('and no cursor is given', () => {
    beforeEach(() => {
      fetch.fetch.mockResolvedValueOnce(jsonResponse({ changes: [], next: null }))
    })

    it('should request the page without an after parameter', async () => {
      await client.fetchChanges(FEED_URL, { limit: 10 })
      expect(fetch.fetch).toHaveBeenCalledWith(`${FEED_URL}?limit=10`, expect.anything())
    })
  })

  describe('and a token is given', () => {
    beforeEach(() => {
      fetch.fetch.mockResolvedValueOnce(jsonResponse({ changes: [], next: null }))
    })

    it('should send it as a bearer authorization header', async () => {
      await client.fetchChanges(FEED_URL, { limit: 10, token: 'feed-token-example' })
      expect(fetch.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer feed-token-example' })
        })
      )
    })
  })

  describe('and no token is given', () => {
    beforeEach(() => {
      fetch.fetch.mockResolvedValueOnce(jsonResponse({ changes: [], next: null }))
    })

    it('should send no authorization header', async () => {
      await client.fetchChanges(FEED_URL, { limit: 10 })
      expect(fetch.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: { accept: 'application/json' } })
      )
    })
  })

  describe('and the feed answers a non-2xx status', () => {
    beforeEach(() => {
      fetch.fetch.mockResolvedValueOnce(new Response('bad cursor', { status: 400 }))
    })

    it('should reject with a WorldsChangesHttpError carrying the status', async () => {
      await expect(client.fetchChanges(FEED_URL, { limit: 10 })).rejects.toMatchObject({
        name: WorldsChangesHttpError.name,
        status: 400
      })
    })
  })

  describe('and the request fails at the network level', () => {
    beforeEach(() => {
      fetch.fetch.mockRejectedValueOnce(new Error('ECONNRESET'))
    })

    it('should reject with a WorldsChangesRequestError', async () => {
      await expect(client.fetchChanges(FEED_URL, { limit: 10 })).rejects.toBeInstanceOf(WorldsChangesRequestError)
    })
  })

  describe('and the declared content length exceeds the bound', () => {
    beforeEach(() => {
      fetch.fetch.mockResolvedValueOnce(
        jsonResponse({ changes: [], next: null }, { headers: { 'content-length': '4096' } })
      )
    })

    it('should reject with a WorldsChangesResponseTooLargeError', async () => {
      await expect(client.fetchChanges(FEED_URL, { limit: 10 })).rejects.toBeInstanceOf(
        WorldsChangesResponseTooLargeError
      )
    })
  })

  describe('and the streamed body grows past the bound without a content length', () => {
    beforeEach(() => {
      const chunk = new TextEncoder().encode('x'.repeat(600))
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk)
        }
      })
      fetch.fetch.mockResolvedValueOnce(new Response(body, { status: 200 }))
    })

    it('should reject with a WorldsChangesResponseTooLargeError', async () => {
      await expect(client.fetchChanges(FEED_URL, { limit: 10 })).rejects.toBeInstanceOf(
        WorldsChangesResponseTooLargeError
      )
    })
  })

  describe('and the body is not JSON', () => {
    beforeEach(() => {
      fetch.fetch.mockResolvedValueOnce(new Response('<html>', { status: 200 }))
    })

    it('should reject with a WorldsChangesInvalidResponseError', async () => {
      await expect(client.fetchChanges(FEED_URL, { limit: 10 })).rejects.toBeInstanceOf(
        WorldsChangesInvalidResponseError
      )
    })
  })

  describe('and a change has no valid cursor', () => {
    beforeEach(() => {
      fetch.fetch.mockResolvedValueOnce(jsonResponse({ changes: [{ event: {}, attributes: {} }], next: null }))
    })

    it('should reject with a WorldsChangesInvalidResponseError', async () => {
      await expect(client.fetchChanges(FEED_URL, { limit: 10 })).rejects.toBeInstanceOf(
        WorldsChangesInvalidResponseError
      )
    })
  })

  describe('and next is neither null nor a cursor', () => {
    beforeEach(() => {
      fetch.fetch.mockResolvedValueOnce(jsonResponse({ changes: [], next: 42 }))
    })

    it('should reject with a WorldsChangesInvalidResponseError', async () => {
      await expect(client.fetchChanges(FEED_URL, { limit: 10 })).rejects.toBeInstanceOf(
        WorldsChangesInvalidResponseError
      )
    })
  })

  describe('and the caller aborts while the request is in flight', () => {
    let callerController: AbortController
    let requestController: AbortController | undefined

    beforeEach(() => {
      callerController = new AbortController()
      requestController = undefined
      fetch.fetch.mockImplementationOnce(async (_url, init) => {
        requestController = init?.abortController
        callerController.abort()
        throw new Error('Request aborted (timed out)')
      })
    })

    it('should abort the underlying request', async () => {
      await client.fetchChanges(FEED_URL, { limit: 10, signal: callerController.signal }).catch(() => undefined)
      expect(requestController?.signal.aborted).toBe(true)
    })
  })
})
