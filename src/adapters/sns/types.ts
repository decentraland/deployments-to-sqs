export enum SnsType {
  DEPLOYMENT = 'deployment',
  EVENT = 'event'
}

export type SnsOptions = {
  type: SnsType
}
