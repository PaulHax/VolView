import { createDicomParser } from '@/src/core/streaming/dicom/dicomParser';
import { StopSignal } from '@/src/core/streaming/cachedStreamFetcher';
import { Fetcher, MetaLoader } from '@/src/core/streaming/types';
import { Maybe } from '@/src/types';
import { Awaitable } from '@vueuse/core';
import { FILE_EXT_TO_MIME } from '@/src/io/mimeTypes';
import { Tags } from '@/src/core/dicomTags';
import { readDicomTags } from '@/src/io/readDicomTags';
import {
  decodeUltrasoundRegion,
  SEQUENCE_OF_ULTRASOUND_REGIONS,
  UltrasoundRegions,
} from '@/src/core/streaming/dicom/ultrasoundRegion';

export type ReadDicomTagsFunction = (
  bytes: Uint8Array
) => Awaitable<Array<[string, string]>>;

/** The delivered bytes up to `end`, in order. */
const concatUpTo = (chunks: readonly Uint8Array[], end: number) => {
  const header = new Uint8Array(end);
  chunks.reduce((at, chunk) => {
    if (at >= end) return at;
    const part = chunk.subarray(0, end - at);
    header.set(part, at);
    return at + part.length;
  }, 0);
  return header;
};

const totalLength = (chunks: readonly Uint8Array[]) =>
  chunks.reduce((total, chunk) => total + chunk.length, 0);

export class DicomMetaLoader implements MetaLoader {
  private tags: Maybe<Array<[string, string]>>;
  private blob: Blob | null = null;
  private offset: Maybe<number>;
  public ultrasoundRegions: UltrasoundRegions | undefined;

  constructor(
    private fetcher: Fetcher,
    private readTags: ReadDicomTagsFunction = readDicomTags
  ) {}

  get meta() {
    return this.tags;
  }

  get metaBlob() {
    return this.blob;
  }

  /** Where Pixel Data starts, or the file's length when it has none. */
  get pixelDataOffset() {
    return this.offset;
  }

  async load() {
    if (this.tags) return;

    await this.fetcher.connect();
    const stream = this.fetcher.getStream();
    let pixelDataIdx = -1;
    let ultrasoundRegions: UltrasoundRegions | undefined;

    const parse = createDicomParser({
      stopAtElement(group, element) {
        return group === 0x7fe0 && element === 0x0010;
      },
      onDataElement: (el) => {
        if (
          el.group === SEQUENCE_OF_ULTRASOUND_REGIONS[0] &&
          el.element === SEQUENCE_OF_ULTRASOUND_REGIONS[1] &&
          !ultrasoundRegions
        ) {
          // Decoding can throw if a malformed FD/US value has an unexpected
          // length; swallow rather than abort the whole metadata load.
          try {
            ultrasoundRegions = decodeUltrasoundRegion(el.data);
          } catch (err) {
            console.warn('Failed to decode SequenceOfUltrasoundRegions:', err);
          }
        }
      },
    });

    // Read a chunk at a time and cancel the moment the header ends: a stream
    // that reads ahead pulls pixel data this loader never uses.
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const result = parse(value);
        if (result.done) {
          pixelDataIdx = result.value.position;
          break;
        }
      }
    } catch (err) {
      if (err !== StopSignal) {
        throw err;
      }
    } finally {
      // Not awaited, so the cancel lands before the stream refills its queue.
      reader.cancel().catch(() => {});
      this.fetcher.close();
    }

    // An object with no Pixel Data, such as an RT structure set, is header to
    // its last byte.
    const chunks = this.fetcher.cachedChunks;
    this.offset = pixelDataIdx < 0 ? totalLength(chunks) : pixelDataIdx;

    const header = concatUpTo(chunks, this.offset);
    this.blob = new Blob([header as BlobPart], { type: FILE_EXT_TO_MIME.dcm });
    this.tags = await this.readTags(header);

    const modality = new Map(this.tags).get(Tags.Modality)?.trim();
    if (modality === 'US' && ultrasoundRegions) {
      this.ultrasoundRegions = ultrasoundRegions;
    }
  }

  stop() {
    this.fetcher.close();
  }
}
