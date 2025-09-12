import { downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { AppComponents, EntityDownloadError } from '../../../src/types'
import { createEntityDownloaderComponent } from '../../../src/adapters/entity-downloader'
import { configMock, fetcherMock, logsMock, metricsMock, storageMock } from '../../mocks/components'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'

jest.mock('@dcl/snapshots-fetcher', () => ({
  downloadEntityAndContentFiles: jest.fn()
}))

describe('EntityDownloaderComponent', () => {
  let components: jest.Mocked<Pick<AppComponents, 'config' | 'logs' | 'storage' | 'fetch' | 'metrics'>>

  let mockEntity: DeployableEntity
  let mockServers: string[]

  let downloadEntityAndContentFilesMock: jest.Mock

  beforeEach(() => {
    components = {
      config: configMock,
      logs: logsMock,
      storage: storageMock,
      fetch: fetcherMock,
      metrics: metricsMock
    }

    downloadEntityAndContentFilesMock = downloadEntityAndContentFiles as jest.Mock

    mockEntity = {
      entityId: '123',
      entityType: 'scene',
      markAsDeployed: jest.fn(),
      pointers: ['pointer1'],
      authChain: [],
      entityTimestamp: Date.now(),
      localTimestamp: Date.now()
    }

    mockServers = ['server1', 'server2']
  })

  it('should download entity successfully', async () => {
    downloadEntityAndContentFilesMock.mockResolvedValueOnce({
      type: 'scene',
      metadata: { test: 'metadata' },
      content: []
    })

    const downloader = await createEntityDownloaderComponent(components)
    await downloader.downloadEntity(mockEntity, mockServers)

    expect(downloadEntityAndContentFilesMock).toHaveBeenCalledWith(
      { ...components, fetcher: components.fetch },
      mockEntity.entityId,
      mockServers,
      new Map(),
      'content',
      10,
      1000
    )
    expect(metricsMock.increment).toHaveBeenCalledWith('entity_download_success', {
      entityType: mockEntity.entityType
    })
    expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
  })

  it('should handle retryable error and not mark the entity as deployed', async () => {
    downloadEntityAndContentFilesMock.mockRejectedValueOnce(new Error('status: 500'))

    const downloader = await createEntityDownloaderComponent(components)
    await expect(downloader.downloadEntity(mockEntity, mockServers)).rejects.toThrow(EntityDownloadError)

    expect(metricsMock.increment).toHaveBeenCalledWith('entity_download_failure', {
      entityType: mockEntity.entityType
    })
    expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
  })

  describe('should handle non-retryable errors', () => {
    it('and mark the entity as deployed when the entity has the markAsDeployed defined', async () => {
      downloadEntityAndContentFilesMock.mockRejectedValueOnce(new Error('status: 404'))

      const downloader = await createEntityDownloaderComponent(components)
      await expect(downloader.downloadEntity(mockEntity, mockServers)).rejects.toThrow(EntityDownloadError)

      expect(metricsMock.increment).toHaveBeenCalledWith('entity_download_failure', {
        entityType: mockEntity.entityType
      })
      expect(mockEntity.markAsDeployed).toHaveBeenCalled()
    })

    it('and do nothing if the markAsDeployed is not defined', async () => {
      downloadEntityAndContentFilesMock.mockRejectedValueOnce(new Error('status: 404'))

      const mockEntityWithoutMarkAsDeployed = { ...mockEntity, markAsDeployed: undefined }

      const downloader = await createEntityDownloaderComponent(components)
      await expect(downloader.downloadEntity(mockEntityWithoutMarkAsDeployed, mockServers)).rejects.toThrow(
        EntityDownloadError
      )

      expect(metricsMock.increment).toHaveBeenCalledWith('entity_download_failure', {
        entityType: mockEntity.entityType
      })
    })
  })
})
