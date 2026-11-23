import { Readable } from 'stream'
import { createInMemoryStorage, IContentStorageComponent, streamToBuffer } from '@dcl/catalyst-storage'
import { IConfigComponent, START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import {
  FetchChangesOptions,
  IWorldsChangesClientComponent,
  WorldsChangesPage
} from '../../../src/adapters/worlds-changes-client'
import {
  createWorldsChangeRelayComponent,
  InvalidWorldsChangesConfigError,
  IWorldsChangeRelayComponent,
  parseWorldsChangesFeeds
} from '../../../src/logic/worlds-change-relay'
import { SnsPublisherComponent } from '../../../src/types'
import { logsMock, metricsMock } from '../../mocks/components'

const HOST = 'worlds-content-server.dcl.dev'
const FEED_URL = `https://${HOST}/changes`
const SOURCE_URL = `https://${HOST}`
const CURSOR_KEY = `worlds-changes-cursor-${HOST}`

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

/** Never resolves until the relay aborts the request (i.e. on stop). */
function blockUntilAborted(_url: string, options: FetchChangesOptions): Promise<WorldsChangesPage> {
  return new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!condition()) throw new Error('condition not met')
}

async function readCursor(storage: IContentStorageComponent): Promise<string | undefined> {
  const item = await storage.retrieve(CURSOR_KEY)
  return item ? (await streamToBuffer(await item.asStream())).toString('utf8') : undefined
}

function deploymentEvent(entityId: string, contentServerUrls: string[] = [SOURCE_URL]): Record<string, unknown> {
  return {
    entity: { entityId, authChain: [] },
    contentServerUrls,
    type: 'world',
    subType: 'deployment',
    key: entityId,
    timestamp: 1700000000000
  }
}

describe('when parsing the worlds changes feed configuration', () => {
  let allowedHosts: Set<string>

  beforeEach(() => {
    allowedHosts = new Set([HOST, 'dcl.dev'])
  })

  describe('and no source urls are configured', () => {
    it('should derive the source url by stripping /changes from the feed url', () => {
      expect(parseWorldsChangesFeeds(`${FEED_URL}/`, undefined, allowedHosts)).toEqual([
        { url: FEED_URL, host: HOST, sourceContentServerUrl: SOURCE_URL }
      ])
    })
  })

  describe('and a source url is configured for the feed', () => {
    it('should use the configured source url', () => {
      expect(
        parseWorldsChangesFeeds('https://dcl.dev/worlds-content-server/changes', `${SOURCE_URL}/`, allowedHosts)
      ).toEqual([
        { url: 'https://dcl.dev/worlds-content-server/changes', host: 'dcl.dev', sourceContentServerUrl: SOURCE_URL }
      ])
    })
  })

  describe('and the number of source urls does not match the feeds', () => {
    it('should throw an InvalidWorldsChangesConfigError', () => {
      expect(() => parseWorldsChangesFeeds(FEED_URL, `${SOURCE_URL},${SOURCE_URL}`, allowedHosts)).toThrow(
        InvalidWorldsChangesConfigError
      )
    })
  })

  describe('and a feed host is not allowlisted', () => {
    it('should throw an InvalidWorldsChangesConfigError', () => {
      expect(() => parseWorldsChangesFeeds('https://evil.example.com/changes', undefined, allowedHosts)).toThrow(
        InvalidWorldsChangesConfigError
      )
    })
  })

  describe('and a source url is not allowlisted', () => {
    it('should throw an InvalidWorldsChangesConfigError', () => {
      expect(() => parseWorldsChangesFeeds(FEED_URL, 'https://evil.example.com', allowedHosts)).toThrow(
        InvalidWorldsChangesConfigError
      )
    })
  })

  describe('and a feed url does not end with /changes', () => {
    it('should throw an InvalidWorldsChangesConfigError', () => {
      expect(() => parseWorldsChangesFeeds(SOURCE_URL, undefined, allowedHosts)).toThrow(
        InvalidWorldsChangesConfigError
      )
    })
  })

  describe('and two feeds share a host', () => {
    it('should throw an InvalidWorldsChangesConfigError', () => {
      expect(() =>
        parseWorldsChangesFeeds(`${FEED_URL},https://${HOST}/other/changes`, undefined, allowedHosts)
      ).toThrow(InvalidWorldsChangesConfigError)
    })
  })
})

describe('when running the worlds change relay', () => {
  let configValues: Record<string, string>
  let storage: IContentStorageComponent
  let worldsChangesClient: jest.Mocked<IWorldsChangesClientComponent>
  let snsEventPublisher: jest.Mocked<SnsPublisherComponent>
  let relay: IWorldsChangeRelayComponent

  beforeEach(() => {
    configValues = {
      ALLOWED_CONTENT_SERVER_HOSTS: `${HOST},peer.decentraland.org`,
      WORLDS_CHANGES_URLS: FEED_URL,
      WORLDS_CHANGES_POLL_INTERVAL_MS: '1',
      WORLDS_CHANGES_MAX_BACKOFF_MS: '2'
    }
    storage = createInMemoryStorage()
    worldsChangesClient = { fetchChanges: jest.fn() }
    snsEventPublisher = { publishMessage: jest.fn(), publishRawMessage: jest.fn().mockResolvedValue(undefined) }
  })

  async function createRelay(): Promise<IWorldsChangeRelayComponent> {
    return createWorldsChangeRelayComponent({
      config: createConfig(configValues),
      logs: logsMock,
      metrics: metricsMock,
      storage,
      worldsChangesClient,
      snsEventPublisher
    })
  }

  async function runUntilFetched(times: number): Promise<void> {
    relay = await createRelay()
    await relay[START_COMPONENT]?.({ started: () => true, live: () => true, getComponents: () => ({}) })
    await waitFor(() => worldsChangesClient.fetchChanges.mock.calls.length >= times)
    await relay[STOP_COMPONENT]?.()
  }

  afterEach(async () => {
    await relay?.[STOP_COMPONENT]?.()
    jest.clearAllMocks()
  })

  describe('and WORLDS_CHANGES_URLS is unset', () => {
    beforeEach(async () => {
      delete configValues.WORLDS_CHANGES_URLS
      relay = await createRelay()
    })

    it('should expose no start hook', () => {
      expect(relay[START_COMPONENT]).toBeUndefined()
    })
  })

  describe('and WORLDS_CHANGES_URLS is empty', () => {
    beforeEach(async () => {
      configValues.WORLDS_CHANGES_URLS = ' , '
      relay = await createRelay()
    })

    it('should expose no start hook', () => {
      expect(relay[START_COMPONENT]).toBeUndefined()
    })
  })

  describe('and a feed url is not allowlisted', () => {
    beforeEach(() => {
      configValues.WORLDS_CHANGES_URLS = 'https://evil.example.com/changes'
    })

    it('should fail to create with an InvalidWorldsChangesConfigError', async () => {
      await expect(createRelay()).rejects.toBeInstanceOf(InvalidWorldsChangesConfigError)
    })
  })

  describe('and no cursor is stored', () => {
    beforeEach(async () => {
      worldsChangesClient.fetchChanges
        .mockResolvedValueOnce({ changes: [], next: null })
        .mockImplementation(blockUntilAborted)
      await runUntilFetched(2)
    })

    it('should request the feed from the oldest retained row', () => {
      expect(worldsChangesClient.fetchChanges).toHaveBeenNthCalledWith(
        1,
        FEED_URL,
        expect.objectContaining({ after: undefined, limit: 100 })
      )
    })
  })

  describe('and a cursor is stored', () => {
    beforeEach(async () => {
      await storage.storeStream(CURSOR_KEY, Readable.from([Buffer.from('7:3')]))
      worldsChangesClient.fetchChanges
        .mockResolvedValueOnce({ changes: [], next: null })
        .mockImplementation(blockUntilAborted)
      await runUntilFetched(2)
    })

    it('should request the changes after the stored cursor', () => {
      expect(worldsChangesClient.fetchChanges).toHaveBeenNthCalledWith(
        1,
        FEED_URL,
        expect.objectContaining({ after: '7:3' })
      )
    })
  })

  describe('and the feed returns a deployment and an undeployment', () => {
    let deployment: Record<string, unknown>
    let undeployment: Record<string, unknown>

    beforeEach(async () => {
      deployment = deploymentEvent('bafyA')
      undeployment = { type: 'world', subType: 'world_undeployment', key: 'a.dcl.eth', timestamp: 1, metadata: {} }
      worldsChangesClient.fetchChanges
        .mockResolvedValueOnce({
          changes: [
            { cursor: '10:1', event: deployment, attributes: { isMultiplayer: 'true', priority: '1' } },
            { cursor: '10:2', event: undeployment, attributes: {} }
          ],
          next: null
        })
        .mockImplementation(blockUntilAborted)
      await runUntilFetched(2)
    })

    it('should publish the deployment body unchanged with type, subType, feed attributes and the source url', () => {
      expect(snsEventPublisher.publishRawMessage).toHaveBeenNthCalledWith(1, JSON.stringify(deployment), {
        isMultiplayer: 'true',
        priority: '1',
        type: 'world',
        subType: 'deployment',
        sourceContentServerUrl: SOURCE_URL
      })
    })

    it('should publish the undeployment with the source url', () => {
      expect(snsEventPublisher.publishRawMessage).toHaveBeenNthCalledWith(2, JSON.stringify(undeployment), {
        type: 'world',
        subType: 'world_undeployment',
        sourceContentServerUrl: SOURCE_URL
      })
    })

    it('should persist the cursor of the last published change', async () => {
      expect(await readCursor(storage)).toBe('10:2')
    })

    it('should poll again after the last published change', () => {
      expect(worldsChangesClient.fetchChanges).toHaveBeenNthCalledWith(
        2,
        FEED_URL,
        expect.objectContaining({ after: '10:2' })
      )
    })
  })

  describe('and the feed attributes try to override the event type', () => {
    beforeEach(async () => {
      worldsChangesClient.fetchChanges
        .mockResolvedValueOnce({
          changes: [{ cursor: '10:1', event: deploymentEvent('bafyA'), attributes: { type: 'catalyst-deployment' } }],
          next: null
        })
        .mockImplementation(blockUntilAborted)
      await runUntilFetched(2)
    })

    it('should keep the type from the event body', () => {
      expect(snsEventPublisher.publishRawMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'world' })
      )
    })
  })

  describe('and the feed returns an unknown subtype between two known ones', () => {
    beforeEach(async () => {
      worldsChangesClient.fetchChanges
        .mockResolvedValueOnce({
          changes: [
            { cursor: '10:1', event: deploymentEvent('bafyA'), attributes: {} },
            { cursor: '10:2', event: { type: 'world', subType: 'worlds_permission_granted' }, attributes: {} },
            { cursor: '10:3', event: { type: 'catalyst-deployment', subType: 'scene' }, attributes: {} }
          ],
          next: null
        })
        .mockImplementation(blockUntilAborted)
      await runUntilFetched(2)
    })

    it('should publish only the known change', () => {
      expect(snsEventPublisher.publishRawMessage).toHaveBeenCalledTimes(1)
    })

    it('should persist the cursor past the dropped changes', async () => {
      expect(await readCursor(storage)).toBe('10:3')
    })

    it('should count the drops by reason', () => {
      expect(metricsMock.increment).toHaveBeenCalledWith('worlds_changes_dropped', {
        feed: HOST,
        reason: 'unknown_type'
      })
    })
  })

  describe('and a deployment names a content server that is not allowlisted', () => {
    beforeEach(async () => {
      worldsChangesClient.fetchChanges
        .mockResolvedValueOnce({
          changes: [{ cursor: '10:1', event: deploymentEvent('bafyA', ['https://evil.example.com']), attributes: {} }],
          next: null
        })
        .mockImplementation(blockUntilAborted)
      await runUntilFetched(2)
    })

    it('should not publish it', () => {
      expect(snsEventPublisher.publishRawMessage).not.toHaveBeenCalled()
    })
  })

  describe('and an event exceeds the message size bound', () => {
    beforeEach(async () => {
      configValues.WORLDS_CHANGES_MAX_MESSAGE_BYTES = '64'
      worldsChangesClient.fetchChanges
        .mockResolvedValueOnce({
          changes: [{ cursor: '10:1', event: deploymentEvent('bafyA'), attributes: {} }],
          next: null
        })
        .mockImplementation(blockUntilAborted)
      await runUntilFetched(2)
    })

    it('should drop it as too large', () => {
      expect(metricsMock.increment).toHaveBeenCalledWith('worlds_changes_dropped', { feed: HOST, reason: 'too_large' })
    })
  })

  describe('and the publish of the second change fails once', () => {
    beforeEach(async () => {
      snsEventPublisher.publishRawMessage
        .mockReset()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('SNS down'))
        .mockResolvedValue(undefined)
      worldsChangesClient.fetchChanges
        .mockResolvedValueOnce({
          changes: [
            { cursor: '10:1', event: deploymentEvent('bafyA'), attributes: {} },
            { cursor: '10:2', event: deploymentEvent('bafyB'), attributes: {} }
          ],
          next: null
        })
        .mockImplementation(blockUntilAborted)
      await runUntilFetched(2)
    })

    it('should persist only the cursor of the published change', async () => {
      expect(await readCursor(storage)).toBe('10:1')
    })

    it('should retry from the last published change', () => {
      expect(worldsChangesClient.fetchChanges).toHaveBeenNthCalledWith(
        2,
        FEED_URL,
        expect.objectContaining({ after: '10:1' })
      )
    })
  })

  describe('and the page is not the last one', () => {
    beforeEach(async () => {
      worldsChangesClient.fetchChanges
        .mockResolvedValueOnce({
          changes: [{ cursor: '10:1', event: deploymentEvent('bafyA'), attributes: {} }],
          next: '10:1'
        })
        .mockResolvedValueOnce({
          changes: [{ cursor: '10:2', event: deploymentEvent('bafyB'), attributes: {} }],
          next: null
        })
        .mockImplementation(blockUntilAborted)
      await runUntilFetched(3)
    })

    it('should relay both pages', () => {
      expect(snsEventPublisher.publishRawMessage).toHaveBeenCalledTimes(2)
    })
  })

  describe('and the relay is stopped while polling', () => {
    let callsAtStop: number

    beforeEach(async () => {
      worldsChangesClient.fetchChanges.mockImplementation(blockUntilAborted)
      await runUntilFetched(1)
      callsAtStop = worldsChangesClient.fetchChanges.mock.calls.length
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    it('should not poll again', () => {
      expect(worldsChangesClient.fetchChanges).toHaveBeenCalledTimes(callsAtStop)
    })
  })
})
