import { clampValue } from '@/src/utils';
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
// Each channel is clamped to [0, 255]: a foreign / hand-edited header carrying an
// out-of-range float (e.g. "1.5 -0.2 0.5") must not leak a negative or >255 channel
// downstream into `SegmentMask.color`.
const fromColorString = (raw: string): [number, number, number] | undefined => {
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n)))
    return undefined;
  const clamp255 = (n: number) => clampValue(Math.round(n * 255), 0, 255);
  return [clamp255(parts[0]), clamp255(parts[1]), clamp255(parts[2])] as [
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

// A decoded segment as `decodeSegments` hands it to the store: a `ParsedSegment`
// with the looser `number[]` color the default-numbering path already produces,
// so overlaying the parser's stricter 4-tuple introduces no friction.
export type DecodedSegment = Omit<ParsedSegment, 'color'> & { color: number[] };

/**
 * Overlay embedded `.seg.nrrd` segment metadata onto the full voxel-value
 * enumeration (issue #6). The enumeration (`values`) is the SPINE: every
 * labelled voxel gets a segment, so a value with no `Segment{N}_*` block still
 * yields a default (via `makeDefault`) instead of being silently dropped —
 * dropping it would leave those voxels rendered but unnameable, unrecolorable,
 * and undeletable. A described value overrides its default's name / color /
 * visibility; a described value NOT in the enumeration (e.g. a segment the CLI
 * declared but wrote no voxels for) is appended so nothing described is lost.
 * Background (0) is never a segment. `makeDefault` is consumed only for
 * undescribed values, so a fully-described labelmap never churns the caller's
 * colour cursor.
 *
 * Caller note: `decodeSegments` passes the dense `min..max` scalar range as the
 * spine (matching VolView's default, non-embedded decode path). That can create
 * phantom empty segments for a *sparse*-valued labelmap — a pre-existing
 * limitation of range-based enumeration, not specific to this merge; the CLIs
 * here emit dense contiguous labels, so no phantoms arise in practice.
 */
export const overlaySegmentMetadata = (
  values: number[],
  described: ParsedSegment[] | undefined,
  makeDefault: (value: number) => DecodedSegment
): DecodedSegment[] => {
  const describedByValue = new Map(
    (described ?? []).map((seg) => [seg.value, seg] as const)
  );
  // A described segment is keyed by its own `value`, so it stands in for the
  // enumeration entry directly (ParsedSegment widens to DecodedSegment). `described`
  // is freshly parsed per decode and discarded, so passing it through by reference
  // aliases nothing the caller keeps.
  const merged: DecodedSegment[] = values.map(
    (value) => describedByValue.get(value) ?? makeDefault(value)
  );
  // Append described values not in the enumeration. Iterate the DEDUPED map, NOT
  // the raw `described` array: a foreign header with a duplicated LabelValue
  // outside the range would otherwise push two segments sharing one value (a
  // colliding `order` entry / Vue `:key`). 0 is the background label, never a
  // segment.
  const enumerated = new Set(values);
  describedByValue.forEach((seg, value) => {
    if (value !== 0 && !enumerated.has(value)) merged.push(seg);
  });
  return merged;
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
