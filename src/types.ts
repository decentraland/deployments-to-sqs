import { DeployableEntity, IDeployerComponent, IJobQueue, SynchronizerComponent } from '@dcl/snapshots-fetcher'
import type { IFetchComponent, IHttpServerComponent } from '@dcl/core-commons'
import type {
  IConfigComponent,
  ILoggerComponent,
  IBaseComponent,
  IMetricsComponent
} from '@well-known-components/interfaces'
import { IContentStorageComponent, IFileSystemComponent } from '@dcl/catalyst-storage'
import { IPgComponent } from '@dcl/pg-component'
import { metricDeclarations } from './metrics'

export type GlobalContext = {
  components: BaseComponents
}

// components used in every environment
export type BaseComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
  server: IHttpServerComponent<GlobalContext>
  fetch: IFetchComponent
  /** Entity downloads; what `deployer.onIdle()` drains. */
  downloadQueue: IJobQueue
  /** The synchronizer's control plane, kept off the entity queue. */
  synchronizerQueue: IJobQueue
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  fs: IFileSystemComponent
  storage: IContentStorageComponent
  pg: IPgComponent
  processedRegistry: ProcessedRegistryComponent
  synchronizer: SynchronizerComponent
  deployer: IDeployerComponent
  snsPublisher: SnsPublisherComponent
  snsEventPublisher: SnsPublisherComponent
  entityDownloader: EntityDownloaderComponent
}

export type SnsPublisherComponent = {
  publishMessage: (entity: DeployableEntity & { metadata: any }, contentServerUrls: string[]) => Promise<void>
}

/** Records what has been processed. Backed by Postgres, falling back to storage for pre-table entities. */
export type ProcessedRegistryComponent = {
  wasEntityPublished: (entityId: string) => Promise<boolean>
  claimEntity: (entity: Pick<DeployableEntity, 'entityId' | 'entityType' | 'entityTimestamp'>) => Promise<void>
  markEntityPublished: (entityId: string) => Promise<void>
  wasSnapshotProcessed: (snapshotHash: string) => Promise<boolean>
  markSnapshotProcessed: (snapshotHash: string) => Promise<void>
  filterProcessedSnapshots: (snapshotHashes: string[]) => Promise<Set<string>>
  countUnpublishedEntities: () => Promise<number>
  reportUnpublishedEntities: () => Promise<void>
}

export type EntityDownloaderComponent = {
  /** Resolves to the downloaded entity's `metadata`, which the deployer forwards to the publishers. */
  downloadEntity: (entity: DeployableEntity, contentServerUrls: string[]) => Promise<unknown>
}

// components used in runtime
export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent
}

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
}

// this type simplifies the typings of http handlers
export type HandlerContextWithPath<
  ComponentNames extends keyof AppComponents,
  Path extends string = any
> = IHttpServerComponent.PathAwareContext<
  IHttpServerComponent.DefaultContext<{
    components: Pick<AppComponents, ComponentNames>
  }>,
  Path
>

export type Context<Path extends string = any> = IHttpServerComponent.PathAwareContext<GlobalContext, Path>

export class SnsPublishError extends Error {
  constructor(
    message: string,
    public details?: {
      entity: DeployableEntity
      error: Error
    }
  ) {
    super(message)
    this.name = 'SnsPublishError'
  }
}

export class EntityDownloadError extends Error {
  constructor(
    message: string,
    public details?: {
      entity: DeployableEntity
      error: Error
    }
  ) {
    super(message)
    this.name = 'EntityDownloadError'
  }
}
