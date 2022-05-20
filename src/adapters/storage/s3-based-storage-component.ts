import { S3 } from "aws-sdk"
import { Readable } from "stream"
import { AppComponents } from "../../types"
import { SimpleContentItem } from "./content-item"
import { ContentItem, IContentStorageComponent } from "./types"

export async function createS3BasedFileSystemContentStorage(
  components: Pick<AppComponents, "fs" | "config">
): Promise<IContentStorageComponent> {
  const { config } = components

  const s3 = new S3({
    region: await config.requireString("AWS_REGION"),
  })

  const Bucket = await config.requireString("STORAGE_BUCKET")
  const getKey = (hash: string) => hash

  async function exist(id: string): Promise<boolean> {
    try {
      const obj = await s3.headObject({ Bucket, Key: getKey(id) }).promise()
      return !!obj.LastModified
    } catch {
      return false
    }
  }

  return {
    exist,
    async storeStream(id: string, stream: Readable): Promise<void> {
      await s3
        .putObject({
          Bucket,
          Key: getKey(id),
          Body: stream,
        })
        .promise()
    },
    async retrieve(id: string): Promise<ContentItem | undefined> {
      try {
        const obj = await s3.headObject({ Bucket, Key: getKey(id) }).promise()
        return new SimpleContentItem(
          async () => s3.getObject({ Bucket, Key: getKey(id) }).createReadStream(),
          obj.ContentLength,
          // TODO: ContentEncoding
          null
        )
      } catch (error) {
        console.error(error)
      }
      return undefined
    },
    async storeStreamAndCompress(id: string, stream: Readable): Promise<void> {
      await s3
        .putObject({
          Bucket,
          Key: getKey(id),
          Body: stream,
        })
        .promise()
    },
    async delete(ids: string[]): Promise<void> {
      await s3
        .deleteObjects({
          Bucket,
          Delete: { Objects: ids.map(($) => ({ Key: getKey($) })) },
        })
        .promise()
    },

    async existMultiple(ids: string[]): Promise<Map<string, boolean>> {
      return Object.fromEntries(await Promise.all(ids.map((key) => [key, exist(key)])))
    },
  }
}
