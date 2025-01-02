import { AppComponents } from '../../../src/types'
import { createDeployerComponent } from '../../../src/adapters/deployer'
import {
  logsMock,
  storageMock,
  fetcherMock,
  metricsMock,
  snsPublisherMock,
  entityDownloaderMock,
  downloadQueueMock
} from '../../mocks/components'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'

describe('DeployerComponent', () => {
  let components: jest.Mocked<
    Pick<
      AppComponents,
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

    components = {
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

  it('should call mark as deployed when the entity is already stored', async () => {
    storageMock.exist.mockResolvedValue(true)

    const deployer = createDeployerComponent(components)
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

    const deployer = createDeployerComponent(components)
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

    const deployer = createDeployerComponent(components)
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

    const deployer = createDeployerComponent(components)
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

    const deployer = createDeployerComponent(components)
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

    const deployer = createDeployerComponent(components)
    await deployer.scheduleEntityDeployment(mockEntity, mockServers)

    expect(metricsMock.increment).toHaveBeenCalledWith('entity_deployment_failure', {
      entityType: mockEntity.entityType
    })
    expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
  })
})
