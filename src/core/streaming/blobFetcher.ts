import { StopSignal } from '@/src/core/streaming/cachedStreamFetcher';
import { Fetcher } from '@/src/core/streaming/types';

/** Read enough per pull that a header rarely needs a second slice. */
const CHUNK_SIZE = 64 * 1024;

/**
 * A Fetcher over bytes that are already addressable, so a local file and a
 * remote URI reach the same loaders. Slicing rather than reading the whole
 * blob keeps a header read off the rest of the file.
 */
export const blobFetcher = (blob: Blob): Fetcher => {
  const cachedChunks: Uint8Array<ArrayBuffer>[] = [];
  let abortController: AbortController | null = null;

  return {
    connect: async () => {
      abortController ??= new AbortController();
    },
    getStream: () => {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          if (offset >= blob.size) {
            controller.close();
            return;
          }
          const slice = blob.slice(offset, offset + CHUNK_SIZE);
          const chunk = new Uint8Array(await slice.arrayBuffer());
          offset += chunk.length;
          cachedChunks.push(chunk);
          controller.enqueue(chunk);
        },
      });
    },
    blob: async () => blob,
    close: () => {
      abortController?.abort(StopSignal);
      abortController = null;
    },
    cachedChunks,
    get connected() {
      return !!abortController;
    },
    get size() {
      return blob.size;
    },
    contentType: blob.type,
    get abortSignal() {
      return abortController?.signal;
    },
  };
};
