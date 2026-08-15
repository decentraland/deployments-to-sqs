import { IConfigComponent } from '@well-known-components/interfaces'
import { getPositiveInt } from '../../../src/logic/tuning'

describe('getPositiveInt', () => {
  let config: jest.Mocked<IConfigComponent>

  beforeEach(() => {
    config = {
      getString: jest.fn(),
      getNumber: jest.fn(),
      requireString: jest.fn(),
      requireNumber: jest.fn()
    }
  })

  describe('when the variable is not set', () => {
    it.each([[undefined], [null], [''], ['   ']])('should fall back to the default for %p', async (raw) => {
      config.getString.mockResolvedValue(raw as any)

      await expect(getPositiveInt(config, 'SOME_KNOB', 15)).resolves.toBe(15)
    })
  })

  describe('when the variable holds a positive integer', () => {
    let value: number

    beforeEach(async () => {
      config.getString.mockResolvedValue('40')
      value = await getPositiveInt(config, 'SOME_KNOB', 15)
    })

    it('should use the configured value rather than the default', () => {
      expect(value).toBe(40)
    })
  })

  describe('when the variable holds a value that would silently break a bound', () => {
    it.each([['0'], ['-1'], ['1.5'], ['abc'], ['1e3x'], ['Infinity']])(
      'should throw for %p rather than fall back',
      async (raw) => {
        config.getString.mockResolvedValue(raw)

        await expect(getPositiveInt(config, 'SOME_KNOB', 15)).rejects.toThrow('SOME_KNOB must be an integer >= 1')
      }
    )
  })

  describe('when the variable has surrounding whitespace', () => {
    it('should still parse it, since env files commonly carry trailing spaces', async () => {
      config.getString.mockResolvedValue(' 25 ')

      await expect(getPositiveInt(config, 'SOME_KNOB', 15)).resolves.toBe(25)
    })
  })
})
