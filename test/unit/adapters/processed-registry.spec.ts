import { createProcessedRegistryComponent } from '../../../src/adapters/processed-registry'
import { ProcessedRegistryComponent } from '../../../src/types'
import { logsMock, pgMock, storageMock } from '../../mocks/components'

const rows = <T>(values: T[]) => ({ rows: values, rowCount: values.length })

describe('ProcessedRegistryComponent', () => {
  let registry: ProcessedRegistryComponent

  beforeEach(() => {
    logsMock.getLogger.mockReturnValue({
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn()
    })
    registry = createProcessedRegistryComponent({ pg: pgMock, storage: storageMock, logs: logsMock })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when checking whether an entity was published', () => {
    describe('and it has a row stamped with published_at', () => {
      let result: boolean

      beforeEach(async () => {
        pgMock.query.mockResolvedValueOnce(rows([{ published_at: new Date() }]))
        result = await registry.wasEntityPublished('an-entity')
      })

      it('should report it as published', () => {
        expect(result).toBe(true)
      })

      it('should not consult storage, since the table already answered', () => {
        expect(storageMock.exist).not.toHaveBeenCalled()
      })
    })

    describe('and it has a row with no published_at, because a publish failed', () => {
      let result: boolean

      beforeEach(async () => {
        pgMock.query.mockResolvedValueOnce(rows([{ published_at: null }]))
        // The object is present — the download succeeded before the publish failed. This is the
        // exact case the old presence-based dedup got wrong.
        storageMock.exist.mockResolvedValue(true)
        result = await registry.wasEntityPublished('an-entity')
      })

      it('should report it as NOT published, so it is retried', () => {
        expect(result).toBe(false)
      })

      it('should not let a stored object override the row', () => {
        expect(storageMock.exist).not.toHaveBeenCalled()
      })
    })

    describe('and it has no row but an object exists, i.e. it predates the table', () => {
      let result: boolean

      beforeEach(async () => {
        pgMock.query.mockResolvedValueOnce(rows([]))
        storageMock.exist.mockResolvedValue(true)
        result = await registry.wasEntityPublished('a-legacy-entity')
      })

      it('should report it as published, so history is not replayed', () => {
        expect(result).toBe(true)
      })
    })

    describe('and it has neither a row nor an object', () => {
      let result: boolean

      beforeEach(async () => {
        pgMock.query.mockResolvedValueOnce(rows([]))
        storageMock.exist.mockResolvedValue(false)
        result = await registry.wasEntityPublished('a-new-entity')
      })

      it('should report it as not published', () => {
        expect(result).toBe(false)
      })
    })
  })

  describe('when filtering processed snapshots', () => {
    describe('and some are in the table and some only in storage', () => {
      let result: Set<string>

      beforeEach(async () => {
        pgMock.query.mockResolvedValueOnce(rows([{ snapshot_hash: 'in-table' }]))
        storageMock.exist.mockImplementation(async (key: string) => key.endsWith('in-storage'))
        result = await registry.filterProcessedSnapshots(['in-table', 'in-storage', 'unprocessed'])
      })

      it('should report both the table and the storage hits as processed', () => {
        expect(result).toEqual(new Set(['in-table', 'in-storage']))
      })

      it('should query the table once for the whole batch rather than per hash', () => {
        expect(pgMock.query).toHaveBeenCalledTimes(1)
      })

      it('should only fall back to storage for hashes the table did not answer', () => {
        expect(storageMock.exist).toHaveBeenCalledTimes(2)
      })
    })

    describe('and the batch is empty', () => {
      let result: Set<string>

      beforeEach(async () => {
        result = await registry.filterProcessedSnapshots([])
      })

      it('should return nothing without touching the database', () => {
        expect(result).toEqual(new Set())
        expect(pgMock.query).not.toHaveBeenCalled()
      })
    })
  })

  describe('when counting entities that were claimed but never published', () => {
    let count: number

    beforeEach(async () => {
      pgMock.query.mockResolvedValueOnce(rows([{ count: '42' }]))
      count = await registry.countUnpublishedEntities()
    })

    it('should return the count as a number, not the string postgres returns', () => {
      expect(count).toBe(42)
    })
  })

  describe('when reporting the unpublished count and the query fails', () => {
    beforeEach(() => {
      pgMock.query.mockRejectedValue(new Error('database is down'))
    })

    it('should not throw, since reporting must never block startup', async () => {
      await expect(registry.reportUnpublishedEntities()).resolves.toBeUndefined()
    })
  })
})
