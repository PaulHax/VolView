import type { InstanceFacts } from '@/src/core/dicom/planDicomCollections';

/** A chunk's metadata as `readDicomTags` returns it: `[tag, value]` pairs. */
export type DicomTagValues = ReadonlyArray<readonly [string, string]>;

const notImplemented = (name: string): never => {
  throw new Error(`${name} is not implemented`);
};

/**
 * The grouping key for one instance's series. Instances of different series
 * are planned independently.
 */
export const seriesKeyOf: (metadata: DicomTagValues) => string = () =>
  notImplemented('seriesKeyOf');

/** Reads the planner's plain facts out of one instance's tag values. */
export const readInstanceFacts: (
  metadata: DicomTagValues
) => InstanceFacts = () => notImplemented('readInstanceFacts');
