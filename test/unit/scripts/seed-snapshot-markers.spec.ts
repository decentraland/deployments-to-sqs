import { Readable } from 'stream'
import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import {
  fetchSnapshotHashes,
  formatReport,
  parseSeedArgs,
  SeedOptions,
  seedSnapshotMarkers,
  UsageError
} from '../../../src/scripts/seed-snapshot-markers'
import { snapshotMarkerKey } from '../../../src/logic/snapshot-markers'

describe('when parsing the seed script arguments', () => {
  let argv: string[]

  describe('and a URL and a bucket are given', () => {
    beforeEach(() => {
      argv = ['https://dcl.dev/content/', '--bucket', 'a-bucket']
    })

    it('should default to a dry run and strip the trailing slash', () => {
      expect(parseSeedArgs(argv)).toEqual({
        contentServerUrl: 'https://dcl.dev/content',
        bucket: 'a-bucket',
        folder: undefined,
        apply: false
      })
    })
  })

  describe('and --apply is given', () => {
    beforeEach(() => {
      argv = ['https://dcl.dev/content', '--folder', '/tmp/x', '--apply']
    })

    it('should enable writing', () => {
      expect(parseSeedArgs(argv).apply).toBe(true)
    })
  })

  describe.each([
    ['no target', ['https://dcl.dev/content']],
    ['both targets', ['https://dcl.dev/content', '--bucket', 'b', '--folder', 'f']],
    ['no URL', ['--bucket', 'b']],
    ['a plain http URL', ['http://dcl.dev/content', '--bucket', 'b']],
    ['an unparseable URL', ['not a url', '--bucket', 'b']],
    ['an unknown flag', ['https://dcl.dev/content', '--bucket', 'b', '--force']]
  ])('and the arguments have %s', (_name, args) => {
    beforeEach(() => {
      argv = args
    })

    it('should throw a usage error', () => {
      expect(() => parseSeedArgs(argv)).toThrow(UsageError)
    })
  })

  describe('and the URL is plain http on localhost', () => {
    beforeEach(() => {
      argv = ['http://localhost:6969/content', '--folder', '/tmp/x']
    })

    it('should accept it for local rehearsals', () => {
      expect(parseSeedArgs(argv).contentServerUrl).toBe('http://localhost:6969/content')
    })
  })
})

describe('when fetching the snapshot hashes', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn()
  })

  describe('and the server answers with snapshots', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ hash: 'bafyone' }, { hash: '../x' }])))
    })

    it('should request /snapshots and return the valid hashes', async () => {
      await expect(fetchSnapshotHashes(fetchMock, 'https://dcl.dev/content')).resolves.toEqual({
        hashes: ['bafyone'],
        invalid: 1
      })
      expect(fetchMock).toHaveBeenCalledWith('https://dcl.dev/content/snapshots', expect.anything())
    })
  })

  describe('and the server answers with an error status', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }))
    })

    it('should throw with the status', async () => {
      await expect(fetchSnapshotHashes(fetchMock, 'https://dcl.dev/content')).rejects.toThrow('status: 503')
    })
  })

  describe('and the server answers with something other than JSON', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(new Response('<html>'))
    })

    it('should throw a not-JSON error', async () => {
      await expect(fetchSnapshotHashes(fetchMock, 'https://dcl.dev/content')).rejects.toThrow('did not return JSON')
    })
  })
})

describe('when seeding the snapshot markers', () => {
  let storage: IContentStorageComponent
  let hashes: string[]

  beforeEach(async () => {
    storage = createInMemoryStorage()
    await storage.storeStream(snapshotMarkerKey('bafyold'), Readable.from([]))
    hashes = ['bafyold', 'bafynew']
  })

  describe('and it is a dry run', () => {
    let result: Awaited<ReturnType<typeof seedSnapshotMarkers>>

    beforeEach(async () => {
      result = await seedSnapshotMarkers(storage, hashes, false)
    })

    it('should report the existing and missing markers', () => {
      expect(result).toEqual({ existing: ['bafyold'], missing: ['bafynew'], written: [], unconfirmed: [] })
    })

    it('should not write any marker', async () => {
      expect(await storage.exist(snapshotMarkerKey('bafynew'))).toBe(false)
    })
  })

  describe('and --apply is given', () => {
    let result: Awaited<ReturnType<typeof seedSnapshotMarkers>>

    beforeEach(async () => {
      result = await seedSnapshotMarkers(storage, hashes, true)
    })

    it('should write only the missing markers', () => {
      expect(result.written).toEqual(['bafynew'])
    })

    it('should leave every listed snapshot marked', async () => {
      expect(await storage.exist(snapshotMarkerKey('bafynew'))).toBe(true)
    })

    it('should report nothing unconfirmed', () => {
      expect(result.unconfirmed).toEqual([])
    })
  })

  describe('and a written marker cannot be read back', () => {
    let result: Awaited<ReturnType<typeof seedSnapshotMarkers>>
    let storageMock: jest.Mocked<Pick<IContentStorageComponent, 'exist' | 'storeStream'>>

    beforeEach(async () => {
      storageMock = { exist: jest.fn().mockResolvedValue(false), storeStream: jest.fn().mockResolvedValue(undefined) }
      result = await seedSnapshotMarkers(storageMock, ['bafynew'], true)
    })

    it('should report it as unconfirmed', () => {
      expect(result.unconfirmed).toEqual(['bafynew'])
    })
  })
})

describe('when formatting the report', () => {
  let options: SeedOptions
  let lines: string[]

  describe('and it is a dry run', () => {
    beforeEach(() => {
      options = { contentServerUrl: 'https://dcl.dev/content', folder: '/tmp/x', apply: false }
      lines = formatReport(options, {
        listed: 2,
        invalid: 0,
        existing: ['bafyold'],
        missing: ['bafynew'],
        written: [],
        unconfirmed: []
      })
    })

    it('should list what would be written and say nothing was written', () => {
      expect(lines).toEqual(
        expect.arrayContaining([
          '  exists  stored-snapshot-bafyold',
          '  would write stored-snapshot-bafynew',
          'Dry run: nothing was written. Re-run with --apply to write.'
        ])
      )
    })
  })

  describe('and some markers could not be confirmed', () => {
    beforeEach(() => {
      options = { contentServerUrl: 'https://dcl.dev/content', bucket: 'b', apply: true }
      lines = formatReport(options, {
        listed: 1,
        invalid: 0,
        existing: [],
        missing: ['bafynew'],
        written: ['bafynew'],
        unconfirmed: ['bafynew']
      })
    })

    it('should list the unconfirmed markers', () => {
      expect(lines).toEqual(expect.arrayContaining(['  missing stored-snapshot-bafynew']))
    })
  })
})
