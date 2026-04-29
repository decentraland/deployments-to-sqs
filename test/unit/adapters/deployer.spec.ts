import { AppComponents } from '../../../src/types'
import { createDeployerComponent } from '../../../src/adapters/deployer'
import {
  configMock,
  logsMock,
  storageMock,
  fetcherMock,
  metricsMock,
  snsPublisherMock,
  entityDownloaderMock,
  downloadQueueMock,
  contentChangeCheckerMock,
  manifestCopierMock
} from '../../mocks/components'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'

describe('DeployerComponent', () => {
  let components: jest.Mocked<
    Pick<
      AppComponents,
      | 'config'
      | 'logs'
      | 'storage'
      | 'downloadQueue'
      | 'fetch'
      | 'metrics'
      | 'snsPublisher'
      | 'snsEventPublisher'
      | 'entityDownloader'
      | 'contentChangeChecker'
      | 'manifestCopier'
    >
  >

  let mockEntity: DeployableEntity
  let mockServers: string[]

  beforeEach(() => {
    downloadQueueMock.onSizeLessThan.mockResolvedValue()
    downloadQueueMock.scheduleJob.mockImplementation(async (fn) => await fn())
    configMock.getString.mockResolvedValue('')
    contentChangeCheckerMock.check.mockResolvedValue({ changed: true })
    manifestCopierMock.copyAndNotify.mockResolvedValue()

    components = {
      config: configMock,
      logs: logsMock,
      storage: storageMock,
      downloadQueue: downloadQueueMock,
      fetch: fetcherMock,
      metrics: metricsMock,
      snsPublisher: snsPublisherMock,
      snsEventPublisher: snsPublisherMock,
      entityDownloader: entityDownloaderMock,
      contentChangeChecker: contentChangeCheckerMock,
      manifestCopier: manifestCopierMock
    }

    mockEntity = {
      entityId: '123',
      entityType: 'scene',
      markAsDeployed: jest.fn(),
      pointers: ['pointer1'],
      authChain: [],
      entityTimestamp: Date.now()
    }

    mockServers = ['server1', 'server2']

    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllTimers()
  })

  it('should call mark as deployed when the entity is already stored', async () => {
    storageMock.exist.mockResolvedValue(true)

    const deployer = await createDeployerComponent(components)
    await deployer.scheduleEntityDeployment(mockEntity, mockServers)

    expect(metricsMock.increment).toHaveBeenCalledWith('entity_already_stored', {
      entityType: mockEntity.entityType
    })
    expect(mockEntity.markAsDeployed).toHaveBeenCalled()
    expect(downloadQueueMock.onSizeLessThan).not.toHaveBeenCalled()
    expect(entityDownloaderMock.downloadEntity).not.toHaveBeenCalled()
  })

  it('should do nothing if the entity is already stored but does not define a markAsDeployed function', async () => {
    storageMock.exist.mockResolvedValue(true)

    const mockEntityWithoutMarkAsDeployed = { ...mockEntity, markAsDeployed: undefined }

    const deployer = await createDeployerComponent(components)
    await deployer.scheduleEntityDeployment(mockEntityWithoutMarkAsDeployed, mockServers)

    expect(metricsMock.increment).toHaveBeenCalledWith('entity_already_stored', {
      entityType: mockEntity.entityType
    })
    expect(downloadQueueMock.onSizeLessThan).not.toHaveBeenCalled()
    expect(entityDownloaderMock.downloadEntity).not.toHaveBeenCalled()
  })

  it('should successfully deploy a new entity', async () => {
    storageMock.exist.mockResolvedValue(false)
    entityDownloaderMock.downloadEntity.mockResolvedValue()
    snsPublisherMock.publishMessage.mockResolvedValue()

    const deployer = await createDeployerComponent(components)
    await deployer.scheduleEntityDeployment(mockEntity, mockServers)

    await jest.advanceTimersByTimeAsync(0)

    expect(metricsMock.increment).toHaveBeenCalledWith('schedule_entity_deployment_attempt', {
      entityType: mockEntity.entityType
    })
    expect(downloadQueueMock.onSizeLessThan).toHaveBeenCalledWith(1000)
    expect(entityDownloaderMock.downloadEntity).toHaveBeenCalledWith(mockEntity, mockServers)
    expect(snsPublisherMock.publishMessage).toHaveBeenCalledTimes(2)
    expect(snsPublisherMock.publishMessage).toHaveBeenCalledWith(mockEntity, mockServers)
    expect(metricsMock.increment).toHaveBeenCalledWith('entity_deployment_success', {
      entityType: mockEntity.entityType
    })
    expect(mockEntity.markAsDeployed).toHaveBeenCalled()
  })

  it('should handle retryable errors gracefully', async () => {
    storageMock.exist.mockResolvedValue(false)
    entityDownloaderMock.downloadEntity.mockRejectedValue(new Error('Network Error'))

    const deployer = await createDeployerComponent(components)
    await deployer.scheduleEntityDeployment(mockEntity, mockServers)

    expect(metricsMock.increment).toHaveBeenCalledWith('entity_deployment_failure', {
      retryable: 'true',
      entityType: mockEntity.entityType
    })
    expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
  })

  it('should handle non-retryable errors and mark the entity as deployed', async () => {
    storageMock.exist.mockResolvedValue(false)
    entityDownloaderMock.downloadEntity.mockRejectedValue(new Error('status: 404'))

    const deployer = await createDeployerComponent(components)
    await deployer.scheduleEntityDeployment(mockEntity, mockServers)

    expect(metricsMock.increment).toHaveBeenCalledWith('entity_deployment_failure', {
      retryable: 'false',
      entityType: mockEntity.entityType
    })
    expect(mockEntity.markAsDeployed).toHaveBeenCalled()
  })

  it('should handle errors before scheduling the job', async () => {
    storageMock.exist.mockResolvedValue(false)
    downloadQueueMock.onSizeLessThan.mockRejectedValue(new Error('Queue Error'))

    const deployer = await createDeployerComponent(components)
    await deployer.scheduleEntityDeployment(mockEntity, mockServers)

    expect(metricsMock.increment).toHaveBeenCalledWith('entity_deployment_failure', {
      entityType: mockEntity.entityType
    })
    expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
  })

  describe('entity age filter', () => {
    it('should skip and mark as deployed entities older than the configured max age', async () => {
      const maxAgeInSeconds = 3600
      configMock.getString.mockResolvedValue(String(maxAgeInSeconds))
      const oldTimestamp = Date.now() - (maxAgeInSeconds + 1) * 1000
      const oldEntity = { ...mockEntity, entityTimestamp: oldTimestamp }

      const deployer = await createDeployerComponent(components)
      await deployer.scheduleEntityDeployment(oldEntity, mockServers)

      expect(metricsMock.increment).toHaveBeenCalledWith('entity_skipped_old', {
        entityType: oldEntity.entityType
      })
      expect(oldEntity.markAsDeployed).toHaveBeenCalled()
      expect(storageMock.exist).not.toHaveBeenCalled()
      expect(downloadQueueMock.onSizeLessThan).not.toHaveBeenCalled()
      expect(entityDownloaderMock.downloadEntity).not.toHaveBeenCalled()
    })

    it('should process recent entities normally when the age filter is enabled', async () => {
      const maxAgeInSeconds = 3600
      configMock.getString.mockResolvedValue(String(maxAgeInSeconds))
      storageMock.exist.mockResolvedValue(false)
      entityDownloaderMock.downloadEntity.mockResolvedValue()
      snsPublisherMock.publishMessage.mockResolvedValue()

      const deployer = await createDeployerComponent(components)
      await deployer.scheduleEntityDeployment(mockEntity, mockServers)

      await jest.advanceTimersByTimeAsync(0)

      expect(metricsMock.increment).not.toHaveBeenCalledWith('entity_skipped_old', expect.anything())
      expect(entityDownloaderMock.downloadEntity).toHaveBeenCalledWith(mockEntity, mockServers)
      expect(mockEntity.markAsDeployed).toHaveBeenCalled()
    })

    it('should not skip an entity aged exactly at the threshold', async () => {
      const maxAgeInSeconds = 3600
      configMock.getString.mockResolvedValue(String(maxAgeInSeconds))
      storageMock.exist.mockResolvedValue(false)
      entityDownloaderMock.downloadEntity.mockResolvedValue()
      snsPublisherMock.publishMessage.mockResolvedValue()
      const boundaryEntity = { ...mockEntity, entityTimestamp: Date.now() - maxAgeInSeconds * 1000 }

      const deployer = await createDeployerComponent(components)
      await deployer.scheduleEntityDeployment(boundaryEntity, mockServers)

      await jest.advanceTimersByTimeAsync(0)

      expect(metricsMock.increment).not.toHaveBeenCalledWith('entity_skipped_old', expect.anything())
      expect(storageMock.exist).toHaveBeenCalled()
      expect(entityDownloaderMock.downloadEntity).toHaveBeenCalledWith(boundaryEntity, mockServers)
    })

    it.each(['', '0', 'abc', '-3600'])(
      'should process all entities when config is "%s" (filter disabled)',
      async (configValue) => {
        configMock.getString.mockResolvedValue(configValue)
        storageMock.exist.mockResolvedValue(false)
        entityDownloaderMock.downloadEntity.mockResolvedValue()
        snsPublisherMock.publishMessage.mockResolvedValue()
        const oldTimestamp = Date.now() - 10 * 365 * 24 * 3600 * 1000
        const oldEntity = { ...mockEntity, entityTimestamp: oldTimestamp }

        const deployer = await createDeployerComponent(components)
        await deployer.scheduleEntityDeployment(oldEntity, mockServers)

        await jest.advanceTimersByTimeAsync(0)

        expect(metricsMock.increment).not.toHaveBeenCalledWith('entity_skipped_old', expect.anything())
        expect(entityDownloaderMock.downloadEntity).toHaveBeenCalledWith(oldEntity, mockServers)
      }
    )
  })

  describe('content change check', () => {
    const registryEntity = {
      id: 'previous-entity-id',
      content: [{ file: 'scene.json', hash: 'hash1' }],
      versions: {
        assets: {
          windows: { version: 'v5', buildDate: '2024-01-01' },
          mac: { version: 'v5', buildDate: '2024-01-01' },
          webgl: { version: 'v5', buildDate: '2024-01-01' }
        }
      }
    }

    it('should skip entity and copy manifests when content has not changed', async () => {
      storageMock.exist.mockResolvedValue(false)
      contentChangeCheckerMock.check.mockResolvedValue({ changed: false, registryEntity })

      const deployer = await createDeployerComponent(components)
      await deployer.scheduleEntityDeployment(mockEntity, mockServers)

      expect(manifestCopierMock.copyAndNotify).toHaveBeenCalledWith(mockEntity, registryEntity)
      expect(metricsMock.increment).toHaveBeenCalledWith('entity_skipped_content_unchanged', {
        entityType: mockEntity.entityType
      })
      expect(mockEntity.markAsDeployed).toHaveBeenCalled()
      expect(downloadQueueMock.onSizeLessThan).not.toHaveBeenCalled()
      expect(entityDownloaderMock.downloadEntity).not.toHaveBeenCalled()
    })

    it('should fall back to normal deployment when manifest copy fails', async () => {
      storageMock.exist.mockResolvedValue(false)
      contentChangeCheckerMock.check.mockResolvedValue({ changed: false, registryEntity })
      manifestCopierMock.copyAndNotify.mockRejectedValue(new Error('S3 error'))
      entityDownloaderMock.downloadEntity.mockResolvedValue()
      snsPublisherMock.publishMessage.mockResolvedValue()

      const deployer = await createDeployerComponent(components)
      await deployer.scheduleEntityDeployment(mockEntity, mockServers)

      await jest.advanceTimersByTimeAsync(0)

      expect(downloadQueueMock.onSizeLessThan).toHaveBeenCalledWith(1000)
      expect(entityDownloaderMock.downloadEntity).toHaveBeenCalledWith(mockEntity, mockServers)
    })

    it('should proceed normally when content has changed', async () => {
      storageMock.exist.mockResolvedValue(false)
      contentChangeCheckerMock.check.mockResolvedValue({ changed: true })
      entityDownloaderMock.downloadEntity.mockResolvedValue()
      snsPublisherMock.publishMessage.mockResolvedValue()

      const deployer = await createDeployerComponent(components)
      await deployer.scheduleEntityDeployment(mockEntity, mockServers)

      await jest.advanceTimersByTimeAsync(0)

      expect(manifestCopierMock.copyAndNotify).not.toHaveBeenCalled()
      expect(entityDownloaderMock.downloadEntity).toHaveBeenCalledWith(mockEntity, mockServers)
    })
  })
})
