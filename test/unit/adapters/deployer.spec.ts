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
  downloadQueueMock
} from '../../mocks/components'
import { DeployableEntity, IDeployerComponent } from '@dcl/snapshots-fetcher'

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
    >
  >

  let mockEntity: DeployableEntity
  let mockServers: string[]

  beforeEach(() => {
    downloadQueueMock.onSizeLessThan.mockResolvedValue()
    downloadQueueMock.scheduleJob.mockImplementation(async (fn) => await fn())
    configMock.getString.mockResolvedValue('')

    components = {
      config: configMock,
      logs: logsMock,
      storage: storageMock,
      downloadQueue: downloadQueueMock,
      fetch: fetcherMock,
      metrics: metricsMock,
      snsPublisher: snsPublisherMock,
      snsEventPublisher: snsPublisherMock,
      entityDownloader: entityDownloaderMock
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

  it('should skip and mark as deployed an entity whose entityId is not a bare CID', async () => {
    const maliciousEntity = { ...mockEntity, entityId: '../../etc/passwd' }

    const deployer = await createDeployerComponent(components)
    await deployer.scheduleEntityDeployment(maliciousEntity, mockServers)

    expect(metricsMock.increment).toHaveBeenCalledWith('entity_skipped_invalid_id', {
      entityType: maliciousEntity.entityType
    })
    expect(maliciousEntity.markAsDeployed).toHaveBeenCalled()
    expect(storageMock.exist).not.toHaveBeenCalled()
    expect(entityDownloaderMock.downloadEntity).not.toHaveBeenCalled()
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
    entityDownloaderMock.downloadEntity.mockResolvedValue(undefined)
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
      entityDownloaderMock.downloadEntity.mockResolvedValue(undefined)
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
      entityDownloaderMock.downloadEntity.mockResolvedValue(undefined)
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
        entityDownloaderMock.downloadEntity.mockResolvedValue(undefined)
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

  describe('when reporting whether the deployer is idle', () => {
    let deployer: IDeployerComponent
    let settled: boolean
    let releaseQueue: () => void

    beforeEach(async () => {
      settled = false
      deployer = await createDeployerComponent(components)
      downloadQueueMock.onIdle.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseQueue = resolve
        })
      )
    })

    describe('and the download queue still holds scheduled work', () => {
      beforeEach(async () => {
        void deployer.onIdle().then(() => {
          settled = true
        })
        await Promise.resolve()
      })

      it('should not report idle', () => {
        expect(settled).toBe(false)
      })
    })

    describe('and the download queue has drained', () => {
      beforeEach(async () => {
        void deployer.onIdle().then(() => {
          settled = true
        })
        releaseQueue()
        await Promise.resolve()
      })

      it('should report idle', () => {
        expect(settled).toBe(true)
      })

      it('should delegate the drain to the download queue', () => {
        expect(downloadQueueMock.onIdle).toHaveBeenCalled()
      })
    })
  })
})
