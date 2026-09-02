/** An 8 bit greyscale slice, small enough to encode as a thumbnail. */
export type ThumbnailSlice = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type SliceToThumbnailInput = {
  data: ArrayLike<number>;
  width: number;
  height: number;
  // Samples per pixel; only the first component is read.
  components?: number;
  // The window mapped onto 0..255.
  range: readonly [number, number];
  maxSize?: number;
};

export const THUMBNAIL_MAX_SIZE = 256;

const notImplemented = (name: string): never => {
  throw new Error(`${name} is not implemented`);
};

/** Downsamples one slice and casts it to 8 bit greyscale. */
export const sliceToThumbnail: (
  input: SliceToThumbnailInput
) => ThumbnailSlice = () => notImplemented('sliceToThumbnail');

/** Encodes a thumbnail slice as a PNG data URI. */
export const encodeThumbnailToUri: (slice: ThumbnailSlice) => string = () =>
  notImplemented('encodeThumbnailToUri');
