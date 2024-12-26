import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { IConfigComponent, IFetchComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { EntityDownloaderComponent, SnsPublisherComponent } from '../../src/types'
import { IJobQueue } from '@dcl/snapshots-fetcher/dist/job-queue-port'

export const configMock: jest.Mocked<IConfigComponent> = {
  getNumber: jest.fn().mockResolvedValue(''),
  getString: jest.fn().mockResolvedValue(''),
  requireNumber: jest.fn().mockResolvedValue('a,b,c'),
  requireString: jest.fn().mockResolvedValue('a,b,c')
}

export const metricsMock: jest.Mocked<any> = {
  increment: jest.fn()
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
