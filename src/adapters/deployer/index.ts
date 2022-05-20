import { downloadEntityAndContentFiles } from "@dcl/snapshots-fetcher"
import { IDeployerComponent } from "@dcl/snapshots-fetcher/dist/types"
import { AppComponents } from "../../types"

export function createDeployerComponent(
  components: Pick<AppComponents, "logs" | "storage" | "downloadQueue" | "fetch" | "metrics">
): IDeployerComponent {
  const logger = components.logs.getLogger("downloader")

  return {
    async deployEntity(entity, servers) {
      if (entity.entityType == "scene" || entity.entityType == "wearable") {
        const exists = await components.storage.exist(entity.entityId)

        if (!exists) {
          logger.info("downloading entity", { entityId: entity.entityId, entityType: entity.entityType })

          components.downloadQueue.scheduleJob(async () => {
            const e = await downloadEntityAndContentFiles(
              { ...components, fetcher: components.fetch },
              entity.entityId,
              servers,
              new Map(),
              "content",
              10,
              1000
            )
            logger.info("entity stored", { entityId: entity.entityId, entityType: entity.entityType })
            // send sns
          })
        }
      }
    },
    async onIdle() {},
  }
}
