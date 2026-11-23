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
