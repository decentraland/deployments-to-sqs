import {
  isAllowedContentServerUrl,
  isValidEntityId,
  parseAllowedContentServerHosts
} from '../../../src/logic/validation'

describe('when parsing the ALLOWED_CONTENT_SERVER_HOSTS value', () => {
  let result: Set<string>

  describe('and the value is undefined', () => {
    beforeEach(() => {
      result = parseAllowedContentServerHosts(undefined)
    })

    it('should produce an empty set, since there is no built-in default', () => {
      expect(result.size).toBe(0)
    })
  })

  describe('and the value is an empty string', () => {
    beforeEach(() => {
      result = parseAllowedContentServerHosts('')
    })

    it('should produce an empty set', () => {
      expect(result.size).toBe(0)
    })
  })

  describe('and the value is a comma-separated list of bare hostnames', () => {
    beforeEach(() => {
      result = parseAllowedContentServerHosts('peer.example.org, peer-2.example.org')
    })

    it('should trim each entry and return the configured hosts', () => {
      expect(result).toEqual(new Set(['peer.example.org', 'peer-2.example.org']))
    })
  })

  describe('and an entry is a full URL rather than a bare host', () => {
    beforeEach(() => {
      result = parseAllowedContentServerHosts('https://peer.example.org/content')
    })

    it('should normalize the entry down to its hostname', () => {
      expect(result).toEqual(new Set(['peer.example.org']))
    })
  })

  describe('and the value is uppercased', () => {
    beforeEach(() => {
      result = parseAllowedContentServerHosts('PEER.EXAMPLE.ORG')
    })

    it('should lowercase the host so matching is case-insensitive', () => {
      expect(result).toEqual(new Set(['peer.example.org']))
    })
  })

  describe('and the value contains only separators and whitespace', () => {
    beforeEach(() => {
      result = parseAllowedContentServerHosts('  , ,')
    })

    it('should produce an empty set', () => {
      expect(result.size).toBe(0)
    })
  })
})

describe('when validating a content-server URL against the allowlist', () => {
  let allowedHosts: Set<string>
  let result: boolean

  beforeEach(() => {
    allowedHosts = parseAllowedContentServerHosts('peer.decentraland.org')
  })

  describe('and the URL is an HTTPS host on the allowlist', () => {
    beforeEach(() => {
      result = isAllowedContentServerUrl('https://peer.decentraland.org/content', allowedHosts)
    })

    it('should accept it', () => {
      expect(result).toBe(true)
    })
  })

  describe('and the host is not on the allowlist', () => {
    beforeEach(() => {
      result = isAllowedContentServerUrl('https://evil.example.com/content', allowedHosts)
    })

    it('should reject it', () => {
      expect(result).toBe(false)
    })
  })

  describe('and the URL points at the cloud metadata IP', () => {
    beforeEach(() => {
      result = isAllowedContentServerUrl('https://169.254.169.254/latest/meta-data/', allowedHosts)
    })

    it('should reject it, since no IP literal is on the allowlist', () => {
      expect(result).toBe(false)
    })
  })

  describe('and an allowlisted host is requested over plain HTTP', () => {
    beforeEach(() => {
      result = isAllowedContentServerUrl('http://peer.decentraland.org/content', allowedHosts)
    })

    it('should reject it, since content servers must be HTTPS', () => {
      expect(result).toBe(false)
    })
  })

  describe('and the value is not a parseable URL', () => {
    beforeEach(() => {
      result = isAllowedContentServerUrl('not a url', allowedHosts)
    })

    it('should reject it', () => {
      expect(result).toBe(false)
    })
  })
})

describe('when validating an entityId', () => {
  let result: boolean

  describe('and it is a bare alphanumeric CID', () => {
    beforeEach(() => {
      result = isValidEntityId('bafkreiabc123')
    })

    it('should accept it', () => {
      expect(result).toBe(true)
    })
  })

  describe('and it contains path separators', () => {
    beforeEach(() => {
      result = isValidEntityId('../../etc/passwd')
    })

    it('should reject it', () => {
      expect(result).toBe(false)
    })
  })

  describe('and it contains a hyphen', () => {
    beforeEach(() => {
      result = isValidEntityId('bafy-scene')
    })

    it('should reject it', () => {
      expect(result).toBe(false)
    })
  })

  describe('and it is an empty string', () => {
    beforeEach(() => {
      result = isValidEntityId('')
    })

    it('should reject it', () => {
      expect(result).toBe(false)
    })
  })

  describe('and it is not a string', () => {
    beforeEach(() => {
      result = isValidEntityId(undefined)
    })

    it('should reject it', () => {
      expect(result).toBe(false)
    })
  })
})
