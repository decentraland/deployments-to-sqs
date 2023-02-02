import { createDotEnvConfigComponent } from "@well-known-components/env-config-provider"
import { createServerComponent, createStatusCheckComponent } from "@well-known-components/http-server"
import { createLogComponent } from "@well-known-components/logger"
import { createFetchComponent } from "./adapters/fetch"
import { createMetricsComponent, instrumentHttpServerWithMetrics } from "@well-known-components/metrics"
import { AppComponents, GlobalContext, SnsComponent } from "./types"
import { metricDeclarations } from "./metrics"
import { createJobQueue } from "@dcl/snapshots-fetcher/dist/job-queue-port"
import { createCatalystPointerChangesDeploymentStream, } from "@dcl/snapshots-fetcher"
import { ISnapshotStorageComponent, IProcessedSnapshotStorageComponent } from "@dcl/snapshots-fetcher/dist/types"
import { createJobLifecycleManagerComponent } from "@dcl/snapshots-fetcher/dist/job-lifecycle-manager"
import { createDeployerComponent } from "./adapters/deployer"
import { createAwsS3BasedFileSystemContentStorage, createFolderBasedFileSystemContentStorage, createFsComponent } from "@dcl/catalyst-storage"
import { Readable } from "stream"

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: [".env.default", ".env"] })

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const server = await createServerComponent<GlobalContext>({ config, logs }, {})
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()

  await instrumentHttpServerWithMetrics({ config, metrics, server })

  const fs = createFsComponent()

  const downloadsFolder = "content"

  const bucket = await config.getString("BUCKET")
  const snsArn = await config.getString("SNS_ARN")

  const storage = bucket
    ? await createAwsS3BasedFileSystemContentStorage({ fs, config }, bucket)
    : await createFolderBasedFileSystemContentStorage({ fs }, downloadsFolder)

  const downloadQueue = createJobQueue({
    autoStart: true,
    concurrency: 5,
    timeout: 100000,
  })

  const sns: SnsComponent = {
    arn: snsArn,
  }

  const deployer = createDeployerComponent({ storage, downloadQueue, fetch, logs, metrics, sns })

  const key = (hash: string) => `stored-snapshot-${hash}`
  const snapshotStorage: ISnapshotStorageComponent & IProcessedSnapshotStorageComponent = {
    async has(key: string) {
      return storage.exist(key)
    },
    async saveProcessed(snapshotHash) {
      await storage.storeStream(key(snapshotHash), Readable.from([]))
    },
    async processedFrom(snapshotHashes) {
      const ret = new Set<string>()
      for (const hash of snapshotHashes) {
        if (await storage.exist(key(hash))) {
          ret.add(hash)
        }
      }
      return ret
    },
  }

  const synchronizationJobManager = createJobLifecycleManagerComponent(
    { logs },
    {
      jobManagerName: "SynchronizationJobManager",
      createJob(contentServer) {
        return createCatalystPointerChangesDeploymentStream(
          { logs, downloadQueue, fetcher: fetch, metrics, deployer, storage, snapshotStorage, processedSnapshotStorage: snapshotStorage },
          contentServer,
          {
            // time between every poll to /pointer-changes
            pointerChangesWaitTime: 5000,

            // reconnection time for the whole catalyst
            reconnectTime: 1000 /* one second */,
            reconnectRetryTimeExponent: 1.2,
            maxReconnectionTime: 3_600_000 /* one hour */,
          }
        )
      },
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
    synchronizationJobManager,
    deployer,
    sns,
  }
}
