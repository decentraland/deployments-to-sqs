import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent, createStatusCheckComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from './adapters/fetch'
import { createMetricsComponent, instrumentHttpServerWithMetrics } from '@well-known-components/metrics'
import { AppComponents, GlobalContext, SnsComponent } from './types'
import { metricDeclarations } from './metrics'
import { createJobQueue } from '@dcl/snapshots-fetcher/dist/job-queue-port'
import { createSynchronizer } from '@dcl/snapshots-fetcher'
import { ISnapshotStorageComponent, IProcessedSnapshotStorageComponent } from '@dcl/snapshots-fetcher/dist/types'
import { createDeployerComponent } from './adapters/deployer'
import {
  createAwsS3BasedFileSystemContentStorage,
  createFolderBasedFileSystemContentStorage,
  createFsComponent
} from '@dcl/catalyst-storage'
import { Readable } from 'stream'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const server = await createServerComponent<GlobalContext>({ config, logs }, {})
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()

  await instrumentHttpServerWithMetrics({ config, metrics, server })

  const fs = createFsComponent()

  const downloadsFolder = 'content'

  const bucket = await config.getString('BUCKET')
  const snsArn = await config.getString('SNS_ARN')

  const storage = bucket
    ? await createAwsS3BasedFileSystemContentStorage({ fs, config }, bucket)
    : await createFolderBasedFileSystemContentStorage({ fs }, downloadsFolder)

  const downloadQueue = createJobQueue({
    autoStart: true,
    concurrency: 5,
    timeout: 100000
  })

  const sns: SnsComponent = {
    arn: snsArn
  }

  const deployer = createDeployerComponent({ storage, downloadQueue, fetch, logs, metrics, sns })

  const key = (hash: string) => `stored-snapshot-${hash}`

  const snapshotStorageLogger = logs.getLogger('ISnapshotStorageComponent')

  const snapshotStorage: ISnapshotStorageComponent & IProcessedSnapshotStorageComponent = {
    async has(snapshotHash: string) {
      const exists = await storage.exist(key(snapshotHash))
      snapshotStorageLogger.debug('HasSnapshot', { exists: exists ? 'true' : 'false', snapshotHash })
      return exists
    },
    async saveProcessed(snapshotHash) {
      snapshotStorageLogger.debug('SaveProcessed', { snapshotHash })
      await storage.storeStream(key(snapshotHash), Readable.from([]))
    },
    async processedFrom(snapshotHashes) {
      snapshotStorageLogger.debug('ProcessedFrom', { cids: snapshotHashes.join(',') })
      const ret = new Set<string>()
      for (const hash of snapshotHashes) {
        if (await storage.exist(key(hash))) {
          ret.add(hash)
        }
      }
      return ret
    }
  }

  const synchronizer = await createSynchronizer(
    {
      logs,
      downloadQueue,
      fetcher: fetch,
      metrics,
      deployer,
      storage,
      processedSnapshotStorage: snapshotStorage,
      snapshotStorage
    },
    {
      // reconnection options
      bootstrapReconnection: {
        reconnectTime: 5000 /* five second */,
        reconnectRetryTimeExponent: 1.5,
        maxReconnectionTime: 3_600_000 /* one hour */
      },
      syncingReconnection: {
        reconnectTime: 1000 /* one second */,
        reconnectRetryTimeExponent: 1.2,
        maxReconnectionTime: 3_600_000 /* one hour */
      },

      // snapshot stream options
      tmpDownloadFolder: downloadsFolder,

      // download entities retry
      requestMaxRetries: 10,
      requestRetryWaitTime: 5000,

      // pointer chagnes stream options
      // time between every poll to /pointer-changes
      pointerChangesWaitTime: 5000
    }
  )

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    storage,
    fs,
    downloadQueue,
    synchronizer,
    deployer,
    sns
  }
}
