import { ContentItem, IContentStorageComponent } from '@dcl/catalyst-storage'
import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { AppComponents } from '../../types'

// Upper bound on how long `stageToDisk` is allowed to run before we give up
// on the underlying stream. Guards against a source that stays alive but
// stops producing data (e.g. S3 throttling without a FIN) — without it,
// `pipeline()` would wait forever. Generous enough for realistic snapshot
// sizes; if it fires, snapshot-fetcher's retry layer will re-attempt.
const STAGE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Wraps an `IContentStorageComponent` so that streams returned by `retrieve()`
 * are first staged to an ephemeral file on local disk before being handed
 * back to the caller.
 *
 * The underlying S3 client (aws-sdk v2, pulled in by `@dcl/catalyst-storage`)
 * emits `error: aborted` on the response stream when a connection drops
 * mid-download — for example when the consumer (`readline` inside
 * `@dcl/snapshots-fetcher`) idles the socket past S3's idle timeout while
 * the deployer's download queue is saturated. That error is re-emitted on
 * the `readline` Interface which has no listener, becoming an uncaught
 * exception that kills the process.
 *
 * Staging the body to disk decouples the S3 socket from the line-by-line
 * consumer: the drain runs at full speed into a local file, so the S3
 * connection can't idle out. A mid-download abort rejects `asStream()`
 * before any consumer sees it, letting snapshot-fetcher's retry layer
 * handle it.
 *
 * @param components - Well-Known Components dependencies (logger only).
 * @param inner - The storage component to wrap. All non-`retrieve` methods
 *                are forwarded unchanged.
 * @returns An `IContentStorageComponent` with disk-staged retrieval.
 */
export function createResilientContentStorage(
  components: Pick<AppComponents, 'logs'>,
  inner: IContentStorageComponent
): IContentStorageComponent {
  const logger = components.logs.getLogger('ResilientContentStorage')

  /**
   * Drains `source` into a freshly-named temp file and returns its path.
   *
   * Uses `pipeline()` so any error on `source` (e.g. S3 abort) or on the
   * write stream (e.g. disk full) propagates as a rejected promise and
   * both streams are destroyed. A timeout signal prevents the call from
   * hanging forever on a stalled-but-alive source. On any failure the
   * partial file is removed; cleanup errors are swallowed on purpose so
   * the original error surfaces.
   *
   * @param fileId - Logical id of the content being staged (for logging).
   * @param source - Readable whose body should be staged.
   * @returns Absolute path to the staged temp file.
   * @throws Propagates any error from the source, the write stream, or the
   *         timeout signal (as an `AbortError`).
   */
  async function stageToDisk(fileId: string, source: Readable): Promise<string> {
    const tmpPath = join(tmpdir(), `content-stage-${randomUUID()}`)
    try {
      await pipeline(source, createWriteStream(tmpPath), { signal: AbortSignal.timeout(STAGE_TIMEOUT_MS) })
      return tmpPath
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('Failed while staging content stream to disk', {
        fileId,
        error: message
      })
      await unlink(tmpPath).catch(() => {})
      throw error
    }
  }

  // Forward every non-retrieve method explicitly. `bind` preserves `this`
  // for implementations that rely on it internally. A `{ ...inner }` spread
  // would auto-forward future members but drop the `this` binding — we
  // prefer the explicit list, and TypeScript will fail the build if
  // `IContentStorageComponent` grows a required method.
  return {
    storeStream: inner.storeStream.bind(inner),
    storeStreamAndCompress: inner.storeStreamAndCompress.bind(inner),
    delete: inner.delete.bind(inner),
    fileInfo: inner.fileInfo.bind(inner),
    fileInfoMultiple: inner.fileInfoMultiple.bind(inner),
    exist: inner.exist.bind(inner),
    existMultiple: inner.existMultiple.bind(inner),
    allFileIds: inner.allFileIds.bind(inner),

    async retrieve(fileId: string): Promise<ContentItem | undefined> {
      const item = await inner.retrieve(fileId)
      if (!item) {
        return item
      }

      return {
        encoding: item.encoding,
        size: item.size,
        // `asRawStream` is intentionally forwarded unwrapped. It returns the
        // raw (potentially compressed) S3 body and is not used by any code
        // path in this repo; snapshot-fetcher only calls `asStream`. If a
        // future consumer starts relying on `asRawStream` with a slow
        // reader, the same abort vulnerability will resurface and this
        // method should be wrapped too.
        asRawStream: item.asRawStream.bind(item),
        async asStream(): Promise<Readable> {
          const source = await item.asStream()
          const tmpPath = await stageToDisk(fileId, source)

          // `fs.ReadStream` always emits 'close' after 'end' or 'error',
          // so a single listener is enough to cover both paths.
          const readStream = createReadStream(tmpPath)
          readStream.once('close', () => {
            unlink(tmpPath).catch(() => {})
          })
          return readStream
        }
      }
    }
  }
}
