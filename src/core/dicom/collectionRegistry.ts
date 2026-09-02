import type { Chunk } from '@/src/core/streaming/chunk';
import type { DicomCollection } from '@/src/core/dicom/planDicomCollections';

export type CollectionUpdate = {
  id: string;
  collection: DicomCollection;
  // Every chunk the collection holds, in the collection's own order, index
  // aligned with collection.members.
  members: Chunk[];
  // The registered batch's chunks that belong to this collection.
  added: Chunk[];
};

export type DicomCollectionRegistry = {
  register: (chunks: Chunk[]) => Promise<CollectionUpdate[]>;
};

const notImplemented = (name: string): never => {
  throw new Error(`${name} is not implemented`);
};

/**
 * Remembers every instance seen so far, per series, and replans the series a
 * batch touches. Registration is serialized per series.
 */
export const createDicomCollectionRegistry: () => DicomCollectionRegistry =
  () => notImplemented('createDicomCollectionRegistry');
