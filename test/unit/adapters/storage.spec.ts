import { ContentItem, IContentStorageComponent } from '@dcl/catalyst-storage'
import { readdirSync } from 'fs'
import { tmpdir } from 'os'
import { Readable, Writable } from 'stream'
import { createResilientContentStorage } from '../../../src/adapters/storage'
import { logsMock, storageMock } from '../../mocks/components'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs')

const STAGING_PREFIX = 'content-stage-'

function listStagingFiles(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(STAGING_PREFIX))
}

async function waitForNoStagingFiles(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (listStagingFiles().length === 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('ResilientContentStorage', () => {
  let storage: IContentStorageComponent
  let innerStorage: jest.Mocked<IContentStorageComponent>

  beforeEach(() => {
    // `resetAllMocks` in afterEach also drops implementations set at module
    // load time (e.g. `logsMock.getLogger`'s return value), so we re-seed
    // the logger mock on every test.
    logsMock.getLogger.mockReturnValue({
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn()
    })
    innerStorage = storageMock
    storage = createResilientContentStorage({ logs: logsMock }, innerStorage)
  })

  afterEach(async () => {
    // `resetAllMocks` (vs `clearAllMocks`) also drops queued
    // `mockResolvedValueOnce` implementations, so no state leaks into
    // subsequent tests that share `storageMock`.
    jest.resetAllMocks()
    await waitForNoStagingFiles()
  })

  describe('when retrieving a file that does not exist', () => {
    beforeEach(() => {
      innerStorage.retrieve.mockResolvedValueOnce(undefined)
    })

    it('should return undefined', async () => {
      await expect(storage.retrieve('missing')).resolves.toBeUndefined()
    })
  })

  describe('when retrieving a file that exists', () => {
    describe('and the stream completes successfully', () => {
      let innerItem: ContentItem

      beforeEach(() => {
        innerItem = {
          encoding: null,
          size: 11,
          asStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from('hello world'))),
          asRawStream: jest.fn()
        }
        innerStorage.retrieve.mockResolvedValueOnce(innerItem)
      })

      it('should return a read stream whose contents match the original body', async () => {
        const item = await storage.retrieve('ok')
        const stream = await item!.asStream()

        const chunks: Buffer[] = []
        for await (const chunk of stream) {
          chunks.push(chunk as Buffer)
        }

        expect(Buffer.concat(chunks).toString()).toBe('hello world')
      })

      it('should delete the staged file after the read stream closes', async () => {
        const stagingFilesBefore = listStagingFiles().length
        const item = await storage.retrieve('ok')
        const stream = await item!.asStream()

        for await (const _chunk of stream) {
          // drain
        }

        await waitForNoStagingFiles()
        expect(listStagingFiles().length).toBe(stagingFilesBefore)
      })
    })

    describe('and the local write stream fails (e.g. disk full)', () => {
      let innerItem: ContentItem
      let sourceStream: Readable
      let createWriteStreamSpy: jest.SpyInstance

      beforeEach(() => {
        sourceStream = Readable.from(Buffer.from('some content'))

        const failingWrite = new Writable({
          write(_chunk, _encoding, callback) {
            callback(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
          }
        })
        createWriteStreamSpy = jest.spyOn(fs, 'createWriteStream').mockReturnValueOnce(failingWrite as any)

        innerItem = {
          encoding: null,
          size: 12,
          asStream: jest.fn().mockResolvedValue(sourceStream),
          asRawStream: jest.fn()
        }
        innerStorage.retrieve.mockResolvedValueOnce(innerItem)
      })

      afterEach(() => {
        createWriteStreamSpy.mockRestore()
      })

      it('should reject asStream with the write-side error', async () => {
        const item = await storage.retrieve('disk-full')
        await expect(item!.asStream()).rejects.toThrow('disk full')
      })
    })

    describe('and the underlying stream aborts mid-download', () => {
      let innerItem: ContentItem
      let erroringStream: Readable

      beforeEach(() => {
        let emittedPartial = false
        erroringStream = new Readable({
          read() {
            if (!emittedPartial) {
              emittedPartial = true
              this.push(Buffer.from('partial'))
              process.nextTick(() => this.destroy(new Error('aborted')))
            }
          }
        })
        innerItem = {
          encoding: null,
          size: 100,
          asStream: jest.fn().mockResolvedValue(erroringStream),
          asRawStream: jest.fn()
        }
        innerStorage.retrieve.mockResolvedValueOnce(innerItem)
      })

      it('should reject asStream with the underlying error instead of emitting it on the returned stream', async () => {
        const item = await storage.retrieve('aborted-file')
        await expect(item!.asStream()).rejects.toThrow('aborted')
      })

      it('should not leak the staged file after the abort', async () => {
        const stagingFilesBefore = listStagingFiles().length
        const item = await storage.retrieve('aborted-file')
        await expect(item!.asStream()).rejects.toThrow('aborted')

        await waitForNoStagingFiles()
        expect(listStagingFiles().length).toBe(stagingFilesBefore)
      })
    })
  })

  describe('when calling non-retrieve methods', () => {
    beforeEach(() => {
      innerStorage.exist.mockResolvedValueOnce(true)
    })

    it('should forward the call to the inner storage', async () => {
      await expect(storage.exist('some-id')).resolves.toBe(true)
      expect(innerStorage.exist).toHaveBeenCalledWith('some-id')
    })
  })
})
