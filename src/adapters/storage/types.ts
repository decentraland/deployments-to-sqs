import { Readable } from "stream"

export type ContentEncoding = "gzip"

export type IContentStorageComponent = {
  storeStream(fileId: string, content: Readable): Promise<void>
  storeStreamAndCompress(fileId: string, content: Readable): Promise<void>
  delete(fileIds: string[]): Promise<void>
  retrieve(fileId: string): Promise<ContentItem | undefined>
  exist(fileId: string): Promise<boolean>
}

export type RawContent = {
  stream: Readable
  encoding: ContentEncoding | null
  size: number | null
}

export interface ContentItem {
  /**
   * Gets the readable stream, uncompressed if necessary.
   */
  asStream(): Promise<Readable>

  /**
   * Used to get the raw stream, no matter how it is stored.
   * That may imply that the stream may be compressed, if so, the
   * compression encoding should be available in "content".
   */
  asRawStream(): Promise<RawContent>
}
