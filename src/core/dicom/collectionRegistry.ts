import type { Chunk } from '@/src/core/streaming/chunk';
import {
  planDicomCollections,
  type DicomCollection,
  type InstanceFacts,
} from '@/src/core/dicom/planDicomCollections';
import {
  assignIds,
  type CommittedCollection,
} from '@/src/core/dicom/assignCollectionIds';
import { readInstanceFacts, seriesKeyOf } from '@/src/core/dicom/instanceFacts';

export type CollectionUpdate = {
  id: string;
  seriesKey: string;
  collection: DicomCollection;
  // Every chunk the collection holds, in the collection's own order, index
  // aligned with collection.members.
  members: Chunk[];
  // Index aligned with members: the batch's own chunk wherever the batch
  // supplied that instance, so a re-import's provenance reaches the caller
  // while the image keeps the object it already decodes.
  provenance: Chunk[];
};

export type RegistrationResult = {
  updates: CollectionUpdate[];
  // Committed IDs the replan dissolved, whose members moved elsewhere.
  removed: string[];
  // Undoes this batch's registration for the named series, so a failed import
  // does not pin its chunks. Assumes the caller registered nothing since.
  rollback: (seriesKeys: Iterable<string>) => void;
};

export type DicomCollectionRegistry = {
  register: (chunks: Chunk[]) => Promise<RegistrationResult>;
  forget: (collectionId: string) => void;
};

// An instance with no SOP Instance UID is identified by its chunk, so two of
// them never merge while re-registering one does not duplicate it.
type InstanceKey = string | Chunk;

type RegisteredInstance = {
  key: InstanceKey;
  chunk: Chunk;
  facts: InstanceFacts;
};

type SeriesEntry = {
  instances: Map<InstanceKey, RegisteredInstance>;
  // Committed collection ID to the member keys it was last planned with.
  committed: Map<string, InstanceKey[]>;
  queue: Promise<unknown>;
};

const readChunk = (chunk: Chunk) => {
  const { metadata } = chunk;
  if (!metadata)
    throw new Error(
      'Cannot register a DICOM chunk whose metadata has not been read'
    );
  const facts = readInstanceFacts(metadata);
  return {
    seriesKey: seriesKeyOf(metadata),
    instance: { key: facts.sopInstanceUid ?? chunk, chunk, facts },
  };
};

/** Groups preserve input order, both of the series and of their instances. */
const groupBySeries = (chunks: Chunk[]) => {
  const groups = new Map<string, RegisteredInstance[]>();
  chunks
    .map(readChunk)
    .forEach(({ seriesKey, instance }) =>
      groups.set(seriesKey, [...(groups.get(seriesKey) ?? []), instance])
    );
  return groups;
};

const firstByKey = (instances: RegisteredInstance[]) => {
  const byKey = new Map<InstanceKey, Chunk>();
  instances.forEach((instance) => {
    if (!byKey.has(instance.key)) byKey.set(instance.key, instance.chunk);
  });
  return byKey;
};

// A collection holding no SOP Instance UID cannot be claimed back by overlap,
// so its ID is re-minted from its key instead of counting as taken.
const claimable = (committed: SeriesEntry['committed']) =>
  [...committed]
    .map(
      ([id, keys]): CommittedCollection => ({
        id,
        sopInstanceUids: keys.filter(
          (key): key is string => typeof key === 'string'
        ),
      })
    )
    .filter((collection) => collection.sopInstanceUids.length > 0);

const sameMembers = (left: InstanceKey[] | undefined, right: InstanceKey[]) =>
  left !== undefined &&
  left.length === right.length &&
  left.every((key, index) => key === right[index]);

function planSeries(
  entry: SeriesEntry,
  seriesKey: string,
  batch: RegisteredInstance[]
) {
  // The first registration of an instance owns its chunk: a re-supply only
  // reports back, so the chunk an image already holds stays the member.
  batch.forEach((instance) => {
    if (!entry.instances.has(instance.key))
      entry.instances.set(instance.key, instance);
  });

  const registered = [...entry.instances.values()];
  const plan = planDicomCollections({
    seriesKey,
    instances: registered.map((instance) => instance.facts),
  });
  const assigned = assignIds(plan, claimable(entry.committed));

  const instanceOf = new Map(
    registered.map((instance) => [instance.facts, instance])
  );
  const batchChunks = firstByKey(batch);

  const planned = assigned.collections.map(({ id, ...collection }) => {
    const instances = collection.members.map((facts) => instanceOf.get(facts)!);
    const keys = instances.map((instance) => instance.key);
    return {
      id,
      collection,
      keys,
      members: instances.map((instance) => instance.chunk),
      provenance: instances.map(
        (instance) => batchChunks.get(instance.key) ?? instance.chunk
      ),
      supplied: keys.some((key) => batchChunks.has(key)),
    };
  });

  // A replan can move members between collections, so membership changes are
  // reported even where the batch brought the collection nothing.
  const updates = planned
    .filter(
      ({ id, keys, supplied }) =>
        supplied || !sameMembers(entry.committed.get(id), keys)
    )
    .map(
      ({ id, collection, members, provenance }): CollectionUpdate => ({
        id,
        seriesKey,
        collection,
        members,
        provenance,
      })
    );

  const removed = [...entry.committed.keys()].filter(
    (id) => !planned.some((collection) => collection.id === id)
  );

  entry.committed = new Map(planned.map(({ id, keys }) => [id, keys]));

  return { updates, removed };
}

/**
 * Remembers every instance seen so far, per series, and replans the series a
 * batch touches. Registration is serialized per series.
 */
export function createDicomCollectionRegistry(): DicomCollectionRegistry {
  const series = new Map<string, SeriesEntry>();

  const entryFor = (seriesKey: string) => {
    const existing = series.get(seriesKey);
    if (existing) return existing;
    const created: SeriesEntry = {
      instances: new Map(),
      committed: new Map(),
      queue: Promise.resolve(),
    };
    series.set(seriesKey, created);
    return created;
  };

  const register = async (chunks: Chunk[]) => {
    // Reading every chunk before touching a queue keeps a batch that names an
    // unread chunk from half registering.
    const batches = groupBySeries(chunks);
    const snapshots = new Map<
      string,
      Pick<SeriesEntry, 'instances' | 'committed'>
    >();

    const planned = [...batches].map(([seriesKey, batch]) => {
      const entry = entryFor(seriesKey);
      const update = entry.queue.then(() => {
        snapshots.set(seriesKey, {
          instances: new Map(entry.instances),
          committed: new Map(entry.committed),
        });
        return planSeries(entry, seriesKey, batch);
      });
      // A failed plan must not wedge the series behind it.
      entry.queue = update.catch(() => {});
      return update;
    });

    const rollback = (seriesKeys: Iterable<string>) =>
      [...new Set(seriesKeys)].forEach((seriesKey) => {
        const snapshot = snapshots.get(seriesKey);
        const entry = series.get(seriesKey);
        if (!snapshot || !entry) return;
        entry.instances = snapshot.instances;
        entry.committed = snapshot.committed;
      });

    const results = await Promise.all(planned);
    return {
      updates: results.flatMap((result) => result.updates),
      removed: results.flatMap((result) => result.removed),
      rollback,
    };
  };

  // Releasing the instances releases the chunk bytes they hold. An ID a
  // replan already dissolved owns nothing, so forgetting it is a no-op and
  // the members it handed to another collection stay registered.
  const forget = (collectionId: string) => {
    series.forEach((entry, seriesKey) => {
      const members = entry.committed.get(collectionId);
      if (!members) return;
      members.forEach((key) => entry.instances.delete(key));
      entry.committed.delete(collectionId);
      if (entry.instances.size === 0) series.delete(seriesKey);
    });
  };

  return { register, forget };
}
