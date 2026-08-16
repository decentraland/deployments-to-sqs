import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import {
  createServerComponent,
  createStatusCheckComponent,
  instrumentHttpServerWithPromClientRegistry
} from '@dcl/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from '@dcl/fetch-component'
import { createMetricsComponent } from '@dcl/metrics'
import { createPgComponent } from '@dcl/pg-component'
import { resolve } from 'path'
import { AppComponents, GlobalContext } from './types'
import { getPositiveInt } from './logic/tuning'
import { metricDeclarations } from './metrics'
import {
  createJobQueue,
  createSynchronizer,
  ISnapshotStorageComponent,
  IProcessedSnapshotStorageComponent
} from '@dcl/snapshots-fetcher'
import { createDeployerComponent } from './adapters/deployer'
import {
  createAwsS3BasedFileSystemContentStorage,
  createFolderBasedFileSystemContentStorage,
  createFsComponent
} from '@dcl/catalyst-storage'
import { createEntityDownloaderComponent } from './adapters/entity-downloader'
import { createSnsDeploymentPublisherComponent, createSnsEventPublisherComponent } from './adapters/sns'
import { createResilientContentStorage } from './adapters/storage'
import { createProcessedRegistryComponent } from './adapters/processed-registry'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const server = await createServerComponent<GlobalContext>({ config, logs }, {})
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = createFetchComponent()

  await instrumentHttpServerWithPromClientRegistry({ config, metrics, server, registry: metrics.registry! })

  const fs = createFsComponent()

  const downloadsFolder = 'content'

  const bucket = await config.getString('BUCKET')

  const rawStorage = bucket
    ? await createAwsS3BasedFileSystemContentStorage({ config, logs }, bucket)
    : await createFolderBasedFileSystemContentStorage({ fs, logs }, downloadsFolder)

  const storage = createResilientContentStorage({ logs }, rawStorage)

  const pg = await createPgComponent(
    { logs, config, metrics },
    {
      migration: {
        dir: resolve(__dirname, 'migrations'),
        migrationsTable: 'pgmigrations',
        ignorePattern: '.*\\.map',
        direction: 'up'
      }
    }
  )

  const processedRegistry = createProcessedRegistryComponent({ pg, storage, logs })

  // Separate queues so `deployer.onIdle()` — awaited at every poll of every server — drains only
  // the deployer's work, and /snapshots fetches never queue behind an entity backlog.
  const downloadQueue = createJobQueue({
    autoStart: true,
    concurrency: await getPositiveInt(config, 'DOWNLOAD_QUEUE_CONCURRENCY', 15),
    timeout: await getPositiveInt(config, 'DOWNLOAD_QUEUE_TIMEOUT_MS', 100000)
  })

  // Sized for snapshotDeployments (default 10) plus the per-server /snapshots fetches.
  const synchronizerQueue = createJobQueue({
    autoStart: true,
    concurrency: await getPositiveInt(config, 'SYNCHRONIZER_QUEUE_CONCURRENCY', 10),
    timeout: await getPositiveInt(config, 'SYNCHRONIZER_QUEUE_TIMEOUT_MS', 100000)
  })

  const snsPublisher = await createSnsDeploymentPublisherComponent({ config, logs, metrics })
  const snsEventPublisher = await createSnsEventPublisherComponent({ config, logs, metrics })

  const entityDownloader = await createEntityDownloaderComponent({ config, logs, storage, fetch, metrics })

  const deployer = await createDeployerComponent({
    config,
    storage,
    processedRegistry,
    downloadQueue,
    fetch,
    logs,
    metrics,
    snsPublisher,
    snsEventPublisher,
    entityDownloader
  })

  const snapshotStorage: ISnapshotStorageComponent & IProcessedSnapshotStorageComponent = {
    has: (snapshotHash) => processedRegistry.wasSnapshotProcessed(snapshotHash),
    markSnapshotAsProcessed: (snapshotHash) => processedRegistry.markSnapshotProcessed(snapshotHash),
    filterProcessedSnapshotsFrom: (snapshotHashes) => processedRegistry.filterProcessedSnapshots(snapshotHashes)
  }

  const synchronizer = await createSynchronizer(
    {
      logs,
      downloadQueue: synchronizerQueue,
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

      // pointer changes stream options
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
    pg,
    processedRegistry,
    downloadQueue,
    synchronizerQueue,
    synchronizer,
    deployer,
    snsPublisher,
    snsEventPublisher,
    entityDownloader
  }
}
