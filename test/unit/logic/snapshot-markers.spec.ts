import { ParsedSnapshotHashes, parseSnapshotHashes, snapshotMarkerKey } from '../../../src/logic/snapshot-markers'

describe('when building the marker key of a snapshot', () => {
  let key: string

  beforeEach(() => {
    key = snapshotMarkerKey('bafyabc')
  })

  it('should use the key the synchronizer reads', () => {
    expect(key).toBe('stored-snapshot-bafyabc')
  })
})

describe('when parsing a /snapshots response', () => {
  let body: unknown
  const timeRange = { initTimestamp: 0, endTimestamp: 1 }

  it('rejects incomplete metadata even when its hash could be marked', () => {
    const hash = 'bafyone'
    const tooFarAhead = Date.now() + 2 * 24 * 60 * 60 * 1000
    const invalidEntries = [
      { hash },
      { hash, timeRange: { initTimestamp: 1, endTimestamp: 0 } },
      { hash, timeRange: { initTimestamp: -1, endTimestamp: 0 } },
      { hash, timeRange: { initTimestamp: 0, endTimestamp: 1.5 } },
      { hash, timeRange: { initTimestamp: 0, endTimestamp: tooFarAhead } },
      { hash, timeRange, replacedSnapshotHashes: null },
      { hash, timeRange, replacedSnapshotHashes: ['../invalid'] },
      { hash, timeRange, replacedSnapshotHashes: Array(1001).fill(hash) }
    ]
    const valid = { hash, timeRange, replacedSnapshotHashes: Array(1000).fill('older') }
    expect(parseSnapshotHashes([valid, ...invalidEntries])).toEqual({ hashes: [hash], invalid: invalidEntries.length })
  })

  describe('and the body is not an array', () => {
    beforeEach(() => {
      body = { hash: 'bafyabc' }
    })

    it('should throw an invalid response error', () => {
      expect(() => parseSnapshotHashes(body)).toThrow('Invalid /snapshots response: expected an array')
    })
  })

  describe('and it mixes valid, duplicated and invalid entries', () => {
    let result: ParsedSnapshotHashes

    beforeEach(() => {
      body = [
        { hash: 'bafyone', timeRange },
        { hash: 'bafytwo', timeRange },
        { hash: 'bafyone', timeRange },
        { hash: '../escape' },
        { hash: 'a'.repeat(129) },
        { hash: 42 },
        {},
        null,
        'bafythree'
      ]
      result = parseSnapshotHashes(body)
    })

    it('should return each valid hash once, in response order', () => {
      expect(result.hashes).toEqual(['bafyone', 'bafytwo'])
    })

    it('should count the entries without a valid hash', () => {
      expect(result.invalid).toBe(6)
    })
  })
})
