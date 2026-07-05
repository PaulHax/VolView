import type { SegmentGroupMetadata } from '@/src/store/segmentGroups';

const toColorString = (r: number, g: number, b: number) =>
  [r / 255, g / 255, b / 255].map((c) => c.toFixed(6)).join(' ');

/**
 * Builds Slicer-compatible .seg.nrrd metadata entries from VolView segment group metadata.
 * Returns a Map suitable for setting on an itk-wasm Image's metadata field.
 *
 * @param metadata - segment group metadata (names, colors, label values)
 * @param dimensions - [x, y, z] voxel dimensions of the labelmap
 */
export const buildSegNrrdMetadata = (
  metadata: SegmentGroupMetadata,
  dimensions: [number, number, number]
): Map<string, string> => {
  const entries = new Map<string, string>();

  entries.set('Segmentation_MasterRepresentation', 'Binary labelmap');
  entries.set('Segmentation_ContainedRepresentationNames', 'Binary labelmap|');
  entries.set('Segmentation_ReferenceImageExtentOffset', '0 0 0');

  const extentStr = `0 ${dimensions[0] - 1} 0 ${dimensions[1] - 1} 0 ${dimensions[2] - 1}`;

  metadata.segments.order.forEach((segmentValue, index) => {
    const segment = metadata.segments.byValue[segmentValue];
    if (!segment) return;

    const prefix = `Segment${index}`;
    const [r, g, b] = segment.color;

    entries.set(`${prefix}_ID`, `Segment_${segmentValue}`);
    entries.set(`${prefix}_Name`, segment.name);
    entries.set(`${prefix}_Color`, toColorString(r, g, b));
    entries.set(`${prefix}_LabelValue`, String(segmentValue));
    entries.set(`${prefix}_Layer`, '0');
    entries.set(`${prefix}_Extent`, extentStr);
    entries.set(`${prefix}_Tags`, '|');
  });

  return entries;
};

export const maybeBuildSegNrrdMetadata = (
  format: string,
  segMetadata: SegmentGroupMetadata,
  dimensions: [number, number, number]
): Map<string, string> | undefined =>
  format === 'seg.nrrd'
    ? buildSegNrrdMetadata(segMetadata, dimensions)
    : undefined;

// ---------------------------------------------------------------------------
// Read side — the inverse of `buildSegNrrdMetadata`.
//
// A `.seg.nrrd` labelmap carries its segment names/colors in the NRRD header as
// `Segment{N}_Name`/`_Color`/`_LabelValue` (the Slicer convention this module
// writes). itk-wasm's `readImage` surfaces those header fields in the loaded
// image's metadata map; `parseSegNrrdMetadata` turns them back into segment
// descriptors, so a labelmap produced by a backend CLI arrives with its real
// names/colors instead of the default numbered fallback. This is the symmetric
// half of the write path — both ends are ITK NRRD IO.
// ---------------------------------------------------------------------------

export type ParsedSegment = {
  value: number;
  name: string;
  color: [number, number, number, number];
  visible: boolean;
};

// "0.905882 0.298039 0.235294" (RGB floats 0–1, the writer's format) → [231, 76, 60].
const fromColorString = (raw: string): [number, number, number] | undefined => {
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n)))
    return undefined;
  return [0, 1, 2].map((i) => Math.round(parts[i] * 255)) as [
    number,
    number,
    number,
  ];
};

/**
 * Parse Slicer-convention `.seg.nrrd` segment metadata into segment
 * descriptors. Reads `Segment{N}_Name`/`_Color`/`_LabelValue` for
 * N = 0, 1, 2, … (contiguous, as the writer emits them), stopping at the first
 * index that carries neither a name nor a label value. Returns `undefined` when
 * no segment metadata is present, so callers fall back to the default numbering.
 */
export const parseSegNrrdMetadata = (
  metadata: Map<string, string>
): ParsedSegment[] | undefined => {
  const segments: ParsedSegment[] = [];
  for (let index = 0; ; index += 1) {
    const prefix = `Segment${index}`;
    const labelValue = metadata.get(`${prefix}_LabelValue`);
    const name = metadata.get(`${prefix}_Name`);
    if (labelValue === undefined && name === undefined) break;
    const value = Number.parseInt(labelValue ?? '', 10);
    if (!Number.isInteger(value)) continue; // no usable label value → skip
    const rgb = fromColorString(metadata.get(`${prefix}_Color`) ?? '');
    segments.push({
      value,
      name: name ?? `Segment ${value}`,
      color: rgb ? [...rgb, 255] : [255, 255, 255, 255],
      visible: true,
    });
  }
  return segments.length ? segments : undefined;
};

// Load-time carrier (Chunk 34). `itkReader` produces a bare `vtkImageData` and
// drops the itk metadata map at the itk→vtk conversion, so we stash the segment
// metadata against the returned image for the single synchronous hop to
// `importSingleFile`, which takes it and stores it on the loaded image. Keyed by
// the raw image object (identity is intact before it is wrapped in a Vue ref),
// and a `WeakMap` so a never-taken entry is garbage-collected.
const pendingSegNrrdMetadata = new WeakMap<object, Map<string, string>>();

export const rememberSegNrrdMetadata = (
  image: object,
  metadata: Map<string, string>
): void => {
  if (metadata.has('Segment0_Name') || metadata.has('Segment0_LabelValue')) {
    pendingSegNrrdMetadata.set(image, metadata);
  }
};

export const takeSegNrrdMetadata = (
  image: object
): Map<string, string> | undefined => {
  const metadata = pendingSegNrrdMetadata.get(image);
  if (metadata) pendingSegNrrdMetadata.delete(image);
  return metadata;
};
