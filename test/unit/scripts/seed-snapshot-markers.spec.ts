import { Readable } from 'stream'
import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import {
  assertAllowedContentServer,
  fetchSnapshotHashes,
  formatReport,
  listingProblem,
  main,
  parseSeedArgs,
  SeedOptions,
  seedSnapshotMarkers,
  UsageError
} from '../../../src/scripts/seed-snapshot-markers'
import { ParsedSnapshotHashes, snapshotMarkerKey } from '../../../src/logic/snapshot-markers'

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
    ['a URL with credentials', ['https://user:pass@dcl.dev/content', '--bucket', 'b']],
    ['a URL with a query', ['https://dcl.dev/content?x=1', '--bucket', 'b']],
    ['a URL with a fragment', ['https://dcl.dev/content#section', '--bucket', 'b']],
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

describe('when checking the content server against the allowlist', () => {
  let rawAllowedHosts: string | undefined
  let contentServerUrl: string

  it('only exempts loopback HTTP from an explicit allowlist', () => {
    expect(() => assertAllowedContentServer('http://other-host/content', 'dcl.dev')).toThrow(UsageError)
    expect(() => assertAllowedContentServer('http://[::1]:6969/content', 'dcl.dev')).not.toThrow()
  })

  it('requires a listed HTTPS source before writing shared bucket markers', () => {
    expect(() => assertAllowedContentServer('https://dcl.dev/content', undefined, true)).toThrow(
      /ALLOWED_CONTENT_SERVER_HOSTS/
    )
    expect(() => assertAllowedContentServer('http://localhost/content', 'localhost', true)).toThrow(/HTTPS/)
    expect(() => assertAllowedContentServer('https://dcl.dev/content', 'dcl.dev', true)).not.toThrow()
  })

  beforeEach(() => {
    contentServerUrl = 'https://dcl.dev/content'
  })

  describe('and ALLOWED_CONTENT_SERVER_HOSTS is not set', () => {
    beforeEach(() => {
      rawAllowedHosts = undefined
    })

    it('should accept any server', () => {
      expect(() => assertAllowedContentServer(contentServerUrl, rawAllowedHosts)).not.toThrow()
    })
  })

  describe('and the host is on ALLOWED_CONTENT_SERVER_HOSTS', () => {
    beforeEach(() => {
      rawAllowedHosts = 'peer.decentraland.org,dcl.dev'
    })

    it('should accept it', () => {
      expect(() => assertAllowedContentServer(contentServerUrl, rawAllowedHosts)).not.toThrow()
    })
  })

  describe('and the host is not on ALLOWED_CONTENT_SERVER_HOSTS', () => {
    beforeEach(() => {
      rawAllowedHosts = 'peer.decentraland.org'
    })

    it('should throw a usage error', () => {
      expect(() => assertAllowedContentServer(contentServerUrl, rawAllowedHosts)).toThrow(UsageError)
    })
  })
})

describe('when the CLI would write S3 markers without an exported allowlist', () => {
  it('should return a usage error before any network request', async () => {
    const env = jest.replaceProperty(process, 'env', { ...process.env, ALLOWED_CONTENT_SERVER_HOSTS: '' })
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'))
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      await expect(main(['https://seed-fixture.invalid/content', '--bucket', 'test', '--apply'])).resolves.toBe(2)
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ALLOWED_CONTENT_SERVER_HOSTS'))
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      env.restore()
      fetchSpy.mockRestore()
      stderr.mockRestore()
    }
  })
})

describe('when checking a snapshot listing', () => {
  let listing: ParsedSnapshotHashes
  let apply: boolean

  describe('and no valid snapshot is listed', () => {
    beforeEach(() => {
      listing = { hashes: [], invalid: 0 }
      apply = false
    })

    it('should report a problem even in a dry run', () => {
      expect(listingProblem(listing, apply)).toMatch(/no valid snapshots/)
    })
  })

  describe('and some entries are invalid', () => {
    beforeEach(() => {
      listing = { hashes: ['bafyone'], invalid: 1 }
    })

    describe('and it is a dry run', () => {
      beforeEach(() => {
        apply = false
      })

      it('should report no problem', () => {
        expect(listingProblem(listing, apply)).toBeUndefined()
      })
    })

    describe('and --apply is given', () => {
      beforeEach(() => {
        apply = true
      })

      it('should refuse to write', () => {
        expect(listingProblem(listing, apply)).toMatch(/refusing to write/)
      })
    })
  })

  describe('and every entry is valid', () => {
    beforeEach(() => {
      listing = { hashes: ['bafyone'], invalid: 0 }
      apply = true
    })

    it('should report no problem', () => {
      expect(listingProblem(listing, apply)).toBeUndefined()
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
      const listing = [{ hash: 'bafyone', timeRange: { initTimestamp: 0, endTimestamp: 1 } }, { hash: '../x' }]
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(listing)))
    })

    it('should request /snapshots and return the valid hashes', async () => {
      await expect(fetchSnapshotHashes(fetchMock, 'https://dcl.dev/content')).resolves.toEqual({
        hashes: ['bafyone'],
        invalid: 1
      })
      expect(fetchMock).toHaveBeenCalledWith('https://dcl.dev/content/snapshots', expect.anything())
    })

    it('should refuse to follow redirects', async () => {
      await fetchSnapshotHashes(fetchMock, 'https://dcl.dev/content')
      expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error' }))
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

    it('should keep the parse error as the cause', async () => {
      await expect(fetchSnapshotHashes(fetchMock, 'https://dcl.dev/content')).rejects.toHaveProperty(
        'cause',
        expect.objectContaining({ name: 'SyntaxError' })
      )
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
