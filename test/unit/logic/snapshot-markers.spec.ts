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
        { hash: 'bafyone' },
        { hash: 'bafytwo' },
        { hash: 'bafyone' },
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
