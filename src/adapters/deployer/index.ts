import { downloadEntityAndContentFiles } from "@dcl/snapshots-fetcher"
import { IDeployerComponent } from "@dcl/snapshots-fetcher/dist/types"
import { SNS } from "aws-sdk"
import { AppComponents } from "../../types"

export function createDeployerComponent(
  components: Pick<AppComponents, "logs" | "storage" | "downloadQueue" | "fetch" | "metrics" | "sns">
): IDeployerComponent {
  const logger = components.logs.getLogger("downloader")

  const sns = new SNS()

  return {
    async deployEntity(entity, servers) {
      if (entity.entityType == "scene" || entity.entityType == "wearable" || entity.entityType == "emote") {
        const exists = await components.storage.exist(entity.entityId)

        if (!exists) {
          logger.info("downloading entity", { entityId: entity.entityId, entityType: entity.entityType })

          await components.downloadQueue.scheduleJob(async () => {
            const file = await downloadEntityAndContentFiles(
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

            if (components.sns.arn) {
              const receipt = await sns
                .publish({
                  TopicArn: components.sns.arn,
                  Message: JSON.stringify({ entity, file, baseUrls: servers }),
                })
                .promise()
              logger.info("notification sent", {
                MessageId: receipt.MessageId as any,
                SequenceNumber: receipt.SequenceNumber as any,
              })
            }
          })
        }
      }
    },
    async onIdle() {},
  }
}
