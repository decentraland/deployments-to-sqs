export class WorldsChangesUrlNotAllowedError extends Error {
  constructor(public readonly url: string) {
    super(`Worlds changes URL is not an allowlisted HTTPS URL: ${url}`)
    this.name = 'WorldsChangesUrlNotAllowedError'
  }
}

export class WorldsChangesRequestError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`Worlds changes request to ${url} failed: ${reason}`)
    this.name = 'WorldsChangesRequestError'
  }
}

export class WorldsChangesHttpError extends Error {
  constructor(public readonly url: string, public readonly status: number) {
    super(`Worlds changes request to ${url} answered ${status}`)
    this.name = 'WorldsChangesHttpError'
  }
}

export class WorldsChangesResponseTooLargeError extends Error {
  constructor(public readonly url: string, public readonly maxBytes: number) {
    super(`Worlds changes response from ${url} exceeds ${maxBytes} bytes`)
    this.name = 'WorldsChangesResponseTooLargeError'
  }
}

export class WorldsChangesInvalidResponseError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`Worlds changes response from ${url} is invalid: ${reason}`)
    this.name = 'WorldsChangesInvalidResponseError'
  }
}
