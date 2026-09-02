import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import type { Chunk } from '@/src/core/streaming/chunk';
import { FILE_EXT_TO_MIME } from '@/src/io/mimeTypes';
import type { ChunkSource, DataSource } from '@/src/io/import/dataSource';
import { uriToDataSource } from '@/src/io/import/dataSource';
import { importDicomChunkSources } from '@/src/io/import/importDataSources';
import { useDatasetStore } from '@/src/store/datasets';
import { useImageCacheStore } from '@/src/store/image-cache';
import {
  useDICOMStore,
  type ImportChunksResult,
} from '@/src/store/datasets-dicom';
import { tilt } from '@/src/core/dicom/__tests__/orientationFixtures';
import {
  cineHeader,
  cineParseResult,
} from '@/src/core/cine/__tests__/cineFixtures';
import {
  chunkFor,
  cineChunkFor,
  flush,
  imageFactory,
  sopOf,
  OTHER_SERIES_UID,
  SERIES_UID,
  STUDY_UID,
  type FakeChunkImage,
} from '@/src/store/__tests__/dicomImportFixtures';

const BUFFER_FAILURE = 'cannot allocate the volume buffer';

const never = () => new Promise<void>(() => {});

const failsAt = (failing: number) => (index: number) =>
  index === failing
    ? Promise.reject(new Error(BUFFER_FAILURE))
    : Promise.resolve();

const onlyId = ({ volumes }: ImportChunksResult) => {
  const ids = Object.keys(volumes);
  expect(ids).toHaveLength(1);
  return ids[0];
};

// A scout of a different size never shares a collection with the slices, so
// one batch of one series carries two collections.
const scoutBatch = () => ({
  scout: chunkFor({ sop: 'scout', rows: '8', z: 0 }),
  slices: [chunkFor({ sop: 'a', z: 0 }), chunkFor({ sop: 'b', z: 1 })],
});

/**
 * Orientation agreement is a tolerance, so a bucket depends on which instance
 * the walk meets first. `one` and `three` agree with each other and plan as a
 * single collection; once `zero` and `two` arrive the walk starts from `zero`,
 * and the pair splits into {zero, one} and {two, three}. Neither half holds a
 * plurality of the committed collection, so both mint fresh IDs and the
 * committed ID dissolves.
 */
const splitting = () => ({
  zero: chunkFor({ sop: 'sop-0', z: 0, orientation: tilt(0) }),
  one: chunkFor({ sop: 'sop-1', z: 1, orientation: tilt(0.013) }),
  two: chunkFor({ sop: 'sop-2', z: 2, orientation: tilt(0.039) }),
  three: chunkFor({ sop: 'sop-3', z: 3, orientation: tilt(0.026) }),
});

const cachedIds = () => Object.keys(useImageCacheStore().imageById);

/** Loads one slice, then fails a batch that grows it and adds a scout. */
const growAndFail = async () => {
  const { created, createChunkImage } = imageFactory({ onPrepare: failsAt(1) });
  const store = useDICOMStore();
  const first = chunkFor({ sop: 'a', z: 0 });
  const second = chunkFor({ sop: 'b', z: 1 });
  const scout = chunkFor({ sop: 'scout', rows: '8', z: 0 });

  const id = onlyId(await store.importChunks([first], { createChunkImage }));
  await expect(
    store.importChunks([second, scout], { createChunkImage })
  ).rejects.toThrow(/buffer/);

  return { store, id, first, second, scout, created };
};

/** Loads the pair a later batch splits into two fresh collections. */
const loadSplittablePair = async () => {
  const chunks = splitting();
  const loaded = imageFactory();
  const store = useDICOMStore();
  const id = onlyId(
    await store.importChunks([chunks.one, chunks.three], {
      createChunkImage: loaded.createChunkImage,
    })
  );
  return { ...chunks, store, loaded, id };
};

describe('DICOM store transactional commit', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('registers nothing while a candidate for the series is still preparing', async () => {
    const { createChunkImage } = imageFactory({
      onPrepare: (index) => (index === 1 ? never() : Promise.resolve()),
    });
    const store = useDICOMStore();
    const { scout, slices } = scoutBatch();

    store
      .importChunks([scout, ...slices], { createChunkImage })
      .catch(() => {});
    await flush();

    // The prepared candidate stays off-store until every candidate exists.
    expect(cachedIds()).toEqual([]);
    expect(store.volumeInfo).toEqual({});
    expect(store.studyVolumes).toEqual({});
    expect(store.patientInfo).toEqual({});
  });

  it('commits every collection of a batch in one synchronous step', async () => {
    const store = useDICOMStore();
    const imageCacheStore = useImageCacheStore();
    const seen: Array<[number, number]> = [];
    // Probes the stores from the first microtask after a registration. A commit
    // that awaits between its mutations lets the probe run half way through.
    const { createChunkImage } = imageFactory({
      onPrepare: (index) =>
        index === 1
          ? new Promise<void>((resolve) => {
              setTimeout(resolve, 0);
            })
          : Promise.resolve(),
      onStartLoad: () =>
        queueMicrotask(() =>
          seen.push([
            Object.keys(imageCacheStore.imageById).length,
            Object.keys(store.volumeInfo).length,
          ])
        ),
    });
    const { scout, slices } = scoutBatch();

    await store.importChunks([scout, ...slices], { createChunkImage });
    await flush();

    expect(seen).toEqual([
      [2, 2],
      [2, 2],
    ]);
  });

  it('commits nothing for a series when one of its candidates fails to prepare', async () => {
    const { createChunkImage } = imageFactory({ onPrepare: failsAt(1) });
    const store = useDICOMStore();
    const { scout, slices } = scoutBatch();

    await expect(
      store.importChunks([scout, ...slices], { createChunkImage })
    ).rejects.toThrow(/buffer/);

    expect(cachedIds()).toEqual([]);
    expect(store.volumeInfo).toEqual({});
    expect(store.sliceData).toEqual({});
    expect(store.volumeStudy).toEqual({});
    expect(store.studyVolumes).toEqual({});
    expect(store.studyInfo).toEqual({});
    expect(store.patientInfo).toEqual({});
    expect(store.patientStudies).toEqual({});
  });

  it('disposes the candidates a failed batch prepared', async () => {
    const { created, createChunkImage } = imageFactory({
      onPrepare: failsAt(1),
    });
    const store = useDICOMStore();
    const { scout, slices } = scoutBatch();

    await expect(
      store.importChunks([scout, ...slices], { createChunkImage })
    ).rejects.toThrow(/buffer/);

    expect(created).toHaveLength(2);
    // An uncommitted candidate owns a volume buffer nothing else can release.
    expect(created.map((image) => image.disposeCount)).toEqual([1, 1]);
    expect(created.map((image) => image.startLoadCount)).toEqual([0, 0]);
  });

  it('leaves a loaded volume unchanged when a new candidate fails', async () => {
    const { store, id, first, created } = await growAndFail();

    const [loaded, candidate] = created;
    // Growth is applied at commit, so a failed sibling leaves the volume alone.
    expect(loaded.setChunksCalls).toEqual([[first]]);
    expect(loaded.disposeCount).toBe(0);
    expect(candidate.disposeCount).toBe(1);
    expect(cachedIds()).toEqual([id]);
    expect(store.volumeInfo[id].NumberOfSlices).toBe(1);
    expect(store.studyVolumes[STUDY_UID]).toEqual([id]);
  });

  it('lets the next import of the series commit after a failed batch', async () => {
    const { store, id, first, scout, created } = await growAndFail();

    const retry = imageFactory();
    const corrected = chunkFor({ sop: 'b', z: 1 });
    const result = await store.importChunks([corrected, scout], {
      createChunkImage: retry.createChunkImage,
    });

    // The unchanged key keeps its ID, and only the scout needs a new image.
    const ids = Object.keys(result.volumes);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(id);
    expect(retry.created).toHaveLength(1);

    const scoutId = ids.find((other) => other !== id)!;
    // Identity, not shape: the failed batch must not pin the chunk it brought.
    expect(result.volumes[id]).toEqual([first, corrected]);
    expect(result.volumes[id][1]).toBe(corrected);
    expect(result.volumes[scoutId]).toEqual([scout]);
    const grown = created[0].setChunksCalls.at(-1)!;
    expect(grown).toHaveLength(2);
    expect(grown[0]).toBe(first);
    expect(grown[1]).toBe(corrected);
    expect(store.volumeInfo[id].NumberOfSlices).toBe(2);
    expect(store.volumeInfo[scoutId].NumberOfSlices).toBe(1);
  });

  it('keeps a dissolved volume until its replacements exist', async () => {
    const { store, id, zero, two, loaded } = await loadSplittablePair();

    const failing = imageFactory({ onPrepare: failsAt(1) });
    await expect(
      store.importChunks([zero, two], {
        createChunkImage: failing.createChunkImage,
      })
    ).rejects.toThrow(/buffer/);

    // Stale IDs go last: the replan dissolves this one, but nothing replaced it.
    expect(cachedIds()).toEqual([id]);
    expect(store.volumeInfo[id].NumberOfSlices).toBe(2);
    expect(store.studyVolumes[STUDY_UID]).toEqual([id]);
    expect(loaded.created[0].disposeCount).toBe(0);
    expect(failing.created).toHaveLength(2);
    expect(failing.created.map((image) => image.disposeCount)).toEqual([1, 1]);
  });

  it('removes the dissolved volume once the split commits', async () => {
    const { store, id, zero, one, two, three, loaded } =
      await loadSplittablePair();

    const split = imageFactory();
    const result = await store.importChunks([zero, two], {
      createChunkImage: split.createChunkImage,
    });

    expect(result.dissolved).toEqual([id]);
    const ids = Object.keys(result.volumes);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(id);
    expect(store.volumeInfo[id]).toBeUndefined();
    expect(cachedIds().sort()).toEqual([...ids].sort());
    expect(store.studyVolumes[STUDY_UID].sort()).toEqual([...ids].sort());
    expect(ids.map((each) => store.volumeInfo[each].NumberOfSlices)).toEqual([
      2, 2,
    ]);
    // Each half carries the provenance of the member it inherited.
    expect(Object.values(result.volumes)).toContainEqual([zero, one]);
    expect(Object.values(result.volumes)).toContainEqual([two, three]);
    expect(loaded.created[0].disposeCount).toBe(1);
  });

  it('converges on the one-shot plan when one series is imported concurrently', async () => {
    const sops = (image: FakeChunkImage) =>
      (image.setChunksCalls.at(-1) ?? []).map(sopOf);

    const state = (created: FakeChunkImage[]) => {
      const store = useDICOMStore();
      return {
        volumes: Object.fromEntries(
          Object.entries(store.volumeInfo).map(([id, info]) => [
            id,
            info.NumberOfSlices,
          ])
        ),
        members: created.map(sops),
      };
    };

    const oneShot = async () => {
      setActivePinia(createPinia());
      const { created, createChunkImage } = imageFactory();
      await useDICOMStore().importChunks(
        [chunkFor({ sop: 'a', z: 0 }), chunkFor({ sop: 'b', z: 1 })],
        { createChunkImage }
      );
      return state(created);
    };

    const concurrent = async () => {
      setActivePinia(createPinia());
      const { created, createChunkImage } = imageFactory();
      const store = useDICOMStore();
      await Promise.all([
        store.importChunks([chunkFor({ sop: 'a', z: 0 })], {
          createChunkImage,
        }),
        store.importChunks([chunkFor({ sop: 'b', z: 1 })], {
          createChunkImage,
        }),
      ]);
      return state(created);
    };

    expect(await concurrent()).toEqual(await oneShot());
  });

  it('registers no cine image when a sibling candidate fails', async () => {
    const { createChunkImage } = imageFactory({ onPrepare: failsAt(0) });
    const store = useDICOMStore();
    const cine = cineChunkFor('cine');
    const slices = [chunkFor({ sop: 'a', z: 0 }), chunkFor({ sop: 'b', z: 1 })];

    await expect(
      store.importChunks([cine, ...slices], {
        createChunkImage,
        parseCineDicom: () => cineParseResult(cineHeader()),
      })
    ).rejects.toThrow(/buffer/);

    // A cine clip is a candidate like any other: it reaches no store alone.
    expect(cachedIds()).toEqual([]);
    expect(store.volumeInfo).toEqual({});
    expect(store.studyVolumes).toEqual({});
  });

  it('lets another series commit while one series is still preparing', async () => {
    const { createChunkImage } = imageFactory({
      onPrepare: (_index, chunks) =>
        sopOf(chunks[0]) === 'stuck' ? never() : Promise.resolve(),
    });
    const store = useDICOMStore();

    store
      .importChunks([chunkFor({ sop: 'stuck', series: SERIES_UID })], {
        createChunkImage,
      })
      .catch(() => {});
    const other = store.importChunks(
      [chunkFor({ sop: 'other', series: OTHER_SERIES_UID })],
      { createChunkImage }
    );

    // Each series runs on its own chain, so an outstanding one blocks no other.
    const settled = await Promise.race([
      other.then(() => 'committed'),
      flush().then(() => 'blocked'),
    ]);
    expect(settled).toBe('committed');

    expect(
      Object.values(store.volumeInfo).map((i) => i.SeriesInstanceUID)
    ).toEqual([OTHER_SERIES_UID]);
  });
});

const sourceFor = (chunk: Chunk) => {
  const name = `${sopOf(chunk)}.dcm`;
  const source: DataSource = {
    type: 'chunk',
    chunk,
    mime: FILE_EXT_TO_MIME.dcm,
    parent: uriToDataSource(`https://ex/${name}`, name, FILE_EXT_TO_MIME.dcm),
  };
  return source as DataSource & ChunkSource;
};

const sopsOfDataset = (dataSource: DataSource | undefined) => {
  if (dataSource?.type !== 'collection') throw new Error('Expected collection');
  return dataSource.sources.map((src) => {
    if (src.type !== 'chunk') throw new Error('Expected a chunk source');
    return sopOf(src.chunk);
  });
};

describe('importDicomChunkSources transactional commit', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('leaves the dataset list and its provenance unchanged when a commit fails', async () => {
    const { zero, one, two, three } = splitting();
    const store = useDICOMStore();
    const datasetStore = useDatasetStore();

    const load = async (
      chunks: Chunk[],
      createChunkImage: ReturnType<typeof imageFactory>['createChunkImage']
    ) => {
      const loadables = await importDicomChunkSources(
        chunks.map(sourceFor),
        (batch) => store.importChunks(batch, { createChunkImage })
      );
      datasetStore.addDataSources(
        loadables.map(({ dataID, dataSource }) => ({ dataID, dataSource }))
      );
      return loadables;
    };

    const [loadable] = await load(
      [one, three],
      imageFactory().createChunkImage
    );
    const id = loadable.dataID;
    expect(sopsOfDataset(datasetStore.getDataSource(id))).toEqual([
      'sop-1',
      'sop-3',
    ]);

    await expect(
      load(
        [zero, two],
        imageFactory({ onPrepare: failsAt(1) }).createChunkImage
      )
    ).rejects.toThrow(/buffer/);

    expect(datasetStore.idsAsSelections).toEqual([id]);
    expect(sopsOfDataset(datasetStore.getDataSource(id))).toEqual([
      'sop-1',
      'sop-3',
    ]);
    expect(cachedIds()).toEqual([id]);
    expect(store.volumeInfo[id].NumberOfSlices).toBe(2);
  });
});
