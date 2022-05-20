import { JobLifecycleManagerComponent } from "@dcl/snapshots-fetcher/dist/job-lifecycle-manager"
import { IJobQueue } from "@dcl/snapshots-fetcher/dist/job-queue-port"
import { IDeployerComponent } from "@dcl/snapshots-fetcher/dist/types"
import type { IFetchComponent } from "@well-known-components/http-server"
import type {
  IConfigComponent,
  ILoggerComponent,
  IHttpServerComponent,
  IBaseComponent,
  IMetricsComponent,
} from "@well-known-components/interfaces"
import { IFileSystemComponent } from "./adapters/fs/types"
import { IContentStorageComponent } from "./adapters/storage/types"
import { metricDeclarations } from "./metrics"
import { SNS } from "aws-sdk"

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
  synchronizationJobManager: JobLifecycleManagerComponent
  deployer: IDeployerComponent
  sns: SnsComponent | null
}

export type SnsComponent = { arn: string }

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
