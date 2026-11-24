export class InvalidWorldsChangesConfigError extends Error {
  constructor(reason: string) {
    super(`Invalid worlds change relay configuration: ${reason}`)
    this.name = 'InvalidWorldsChangesConfigError'
  }
}

export class InvalidStoredCursorError extends Error {
  constructor(public readonly key: string) {
    super(`Stored worlds changes cursor ${key} is not a valid cursor`)
    this.name = 'InvalidStoredCursorError'
  }
}

export class WorldsChangesSourceMismatchError extends Error {
  constructor(public readonly cursor: string, public readonly origin: string) {
    super(`Deployment at ${cursor} has contentServerUrls[0] origin ${origin}, not the feed source`)
    this.name = 'WorldsChangesSourceMismatchError'
  }
}
