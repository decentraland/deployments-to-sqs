import { IJobQueue } from '@dcl/snapshots-fetcher/dist/job-queue-port'
import { DeployableEntity, IDeployerComponent, SynchronizerComponent } from '@dcl/snapshots-fetcher/dist/types'
import type { IFetchComponent } from '@well-known-components/http-server'
import type {
  IConfigComponent,
  ILoggerComponent,
  IHttpServerComponent,
  IBaseComponent,
  IMetricsComponent
} from '@well-known-components/interfaces'
import { IContentStorageComponent, IFileSystemComponent } from '@dcl/catalyst-storage'
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
  downloadQueue: IJobQueue
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  fs: IFileSystemComponent
  storage: IContentStorageComponent
  synchronizer: SynchronizerComponent
  deployer: IDeployerComponent
  snsPublisher: SnsPublisherComponent
  snsEventPublisher: SnsPublisherComponent
  entityDownloader: EntityDownloaderComponent
  contentChangeChecker: ContentChangeCheckerComponent
  manifestCopier: ManifestCopierComponent
}

export type SnsPublisherComponent = {
  publishMessage: (entity: DeployableEntity & { metadata: any }, contentServerUrls: string[]) => Promise<void>
}

export type EntityDownloaderComponent = {
  downloadEntity: (entity: DeployableEntity, contentServerUrls: string[]) => Promise<void>
}

export type RegistryEntity = {
  id: string
  content: { file: string; hash: string }[]
  versions: {
    assets: {
      windows: { version: string; buildDate: string }
      mac: { version: string; buildDate: string }
      webgl: { version: string; buildDate: string }
    }
  }
}

export type ContentChangeResult =
  | { changed: true }
  | { changed: false; registryEntity: RegistryEntity }

export type ContentChangeCheckerComponent = {
  check: (entity: DeployableEntity, contentServerUrls: string[]) => Promise<ContentChangeResult>
}

export type ManifestCopierComponent = {
  copyAndNotify: (entity: DeployableEntity, registryEntity: RegistryEntity) => Promise<void>
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
