import { CopyObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import { createManifestCopierComponent } from '../../../src/adapters/manifest-copier'
import { configMock, logsMock, fetcherMock, metricsMock } from '../../mocks/components'
import { RegistryEntity } from '../../../src/types'

const mockS3Send = jest.fn()
const mockSnsSend = jest.fn()

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  CopyObjectCommand: jest.fn().mockImplementation((args) => ({ ...args, _type: 'CopyObjectCommand' })),
  PutObjectCommand: jest.fn().mockImplementation((args) => ({ ...args, _type: 'PutObjectCommand' }))
}))

jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn().mockImplementation(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn().mockImplementation((args) => ({ ...args, _type: 'PublishCommand' }))
}))

const MockCopyObjectCommand = CopyObjectCommand as unknown as jest.Mock
const MockPutObjectCommand = PutObjectCommand as unknown as jest.Mock
const MockPublishCommand = PublishCommand as unknown as jest.Mock
const MockSNSClient = SNSClient as unknown as jest.Mock

describe('ManifestCopierComponent', () => {
  const mockEntity: DeployableEntity = {
    entityId: 'new-entity-id',
    entityType: 'scene',
    pointers: ['10,15'],
    authChain: [],
    entityTimestamp: Date.now()
  }

  const registryEntity: RegistryEntity = {
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

  const manifest = {
    version: 'v5',
    files: ['file1.glb', 'file2.glb'],
    exitCode: 0,
    contentServerUrl: 'https://content.example.com',
    date: '2024-01-01T00:00:00.000Z'
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  function setupConfig(overrides: Record<string, string> = {}) {
    const values: Record<string, string> = {
      ASSET_BUNDLE_CDN_BUCKET: 'test-bucket',
      ASSET_BUNDLE_CDN_URL: 'https://cdn.example.com',
      ASSET_BUNDLE_VERSION: 'v5',
      SNS_ENDPOINT: '',
      EVENTS_SNS_ARN: 'arn:aws:sns:us-east-1:123456789:test-topic',
      ...overrides
    }
    configMock.getString.mockImplementation(async (key: string) => values[key] || '')
  }

  function setupFetchManifest(manifestsByPlatform: Record<string, any | null> = {}) {
    fetcherMock.fetch.mockImplementation(async (url: string) => {
      for (const [platform, m] of Object.entries(manifestsByPlatform)) {
        const suffix = platform !== 'webgl' ? `old-entity-id_${platform}.json` : 'old-entity-id.json'
        if (url.includes(suffix)) {
          if (!m) return { ok: false, status: 404 } as any
          return { ok: true, json: async () => m } as any
        }
      }
      return { ok: true, json: async () => manifest } as any
    })
  }

  it('should throw when not fully configured', async () => {
    setupConfig({ ASSET_BUNDLE_CDN_BUCKET: '' })

    const copier = await createManifestCopierComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    await expect(copier.copyAndNotify(mockEntity, registryEntity)).rejects.toThrow('ManifestCopier not configured')
  })

  it('should copy files, upload manifests, and publish events for all platforms', async () => {
    setupConfig()
    setupFetchManifest()

    const copier = await createManifestCopierComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    await copier.copyAndNotify(mockEntity, registryEntity)

    // 3 platforms × 2 files = 6 CopyObjectCommand + 3 PutObjectCommand
    // 3 platforms × 1 PublishCommand = 3
    // total s3.send = 9, sns.send = 3
    expect(mockS3Send).toHaveBeenCalledTimes(9)
    expect(mockSnsSend).toHaveBeenCalledTimes(3)
  })

  it('should use correct S3 keys when copying files', async () => {
    setupConfig()
    setupFetchManifest()

    const copier = await createManifestCopierComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    await copier.copyAndNotify(mockEntity, registryEntity)

    // First platform (windows), first file
    expect(MockCopyObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'test-bucket',
        CopySource: 'test-bucket/v5/old-entity-id/file1.glb',
        Key: 'v5/new-entity-id/file1.glb'
      })
    )
  })

  it('should use correct manifest key for webgl (no platform suffix)', async () => {
    setupConfig()
    setupFetchManifest()

    const copier = await createManifestCopierComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    await copier.copyAndNotify(mockEntity, registryEntity)

    // webgl manifest has no platform suffix
    expect(MockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'test-bucket',
        Key: 'manifest/new-entity-id.json'
      })
    )

    // windows manifest has platform suffix
    expect(MockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: 'manifest/new-entity-id_windows.json'
      })
    )
  })

  it('should throw when manifest fetch fails for a platform', async () => {
    setupConfig()
    setupFetchManifest({ windows: null })

    const copier = await createManifestCopierComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    await expect(copier.copyAndNotify(mockEntity, registryEntity)).rejects.toThrow(
      'Could not fetch manifest for old-entity-id platform windows'
    )
  })

  it('should publish SNS events with correct metadata', async () => {
    setupConfig()
    setupFetchManifest()

    const copier = await createManifestCopierComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    await copier.copyAndNotify(mockEntity, registryEntity)

    expect(MockPublishCommand).toHaveBeenCalledTimes(3)
    const firstCallArgs = MockPublishCommand.mock.calls[0][0]
    expect(firstCallArgs.TopicArn).toBe('arn:aws:sns:us-east-1:123456789:test-topic')

    const message = JSON.parse(firstCallArgs.Message)
    expect(message.metadata.entityId).toBe('new-entity-id')
    expect(message.metadata.version).toBe('v5')
  })

  it('should use SNS endpoint when configured', async () => {
    setupConfig({ SNS_ENDPOINT: 'https://sns.example.com' })
    setupFetchManifest()

    await createManifestCopierComponent({
      config: configMock,
      logs: logsMock,
      fetch: fetcherMock,
      metrics: metricsMock
    })

    expect(MockSNSClient).toHaveBeenCalledWith({ endpoint: 'https://sns.example.com' })
  })
})
