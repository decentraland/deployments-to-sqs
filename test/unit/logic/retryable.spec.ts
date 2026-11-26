import { isNonRetryableErrorMessage } from '../../../src/logic/retryable'

describe('when classifying an error message as non-retryable', () => {
  describe.each(['status: 400', 'status: 403', 'status: 404', 'Invalid response from https://a/b status: 410'])(
    'and the message carries the client error "%s"',
    (message) => {
      let result: boolean

      beforeEach(() => {
        result = isNonRetryableErrorMessage(message)
      })

      it('should report it as non-retryable', () => {
        expect(result).toBe(true)
      })
    }
  )

  describe.each(['status: 429', 'status: 500', 'status: 503', 'Network Error', '', undefined])(
    'and the message is %p',
    (message) => {
      let result: boolean

      beforeEach(() => {
        result = isNonRetryableErrorMessage(message)
      })

      it('should report it as retryable', () => {
        expect(result).toBe(false)
      })
    }
  )
})
