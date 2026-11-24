import { downloadEntityAndContentFiles } from '@dcl/snapshots-fetcher'
import { AppComponents, EntityDownloadError, EntityDownloaderComponent } from '../../../src/types'
import { createEntityDownloaderComponent } from '../../../src/adapters/entity-downloader'
import { configMock, fetcherMock, logsMock, metricsMock, storageMock } from '../../mocks/components'
import { DeployableEntity } from '@dcl/snapshots-fetcher'

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
      1000,
      4
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
      entityType: mockEntity.entityType,
      retryable: 'true'
    })
    expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
  })

  describe('should handle non-retryable errors', () => {
    it('and mark the entity as deployed when the entity has the markAsDeployed defined', async () => {
      downloadEntityAndContentFilesMock.mockRejectedValueOnce(new Error('status: 404'))

      const downloader = await createEntityDownloaderComponent(components)
      await expect(downloader.downloadEntity(mockEntity, mockServers)).rejects.toThrow(EntityDownloadError)

      expect(metricsMock.increment).toHaveBeenCalledWith('entity_download_failure', {
        entityType: mockEntity.entityType,
        retryable: 'false'
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
        entityType: mockEntity.entityType,
        retryable: 'false'
      })
    })
  })

  describe('when a content file fails to download after the entity file was stored', () => {
    let downloader: EntityDownloaderComponent
    let callOrder: string[]

    beforeEach(async () => {
      callOrder = []
      storageMock.delete.mockImplementationOnce(async () => {
        callOrder.push('delete')
      })
      ;(mockEntity.markAsDeployed as jest.Mock).mockImplementationOnce(async () => {
        callOrder.push('markAsDeployed')
      })
      downloader = await createEntityDownloaderComponent(components)
    })

    describe('and the error is retryable', () => {
      beforeEach(async () => {
        downloadEntityAndContentFilesMock.mockRejectedValueOnce(new Error('status: 503'))
        await expect(downloader.downloadEntity(mockEntity, mockServers)).rejects.toThrow(EntityDownloadError)
      })

      it('should remove the stored entity file so the retry is not skipped', () => {
        expect(storageMock.delete).toHaveBeenCalledWith([mockEntity.entityId])
      })

      it('should not mark the entity as deployed', () => {
        expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
      })
    })

    describe('and the error is non-retryable', () => {
      beforeEach(async () => {
        downloadEntityAndContentFilesMock.mockRejectedValueOnce(new Error('status: 404'))
        await expect(downloader.downloadEntity(mockEntity, mockServers)).rejects.toThrow(EntityDownloadError)
      })

      it('should remove the stored entity file before marking the entity as deployed', () => {
        expect(callOrder).toEqual(['delete', 'markAsDeployed'])
      })
    })

    describe('and the content server rate-limits the request with a 429', () => {
      beforeEach(async () => {
        downloadEntityAndContentFilesMock.mockRejectedValueOnce(
          new Error('Invalid response from https://server1/content/contents/abc status: 429')
        )
        await expect(downloader.downloadEntity(mockEntity, mockServers)).rejects.toThrow(EntityDownloadError)
      })

      it('should not mark the entity as deployed, so it is retried', () => {
        expect(mockEntity.markAsDeployed).not.toHaveBeenCalled()
      })

      it('should record the failure as retryable', () => {
        expect(metricsMock.increment).toHaveBeenCalledWith('entity_download_failure', {
          entityType: mockEntity.entityType,
          retryable: 'true'
        })
      })
    })

    describe('and the stored bytes are not entity JSON but snapshots-fetcher kept them', () => {
      beforeEach(async () => {
        downloadEntityAndContentFilesMock.mockRejectedValueOnce(
          new Error(
            `Failed to parse the downloaded entity file for ${mockEntity.entityId}; the stored bytes match the ` +
              'content hash, so the local copy was kept. Cause: Unexpected token'
          )
        )
        await expect(downloader.downloadEntity(mockEntity, mockServers)).rejects.toThrow(EntityDownloadError)
      })

      it('should keep the stored file, which may be legitimate content', () => {
        expect(storageMock.delete).not.toHaveBeenCalled()
      })
    })

    describe('and the download rejects with a non-Error value', () => {
      beforeEach(async () => {
        downloadEntityAndContentFilesMock.mockRejectedValueOnce(undefined)
        await expect(downloader.downloadEntity(mockEntity, mockServers)).rejects.toThrow(EntityDownloadError)
      })

      it('should still remove the stored entity file', () => {
        expect(storageMock.delete).toHaveBeenCalledWith([mockEntity.entityId])
      })
    })

    describe('and removing the stored entity file fails', () => {
      let downloadError: unknown

      beforeEach(async () => {
        storageMock.delete.mockReset()
        storageMock.delete.mockRejectedValueOnce(new Error('S3 unavailable'))
        downloadEntityAndContentFilesMock.mockRejectedValueOnce(new Error('status: 404'))
        downloadError = await downloader.downloadEntity(mockEntity, mockServers).catch((error: unknown) => error)
      })

      it('should surface the original download error', () => {
        expect(downloadError).toEqual(expect.objectContaining({ name: 'EntityDownloadError', message: 'status: 404' }))
      })

      it('should log the removal failure', () => {
        expect(logsMock.getLogger('EntityDownloader').error).toHaveBeenCalledWith(
          'Failed to remove the stored entity file',
          expect.objectContaining({ entityId: mockEntity.entityId, error: 'S3 unavailable' })
        )
      })

      it('should still mark the entity as deployed', () => {
        expect(mockEntity.markAsDeployed).toHaveBeenCalled()
      })
    })
  })

  describe('when the entity downloads successfully', () => {
    beforeEach(async () => {
      downloadEntityAndContentFilesMock.mockResolvedValueOnce({ type: 'scene', metadata: {}, content: [] })
      const downloader = await createEntityDownloaderComponent(components)
      await downloader.downloadEntity(mockEntity, mockServers)
    })

    it('should keep the stored entity file', () => {
      expect(storageMock.delete).not.toHaveBeenCalled()
    })
  })
})
