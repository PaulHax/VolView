import { describe, expect, it } from 'vitest';
import type { Chunk } from '@/src/core/streaming/chunk';
import { Tags } from '@/src/core/dicomTags';
import {
  createDicomCollectionRegistry,
  type CollectionUpdate,
} from '@/src/core/dicom/collectionRegistry';

const SERIES_UID = '1.2.826.0.1.3680043.9.7';
const OTHER_SERIES_UID = '1.2.826.0.1.3680043.9.8';

type SliceOptions = {
  sop?: string | null;
  series?: string;
  z?: number | null;
  rows?: string;
  orientation?: string;
  instanceNumber?: number | null;
};

let sopCounter = 0;

function chunkFor(options: SliceOptions = {}) {
  const {
    sop = `sop-${(sopCounter += 1)}`,
    series = SERIES_UID,
    z = 0,
    rows = '4',
    orientation = '1\\0\\0\\0\\1\\0',
    instanceNumber = 1,
  } = options;

  const entries: Array<[string, string]> = [
    [Tags.StudyInstanceUID, '1.2.826.0.1.3680043.9.1'],
    [Tags.PatientID, 'patient-1'],
    [Tags.SeriesInstanceUID, series],
    [Tags.SeriesNumber, '1'],
    [Tags.Modality, 'MR'],
    [Tags.Rows, rows],
    [Tags.Columns, '4'],
    [Tags.SamplesPerPixel, '1'],
    [Tags.ImageOrientationPatient, orientation],
  ];
  if (sop !== null) entries.push([Tags.SOPInstanceUID, sop]);
  if (z !== null) entries.push([Tags.ImagePositionPatient, `0\\0\\${z}`]);
  if (instanceNumber !== null)
    entries.push(['0020|0013', String(instanceNumber)]);

  return { metadata: entries } as unknown as Chunk;
}

const sopOf = (chunk: Chunk) =>
  Object.fromEntries(chunk.metadata!)[Tags.SOPInstanceUID];

const sops = (chunks: Chunk[]) => chunks.map(sopOf);

const byId = (updates: CollectionUpdate[]) =>
  [...updates].sort((left, right) => (left.id < right.id ? -1 : 1));

describe('DICOM collection registry', () => {
  it('plans one consistent series into one ordered collection', async () => {
    const registry = createDicomCollectionRegistry();
    const first = chunkFor({ sop: 'a', z: 0 });
    const second = chunkFor({ sop: 'b', z: 1 });
    const third = chunkFor({ sop: 'c', z: 2 });

    // Arrival order deliberately differs from slice order.
    const updates = await registry.register([third, first, second]);

    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(sops(update.members)).toEqual(['a', 'b', 'c']);
    expect(sops(update.added)).toEqual(['a', 'b', 'c']);
    expect(update.collection.order).toBe('spatial');
    expect(update.collection.diagnostics).toEqual([]);
  });

  it('aligns the chunk members with the planned facts', async () => {
    const registry = createDicomCollectionRegistry();
    const chunks = [chunkFor({ sop: 'a', z: 2 }), chunkFor({ sop: 'b', z: 0 })];

    const [update] = await registry.register(chunks);

    expect(update.collection.members.map((m) => m.sopInstanceUid)).toEqual(
      sops(update.members)
    );
  });

  // The DICOMweb store reconciles its own series keyed progress against the
  // loaded volume id by prefix.
  it('mints an id that starts with the series instance uid', async () => {
    const registry = createDicomCollectionRegistry();

    const [update] = await registry.register([chunkFor({ sop: 'a' })]);

    expect(update.id.startsWith(SERIES_UID)).toBe(true);
  });

  it('keeps the collection id and grows its members across two batches', async () => {
    const registry = createDicomCollectionRegistry();
    const first = chunkFor({ sop: 'a', z: 0 });
    const second = chunkFor({ sop: 'b', z: 1 });

    const [firstUpdate] = await registry.register([first]);
    const [secondUpdate] = await registry.register([second]);

    expect(secondUpdate.id).toBe(firstUpdate.id);
    expect(sops(secondUpdate.members)).toEqual(['a', 'b']);
    expect(sops(secondUpdate.added)).toEqual(['b']);
  });

  it('orders a late arriving earlier slice into its planned position', async () => {
    const registry = createDicomCollectionRegistry();
    const first = chunkFor({ sop: 'a', z: 0 });
    const second = chunkFor({ sop: 'b', z: 1 });

    await registry.register([second]);
    const [update] = await registry.register([first]);

    expect(sops(update.members)).toEqual(['a', 'b']);
    expect(sops(update.added)).toEqual(['a']);
  });

  const POSITIONS: Record<string, number> = { a: 0, b: 1, c: 2 };

  const loadBatches = (batches: ReadonlyArray<ReadonlyArray<string>>) => {
    const registry = createDicomCollectionRegistry();
    return batches.reduce(
      (chain, batch) =>
        chain.then(() =>
          registry.register(
            batch.map((sop) => chunkFor({ sop, z: POSITIONS[sop] }))
          )
        ),
      Promise.resolve([] as CollectionUpdate[])
    );
  };

  it.each([
    ['one batch', [['a', 'b', 'c']]],
    ['two batches', [['a'], ['b', 'c']]],
    ['two batches in reverse', [['b', 'c'], ['a']]],
    ['one slice at a time', [['c'], ['a'], ['b']]],
    [
      'a repeated batch',
      [
        ['a', 'b', 'c'],
        ['a', 'b', 'c'],
      ],
    ],
  ] as const)(
    'plans the whole series into one collection when loaded as %s',
    async (_case, batches) => {
      const updates = await loadBatches(batches);

      expect(updates).toHaveLength(1);
      expect(sops(updates[0].members)).toEqual(['a', 'b', 'c']);
    }
  );

  it('gives one series the same id however the slices are batched', async () => {
    const idOf = async (batches: ReadonlyArray<ReadonlyArray<string>>) =>
      (await loadBatches(batches))[0].id;

    const oneBatch = await idOf([['a', 'b', 'c']]);
    expect(await idOf([['a'], ['b', 'c']])).toBe(oneBatch);
    expect(await idOf([['b', 'c'], ['a']])).toBe(oneBatch);
    expect(
      await idOf([
        ['a', 'b', 'c'],
        ['a', 'b', 'c'],
      ])
    ).toBe(oneBatch);
  });

  it('keeps the first chunk registered for a repeated instance uid', async () => {
    const registry = createDicomCollectionRegistry();
    const original = chunkFor({ sop: 'a', z: 0 });
    const resupplied = chunkFor({ sop: 'a', z: 0 });

    await registry.register([original]);
    const [update] = await registry.register([resupplied]);

    expect(update.members).toEqual([original]);
    // The batch's own chunk still reports back, so its provenance can merge.
    expect(update.added).toEqual([resupplied]);
  });

  it('counts one chunk once however often a batch repeats it', async () => {
    const registry = createDicomCollectionRegistry();
    const chunk = chunkFor({ sop: 'a', z: 0 });

    const [update] = await registry.register([chunk, chunk]);

    expect(update.members).toEqual([chunk]);
  });

  it('never merges two instances that carry no instance uid', async () => {
    const registry = createDicomCollectionRegistry();
    const first = chunkFor({ sop: null, z: 0 });
    const second = chunkFor({ sop: null, z: 1 });

    const [update] = await registry.register([first, second]);

    expect(update.members).toEqual([first, second]);
  });

  it('re-registers an anonymous chunk without duplicating it', async () => {
    const registry = createDicomCollectionRegistry();
    const chunk = chunkFor({ sop: null, z: 0 });

    await registry.register([chunk]);
    const [update] = await registry.register([chunk]);

    expect(update.members).toEqual([chunk]);
  });

  it('splits one batch of incompatible instances into two collections', async () => {
    const registry = createDicomCollectionRegistry();
    const scout = chunkFor({ sop: 'scout', rows: '8', z: 0 });
    const slices = [chunkFor({ sop: 'a', z: 0 }), chunkFor({ sop: 'b', z: 1 })];

    const updates = await registry.register([scout, ...slices]);

    expect(updates).toHaveLength(2);
    const membership = updates.map((update) => sops(update.members));
    expect(membership).toContainEqual(['scout']);
    expect(membership).toContainEqual(['a', 'b']);
    expect(updates[0].id).not.toBe(updates[1].id);
    updates.forEach((update) =>
      expect(update.id.startsWith(SERIES_UID)).toBe(true)
    );
  });

  it('leaves an untouched collection out of a later batch', async () => {
    const registry = createDicomCollectionRegistry();
    const scout = chunkFor({ sop: 'scout', rows: '8', z: 0 });
    const slice = chunkFor({ sop: 'a', z: 0 });

    const [sliceUpdate] = await registry.register([slice]);
    const updates = await registry.register([scout]);

    expect(updates).toHaveLength(1);
    expect(sops(updates[0].members)).toEqual(['scout']);
    expect(updates[0].id).not.toBe(sliceUpdate.id);
  });

  it('reports a collection a later batch re-registers unchanged', async () => {
    const registry = createDicomCollectionRegistry();
    const slice = chunkFor({ sop: 'a', z: 0 });

    await registry.register([slice]);
    const updates = await registry.register([slice]);

    expect(updates).toHaveLength(1);
    expect(sops(updates[0].added)).toEqual(['a']);
  });

  it('plans two series independently', async () => {
    const registry = createDicomCollectionRegistry();
    const first = chunkFor({ sop: 'a', series: SERIES_UID });
    const second = chunkFor({ sop: 'b', series: OTHER_SERIES_UID });

    const updates = byId(await registry.register([first, second]));

    expect(updates).toHaveLength(2);
    expect(updates[0].id).not.toBe(updates[1].id);
    const forSeries = (uid: string) =>
      updates.find((update) => update.id.startsWith(uid))!;
    expect(forSeries(SERIES_UID).members).toEqual([first]);
    expect(forSeries(OTHER_SERIES_UID).members).toEqual([second]);
  });

  it('serializes overlapping registrations of one series', async () => {
    const registry = createDicomCollectionRegistry();
    const first = chunkFor({ sop: 'a', z: 0 });
    const second = chunkFor({ sop: 'b', z: 1 });

    const [firstResult, secondResult] = await Promise.all([
      registry.register([first]),
      registry.register([second]),
    ]);

    expect(sops(firstResult[0].members)).toEqual(['a']);
    expect(sops(secondResult[0].members)).toEqual(['a', 'b']);
    expect(secondResult[0].id).toBe(firstResult[0].id);
  });

  it('surfaces the planner order and diagnostics for a positionless series', async () => {
    const registry = createDicomCollectionRegistry();
    const chunks = [
      chunkFor({ sop: 'alpha', z: null, instanceNumber: 2 }),
      chunkFor({ sop: 'beta', z: null, instanceNumber: 1 }),
    ];

    const [update] = await registry.register(chunks);

    expect(sops(update.members)).toEqual(['beta', 'alpha']);
    expect(update.collection.order).toBe('instance-number');
    const diagnostics = update.collection.diagnostics.join(' ');
    expect(diagnostics).toContain('alpha');
    expect(diagnostics).toContain('beta');
  });

  it('refuses a chunk whose metadata has not been read', async () => {
    const registry = createDicomCollectionRegistry();
    const chunk = { metadata: null } as unknown as Chunk;

    await expect(registry.register([chunk])).rejects.toThrow(/metadata/i);
  });

  it('does not mutate the batch it registers', async () => {
    const registry = createDicomCollectionRegistry();
    const chunks = [chunkFor({ sop: 'a', z: 2 }), chunkFor({ sop: 'b', z: 0 })];
    const order = [...chunks];

    await registry.register(chunks);

    expect(chunks).toEqual(order);
  });
});
