import type {
  CollectionKey,
  DicomCollection,
  DicomCollectionPlan,
} from '@/src/core/dicom/planDicomCollections';

export type CommittedCollection = {
  id: string;
  sopInstanceUids: string[];
};

export type AssignedCollection = DicomCollection & { id: string };

export type AssignedPlan = {
  collections: AssignedCollection[];
};

/** Escaped encoding of a structured key, safe to use as a store ID. */
export const encodeCollectionKey: (key: CollectionKey) => string = () => {
  throw new Error('encodeCollectionKey is not implemented');
};

/**
 * Carries a committed ID over to the collection holding the plurality of its
 * members; mints a fresh ID from the key otherwise.
 */
export const assignIds: (
  plan: DicomCollectionPlan,
  committedIds: CommittedCollection[]
) => AssignedPlan = () => {
  throw new Error('assignIds is not implemented');
};
