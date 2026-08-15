import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { IFetchComponent } from '@dcl/core-commons'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { EntityDownloaderComponent, SnsPublisherComponent } from '../../src/types'
import { IJobQueue } from '@dcl/snapshots-fetcher'

export const configMock: jest.Mocked<IConfigComponent> = {
  getNumber: jest.fn().mockResolvedValue(''),
  getString: jest.fn().mockResolvedValue(''),
  requireNumber: jest.fn().mockResolvedValue('a,b,c'),
  // main() validates CONTENT_SERVER_URLS against ALLOWED_CONTENT_SERVER_HOSTS at startup
  // (the SSRF allowlist guard) and would otherwise throw, so both keys resolve to
  // matching catalyst values here. Other keys keep the generic placeholder value.
  requireString: jest.fn().mockImplementation(async (key: string) => {
    if (key === 'CONTENT_SERVER_URLS') return 'https://peer.decentraland.org/content'
    if (key === 'ALLOWED_CONTENT_SERVER_HOSTS') return 'peer.decentraland.org'
    return 'a,b,c'
  })
}

export const metricsMock: jest.Mocked<any> = {
  increment: jest.fn(),
  decrement: jest.fn(),
  observe: jest.fn()
}

export const logsMock: jest.Mocked<ILoggerComponent> = {
  getLogger: jest.fn().mockReturnValue({
    log: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  })
}

export const fetcherMock: jest.Mocked<IFetchComponent> = {
  fetch: jest.fn()
}

export const storageMock: jest.Mocked<IContentStorageComponent> = {
  storeStream: jest.fn(),
  storeStreamAndCompress: jest.fn(),
  delete: jest.fn(),
  retrieve: jest.fn(),
  fileInfo: jest.fn(),
  fileInfoMultiple: jest.fn(),
  exist: jest.fn(),
  existMultiple: jest.fn(),
  allFileIds: jest.fn()
}

export const downloadQueueMock: jest.Mocked<IJobQueue> = {
  scheduleJob: jest.fn(),
  onSizeLessThan: jest.fn(),
  scheduleJobWithRetries: jest.fn(),
  scheduleJobWithPriority: jest.fn(),
  onIdle: jest.fn()
}

export const snsPublisherMock: jest.Mocked<SnsPublisherComponent> = {
  publishMessage: jest.fn()
}

export const entityDownloaderMock: jest.Mocked<EntityDownloaderComponent> = {
  downloadEntity: jest.fn()
}
