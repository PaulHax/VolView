import type { InstanceFacts } from '@/src/core/dicom/planDicomCollections';
import { Tags } from '@/src/core/dicomTags';

/** A chunk's metadata as `readDicomTags` returns it: `[tag, value]` pairs. */
export type DicomTagValues = ReadonlyArray<readonly [string, string]>;

// readDicomTags hands back DICOM's own byte padding, so a value that is only
// padding is absent rather than an empty string.
const textOf = (metadata: DicomTagValues, tag: string) => {
  const found = metadata.find(([name]) => name === tag);
  const value = found?.[1].trim() ?? '';
  return value.length > 0 ? value : null;
};

// Hard facts are compared for equality, so '04', '4' and '4.0' must be one
// value. A value that is not a number keeps its own spelling.
const numericTextOf = (metadata: DicomTagValues, tag: string) => {
  const text = textOf(metadata, tag);
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? String(value) : text;
};

const numberOf = (metadata: DicomTagValues, tag: string) => {
  const text = textOf(metadata, tag);
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

const vectorOf = (metadata: DicomTagValues, tag: string, length: number) => {
  const text = textOf(metadata, tag);
  if (text === null) return null;
  const parts = text.split('\\').map((part) => Number(part.trim()));
  return parts.length === length && parts.every((part) => Number.isFinite(part))
    ? parts
    : null;
};

const cross = (left: number[], right: number[]) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];

const dot = (left: number[], right: number[]) =>
  left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

// The slice normal is the row cosines crossed with the column cosines, which
// is only the z axis for an axial acquisition.
const projectOnNormal = (
  orientation: number[] | null,
  position: number[] | null
) =>
  orientation === null || position === null
    ? null
    : dot(cross(orientation.slice(0, 3), orientation.slice(3, 6)), position);

/** Reads the planner's plain facts out of one instance's tag values. */
export function readInstanceFacts(metadata: DicomTagValues): InstanceFacts {
  const orientation = vectorOf(metadata, Tags.ImageOrientationPatient, 6);
  const position = vectorOf(metadata, Tags.ImagePositionPatient, 3);

  return {
    sopInstanceUid: textOf(metadata, Tags.SOPInstanceUID),
    seriesInstanceUid: textOf(metadata, Tags.SeriesInstanceUID),
    seriesNumber: numericTextOf(metadata, Tags.SeriesNumber),
    sequenceName: textOf(metadata, Tags.SequenceName),
    sliceThickness: numericTextOf(metadata, Tags.SliceThickness),
    seriesDate: textOf(metadata, Tags.SeriesDate),
    rows: numericTextOf(metadata, Tags.Rows),
    columns: numericTextOf(metadata, Tags.Columns),
    samplesPerPixel: numericTextOf(metadata, Tags.SamplesPerPixel),
    numberOfFrames: numericTextOf(metadata, Tags.NumberOfFrames),
    orientation,
    position,
    projectedPosition: projectOnNormal(orientation, position),
    pixelSpacing: vectorOf(metadata, Tags.PixelSpacing, 2),
    instanceNumber: numberOf(metadata, Tags.InstanceNumber),
    acquisitionNumber: numericTextOf(metadata, Tags.AcquisitionNumber),
    temporalPositionIdentifier: numericTextOf(
      metadata,
      Tags.TemporalPositionIdentifier
    ),
    echoNumbers: numericTextOf(metadata, Tags.EchoNumbers),
    diffusionBValue: numericTextOf(metadata, Tags.DiffusionBValue),
  };
}

// Carries a separator no UID can hold, so a fallback key never equals a real
// series key.
const NO_SERIES_UID = 'no-series';

/**
 * The grouping key for one instance's series. Instances of different series
 * are planned independently.
 */
export function seriesKeyOf(metadata: DicomTagValues) {
  const seriesUid = textOf(metadata, Tags.SeriesInstanceUID);
  if (seriesUid !== null) return seriesUid;

  // Escaped, so moving a separator from one part to the other changes the key.
  return [
    NO_SERIES_UID,
    encodeURIComponent(textOf(metadata, Tags.StudyInstanceUID) ?? ''),
    encodeURIComponent(textOf(metadata, Tags.PatientID) ?? ''),
  ].join('|');
}
