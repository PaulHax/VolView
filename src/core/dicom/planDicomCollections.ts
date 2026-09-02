/**
 * Facts read once per instance from a chunk's metadata. Plain data: the planner
 * never sees a Chunk, a store, or an itk-wasm task.
 */
export type InstanceFacts = {
  // Identity. Instances without a SOP Instance UID are never deduplicated.
  sopInstanceUid: string | null;
  seriesInstanceUid: string | null;

  // Hard partition facts, compared for equality.
  seriesNumber: string | null;
  sequenceName: string | null;
  sliceThickness: string | null;
  seriesDate: string | null;
  rows: string | null;
  columns: string | null;
  samplesPerPixel: string | null;
  numberOfFrames: string | null;

  // Geometry. Any of these may be unreadable.
  orientation: number[] | null;
  position: number[] | null;
  projectedPosition: number | null;
  pixelSpacing: number[] | null;

  // Ordering fallback.
  instanceNumber: number | null;
};

export type CollectionKey = {
  seriesKey: string;
  parts: Array<[string, string | null]>;
};

export type MemberOrder = 'spatial' | 'instance-number' | 'input';

export type DicomCollection = {
  key: CollectionKey;
  members: InstanceFacts[];
  order: MemberOrder;
  diagnostics: string[];
};

export type DicomCollectionPlan = {
  collections: DicomCollection[];
};

export type PlanInput = {
  seriesKey: string;
  instances: InstanceFacts[];
};

// Matches dicom.cpp's EPSILON: two orientation rows agree when their dot
// product is within this of 1.
export const ORIENTATION_TOLERANCE = 1e-4;

// The hard facts, in the order they appear in a collection key.
export const HARD_FACT_RULES = [
  'seriesNumber',
  'sequenceName',
  'sliceThickness',
  'seriesDate',
  'rows',
  'columns',
  'samplesPerPixel',
  'numberOfFrames',
] as const;

export const ORIENTATION_RULE = 'orientation';

export const planDicomCollections: (
  input: PlanInput
) => DicomCollectionPlan = () => {
  throw new Error('planDicomCollections is not implemented');
};

/**
 * Throws when the collections do not hold every instance exactly once, or when
 * two collections share a key.
 */
export const validateCollections: (
  instances: InstanceFacts[],
  collections: DicomCollection[]
) => void = () => {
  throw new Error('validateCollections is not implemented');
};
