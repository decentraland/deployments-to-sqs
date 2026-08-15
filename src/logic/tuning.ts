import { IConfigComponent } from '@well-known-components/interfaces'

/**
 * Reads a positive-integer tuning knob. Throws on an invalid value rather than falling back, since
 * a knob that silently resolves to 0 or NaN would stall the pipeline or remove a bound. Only an
 * unset value takes the default.
 */
export async function getPositiveInt(config: IConfigComponent, key: string, defaultValue: number): Promise<number> {
  const raw = await config.getString(key)

  if (raw === undefined || raw === null || raw.trim() === '') {
    return defaultValue
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be an integer >= 1, got "${raw}"`)
  }

  return parsed
}
