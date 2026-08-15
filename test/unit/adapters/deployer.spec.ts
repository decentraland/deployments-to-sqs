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

  // The deployer reads several string knobs. Scope the value under test to its own key so it does
  // not also land on DOWNLOAD_QUEUE_MAX_PENDING, which rejects non-positive-integer values.
  const setEntityMaxAge = (value: string) =>
    configMock.getString.mockImplementation(async (key: string) =>
      key === 'ENTITY_MAX_AGE_IN_SECONDS' ? value : undefined
    )

  let mockEntity: DeployableEntity
  let mockServers: string[]

  beforeEach(() => {
    downloadQueueMock.onSizeLessThan.mockResolvedValue()
    downloadQueueMock.scheduleJob.mockImplementation(async (fn) => await fn())
    setEntityMaxAge('')

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
      entityType: mockEntity.entityType,
      retryable: 'true'
    })
    expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
  })

  describe('entity age filter', () => {
    it('should skip and mark as deployed entities older than the configured max age', async () => {
      const maxAgeInSeconds = 3600
      setEntityMaxAge(String(maxAgeInSeconds))
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
      setEntityMaxAge(String(maxAgeInSeconds))
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
      setEntityMaxAge(String(maxAgeInSeconds))
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
        setEntityMaxAge(configValue)
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

  describe('when the download queue itself rejects the scheduled job', () => {
    // p-queue rejects the queue promise when the configured timeout elapses (createJobQueue sets
    // throwOnTimeout whenever a timeout is given). The job body never sees it, so it can only be
    // handled on the promise scheduleJob returns.
    let queueError: Error
    let unhandled: unknown[]
    let onUnhandled: (reason: unknown) => void

    beforeEach(async () => {
      // Real timers here: detecting an unhandled rejection needs Node to actually turn the event
      // loop, which the suite-wide fake timers prevent.
      jest.useRealTimers()

      queueError = new Error('Promise timed out')
      unhandled = []
      onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)

      storageMock.exist.mockResolvedValue(false)
      downloadQueueMock.scheduleJob.mockRejectedValue(queueError)

      const deployer = await createDeployerComponent(components)
      await deployer.scheduleEntityDeployment(mockEntity, mockServers)

      // Let the rejection settle and give Node a turn to flag it if nothing handled it.
      await new Promise((resolve) => setImmediate(resolve))
    })

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled)
    })

    it('should not leave an unhandled rejection', () => {
      expect(unhandled).toEqual([])
    })

    it('should increment the queue failure metric', () => {
      expect(metricsMock.increment).toHaveBeenCalledWith('entity_deployment_queue_failure', {
        entityType: mockEntity.entityType
      })
    })

    it('should not mark the entity as deployed, since the job may still be running', () => {
      expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
    })
  })

  describe('when tracking download queue depth', () => {
    describe('and a job is scheduled and runs to completion', () => {
      beforeEach(async () => {
        storageMock.exist.mockResolvedValue(false)
        entityDownloaderMock.downloadEntity.mockResolvedValue(undefined)
        snsPublisherMock.publishMessage.mockResolvedValue()

        const deployer = await createDeployerComponent(components)
        await deployer.scheduleEntityDeployment(mockEntity, mockServers)
        await jest.advanceTimersByTimeAsync(0)
      })

      it('should count the entity into the queue and back out again', () => {
        expect(metricsMock.increment).toHaveBeenCalledWith('download_queue_size')
        expect(metricsMock.decrement).toHaveBeenCalledWith('download_queue_size')
      })

      it('should count the job as pending while it runs and clear it afterwards', () => {
        expect(metricsMock.increment).toHaveBeenCalledWith('download_queue_pending')
        expect(metricsMock.decrement).toHaveBeenCalledWith('download_queue_pending')
      })
    })

    describe('and the job fails', () => {
      beforeEach(async () => {
        storageMock.exist.mockResolvedValue(false)
        entityDownloaderMock.downloadEntity.mockRejectedValue(new Error('boom'))

        const deployer = await createDeployerComponent(components)
        await deployer.scheduleEntityDeployment(mockEntity, mockServers)
        await jest.advanceTimersByTimeAsync(0)
      })

      it('should still clear the pending count, so a failing job cannot leak the gauge', () => {
        expect(metricsMock.decrement).toHaveBeenCalledWith('download_queue_pending')
      })
    })

    describe('and the queue promise rejects after the job has already run', () => {
      // What a p-queue timeout looks like: the queue stops counting the task and rejects, but the
      // job function is not cancelled and keeps running to completion.
      let sizeDelta: number
      let pendingDelta: number

      beforeEach(async () => {
        storageMock.exist.mockResolvedValue(false)
        entityDownloaderMock.downloadEntity.mockResolvedValue(undefined)
        snsPublisherMock.publishMessage.mockResolvedValue()
        downloadQueueMock.scheduleJob.mockImplementation(async (fn) => {
          await fn()
          throw new Error('Promise timed out')
        })

        const deployer = await createDeployerComponent(components)
        await deployer.scheduleEntityDeployment(mockEntity, mockServers)
        await jest.advanceTimersByTimeAsync(0)

        const count = (mock: jest.Mock, name: string) => mock.mock.calls.filter((call) => call[0] === name).length
        sizeDelta =
          count(metricsMock.increment, 'download_queue_size') - count(metricsMock.decrement, 'download_queue_size')
        pendingDelta =
          count(metricsMock.increment, 'download_queue_pending') -
          count(metricsMock.decrement, 'download_queue_pending')
      })

      it('should leave the size gauge balanced rather than drifting upward', () => {
        expect(sizeDelta).toBe(0)
      })

      it('should leave the pending gauge balanced', () => {
        expect(pendingDelta).toBe(0)
      })

      it('should still record the queue failure', () => {
        expect(metricsMock.increment).toHaveBeenCalledWith('entity_deployment_queue_failure', {
          entityType: mockEntity.entityType
        })
      })
    })

    describe('and the queue refuses the job because it has been stopped', () => {
      beforeEach(async () => {
        storageMock.exist.mockResolvedValue(false)
        downloadQueueMock.scheduleJob.mockImplementation(() => {
          throw new Error('The job queue was stopped and no longer accepts jobs')
        })

        const deployer = await createDeployerComponent(components)
        await deployer.scheduleEntityDeployment(mockEntity, mockServers)
        await jest.advanceTimersByTimeAsync(0)
      })

      it('should undo the queued count rather than leaking it', () => {
        expect(metricsMock.increment).toHaveBeenCalledWith('download_queue_size')
        expect(metricsMock.decrement).toHaveBeenCalledWith('download_queue_size')
      })

      it('should record the scheduling failure as retryable, since the entity was never marked', () => {
        expect(metricsMock.increment).toHaveBeenCalledWith('entity_deployment_failure', {
          entityType: mockEntity.entityType,
          retryable: 'true'
        })
      })
    })
  })

  describe('when an entity type outside the known set reaches the metrics', () => {
    beforeEach(async () => {
      const deployer = await createDeployerComponent(components)
      await deployer.scheduleEntityDeployment({ ...mockEntity, entityType: 'not-a-real-type' }, mockServers)
      await jest.advanceTimersByTimeAsync(0)
    })

    it('should clamp the label so a content server cannot grow the registry', () => {
      expect(metricsMock.increment).toHaveBeenCalledWith('schedule_entity_deployment_attempt', {
        entityType: 'other'
      })
    })
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
