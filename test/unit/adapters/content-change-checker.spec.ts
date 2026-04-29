import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import { createContentChangeCheckerComponent } from '../../../src/adapters/content-change-checker'
import { configMock, logsMock, fetcherMock, metricsMock } from '../../mocks/components'

describe('ContentChangeCheckerComponent', () => {
  let mockEntity: DeployableEntity
  const mockServers = ['https://server1.example.com', 'https://server2.example.com']

  const registryEntity = {
    id: 'old-entity-id',
    content: [
      { file: 'scene.json', hash: 'hash1' },
      { file: 'model.glb', hash: 'hash2' }
    ],
    versions: {
      assets: {
        windows: { version: 'v5', buildDate: '2024-01-01' },
        mac: { version: 'v5', buildDate: '2024-01-01' },
        webgl: { version: 'v5', buildDate: '2024-01-01' }
      }
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()

    mockEntity = {
      entityId: 'new-entity-id',
      entityType: 'scene',
      pointers: ['10,15'],
      authChain: [],
      entityTimestamp: Date.now()
    }
  })

  it('should return changed:true when ASSET_BUNDLE_VERSION is not configured', async () => {
    configMock.getString.mockResolvedValue('')

    const checker = await createContentChangeCheckerComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    const result = await checker.check(mockEntity, mockServers)
    expect(result.changed).toBe(true)
  })

  it('should return changed:true for non-scene entities', async () => {
    configMock.getString.mockResolvedValue('v5')

    const checker = await createContentChangeCheckerComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    const wearableEntity = { ...mockEntity, entityType: 'wearable' }
    const result = await checker.check(wearableEntity, mockServers)
    expect(result.changed).toBe(true)
  })

  it('should return changed:false when content hashes match and versions match', async () => {
    configMock.getString.mockImplementation(async (key: string) => {
      if (key === 'ASSET_BUNDLE_VERSION') return 'v5'
      if (key === 'ASSET_BUNDLE_REGISTRY_URL') return 'https://registry.example.com'
      return ''
    })

    fetcherMock.fetch.mockImplementation(async (url: string) => {
      if (url === 'https://registry.example.com/entities/active') {
        return {
          ok: true,
          json: async () => [registryEntity]
        } as any
      }
      if (url.includes('/content/entities/new-entity-id')) {
        return {
          ok: true,
          json: async () => ({
            content: [
              { file: 'scene.json', hash: 'hash1' },
              { file: 'model.glb', hash: 'hash2' }
            ]
          })
        } as any
      }
      return { ok: false } as any
    })

    const checker = await createContentChangeCheckerComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    const result = await checker.check(mockEntity, mockServers)
    expect(result.changed).toBe(false)
    if (result.changed === false) {
      expect(result.registryEntity.id).toBe('old-entity-id')
    }
  })

  it('should return changed:true when content hashes differ', async () => {
    configMock.getString.mockImplementation(async (key: string) => {
      if (key === 'ASSET_BUNDLE_VERSION') return 'v5'
      if (key === 'ASSET_BUNDLE_REGISTRY_URL') return 'https://registry.example.com'
      return ''
    })

    fetcherMock.fetch.mockImplementation(async (url: string) => {
      if (url === 'https://registry.example.com/entities/active') {
        return {
          ok: true,
          json: async () => [registryEntity]
        } as any
      }
      if (url.includes('/content/entities/new-entity-id')) {
        return {
          ok: true,
          json: async () => ({
            content: [
              { file: 'scene.json', hash: 'hash1' },
              { file: 'model.glb', hash: 'different-hash' }
            ]
          })
        } as any
      }
      return { ok: false } as any
    })

    const checker = await createContentChangeCheckerComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    const result = await checker.check(mockEntity, mockServers)
    expect(result.changed).toBe(true)
  })

  it('should return changed:true when AB version does not match', async () => {
    configMock.getString.mockImplementation(async (key: string) => {
      if (key === 'ASSET_BUNDLE_VERSION') return 'v6'
      if (key === 'ASSET_BUNDLE_REGISTRY_URL') return 'https://registry.example.com'
      return ''
    })

    fetcherMock.fetch.mockImplementation(async (url: string) => {
      if (url === 'https://registry.example.com/entities/active') {
        return {
          ok: true,
          json: async () => [registryEntity]
        } as any
      }
      return { ok: false } as any
    })

    const checker = await createContentChangeCheckerComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    const result = await checker.check(mockEntity, mockServers)
    expect(result.changed).toBe(true)
  })

  it('should return changed:true when no active entity in registry', async () => {
    configMock.getString.mockImplementation(async (key: string) => {
      if (key === 'ASSET_BUNDLE_VERSION') return 'v5'
      if (key === 'ASSET_BUNDLE_REGISTRY_URL') return 'https://registry.example.com'
      return ''
    })

    fetcherMock.fetch.mockImplementation(async (url: string) => {
      if (url === 'https://registry.example.com/entities/active') {
        return {
          ok: true,
          json: async () => []
        } as any
      }
      return { ok: false } as any
    })

    const checker = await createContentChangeCheckerComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    const result = await checker.check(mockEntity, mockServers)
    expect(result.changed).toBe(true)
  })

  it('should return changed:true when registry API fails', async () => {
    configMock.getString.mockImplementation(async (key: string) => {
      if (key === 'ASSET_BUNDLE_VERSION') return 'v5'
      if (key === 'ASSET_BUNDLE_REGISTRY_URL') return 'https://registry.example.com'
      return ''
    })

    fetcherMock.fetch.mockRejectedValue(new Error('Network error'))

    const checker = await createContentChangeCheckerComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    const result = await checker.check(mockEntity, mockServers)
    expect(result.changed).toBe(true)
  })
})
