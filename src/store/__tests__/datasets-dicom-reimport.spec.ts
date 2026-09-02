import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import type { Chunk } from '@/src/core/streaming/chunk';
import type DicomChunkImage from '@/src/core/streaming/dicomChunkImage';
import { Tags } from '@/src/core/dicomTags';
import { useImageCacheStore } from '@/src/store/image-cache';
import { useDICOMStore } from '@/src/store/datasets-dicom';

const SERIES_UID = '1.2.826.0.1.3680043.9.7';
const OTHER_SERIES_UID = '1.2.826.0.1.3680043.9.8';

// Records what the DICOM store asks a chunk volume to hold.
class FakeChunkImage {
  setChunksCalls: Chunk[][] = [];

  startLoadCount = 0;

  name = '';

  async setChunks(chunks: Chunk[]) {
    this.setChunksCalls.push(chunks);
  }

  getDicomMetadata() {
    return this.setChunksCalls.at(-1)![0].metadata;
  }

  getChunks() {
    return this.setChunksCalls.at(-1)!.slice();
  }

  setName(name: string) {
    this.name = name;
  }

  getStatus() {
    return 'incomplete';
  }

  isLoading() {
    return false;
  }

  addEventListener() {}

  removeEventListener() {}

  startLoad() {
    this.startLoadCount += 1;
  }

  dispose() {}
}

function imageFactory() {
  const created: FakeChunkImage[] = [];
  const createChunkImage = () => {
    const image = new FakeChunkImage();
    created.push(image);
    return image as unknown as DicomChunkImage;
  };
  return { created, createChunkImage };
}

type SliceOptions = {
  sop: string;
  series?: string;
  z?: number;
  rows?: string;
};

function chunkFor({
  sop,
  series = SERIES_UID,
  z = 0,
  rows = '4',
}: SliceOptions) {
  const metadata = [
    [Tags.SOPClassUID, '1.2.840.10008.5.1.4.1.1.4'],
    [Tags.NumberOfFrames, '1'],
    [Tags.SOPInstanceUID, sop],
    [Tags.PatientID, 'patient-1'],
    [Tags.PatientName, 'Test Patient'],
    [Tags.PatientBirthDate, ''],
    [Tags.PatientSex, ''],
    [Tags.StudyID, 'study-1'],
    [Tags.StudyInstanceUID, '1.2.826.0.1.3680043.9.1'],
    [Tags.StudyDate, ''],
    [Tags.StudyTime, ''],
    [Tags.AccessionNumber, ''],
    [Tags.StudyDescription, ''],
    [Tags.Modality, 'MR'],
    [Tags.SeriesInstanceUID, series],
    [Tags.SeriesNumber, '7'],
    [Tags.SeriesDescription, 'Incremental series'],
    [Tags.WindowLevel, ''],
    [Tags.WindowWidth, ''],
    [Tags.Rows, rows],
    [Tags.Columns, '4'],
    [Tags.SamplesPerPixel, '1'],
    [Tags.ImageOrientationPatient, '1\\0\\0\\0\\1\\0'],
    [Tags.ImagePositionPatient, `0\\0\\${z}`],
    ['0020|0013', String(z + 1)],
  ] as Array<[string, string]>;
  return { metadata } as unknown as Chunk;
}

const onlyId = (volumes: Record<string, Chunk[]>) => {
  const ids = Object.keys(volumes);
  expect(ids).toHaveLength(1);
  return ids[0];
};

describe('DICOM store incremental import', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('asks an already-registered image to load the chunks a re-import adds', async () => {
    const { created, createChunkImage } = imageFactory();
    const first = chunkFor({ sop: 'a', z: 0 });
    const second = chunkFor({ sop: 'b', z: 1 });

    const store = useDICOMStore();
    const firstResult = await store.importChunks([first], { createChunkImage });
    const secondResult = await store.importChunks([second], {
      createChunkImage,
    });

    expect(created).toHaveLength(1);
    const [image] = created;
    expect(image.setChunksCalls).toEqual([[first], [first, second]]);
    expect(image.startLoadCount).toBe(2);

    const id = onlyId(firstResult);
    expect(onlyId(secondResult)).toBe(id);
    expect(useImageCacheStore().imageById[id]).toBe(image);
    // Only the newly imported chunk reports back, for its own provenance.
    expect(secondResult[id]).toEqual([second]);
  });

  it('hands the image the planned order, not the arrival order', async () => {
    const { created, createChunkImage } = imageFactory();
    const first = chunkFor({ sop: 'a', z: 0 });
    const second = chunkFor({ sop: 'b', z: 1 });

    const store = useDICOMStore();
    await store.importChunks([second], { createChunkImage });
    await store.importChunks([first], { createChunkImage });

    expect(created[0].setChunksCalls).toEqual([[second], [first, second]]);
  });

  it('gives one series the same volume id however it is imported', async () => {
    const load = async (batches: string[][]) => {
      setActivePinia(createPinia());
      const { createChunkImage } = imageFactory();
      const store = useDICOMStore();
      return batches.reduce(
        (chain, batch) =>
          chain.then(() =>
            store
              .importChunks(
                batch.map((sop) => chunkFor({ sop, z: sop.charCodeAt(0) })),
                { createChunkImage }
              )
              .then(onlyId)
          ),
        Promise.resolve('')
      );
    };

    const oneBatch = await load([['a', 'b', 'c']]);
    expect(await load([['a'], ['b', 'c']])).toBe(oneBatch);
    expect(await load([['b', 'c'], ['a']])).toBe(oneBatch);
    expect(
      await load([
        ['a', 'b', 'c'],
        ['a', 'b', 'c'],
      ])
    ).toBe(oneBatch);
  });

  it('keeps one member when the same instance arrives twice', async () => {
    const { created, createChunkImage } = imageFactory();
    const original = chunkFor({ sop: 'a', z: 0 });
    const resupplied = chunkFor({ sop: 'a', z: 0 });

    const store = useDICOMStore();
    const first = await store.importChunks([original], { createChunkImage });
    const second = await store.importChunks([resupplied], { createChunkImage });

    expect(created).toHaveLength(1);
    expect(created[0].setChunksCalls).toEqual([[original], [original]]);
    expect(second[onlyId(first)]).toEqual([resupplied]);
    expect(store.volumeInfo[onlyId(first)].NumberOfSlices).toBe(1);
  });

  it('counts every member of the volume after a re-import', async () => {
    const { createChunkImage } = imageFactory();
    const store = useDICOMStore();

    const first = await store.importChunks([chunkFor({ sop: 'a', z: 0 })], {
      createChunkImage,
    });
    await store.importChunks([chunkFor({ sop: 'b', z: 1 })], {
      createChunkImage,
    });

    expect(store.volumeInfo[onlyId(first)].NumberOfSlices).toBe(2);
  });

  it('splits incompatible instances of one series into two volumes', async () => {
    const { created, createChunkImage } = imageFactory();
    const scout = chunkFor({ sop: 'scout', rows: '8', z: 0 });
    const slices = [chunkFor({ sop: 'a', z: 0 }), chunkFor({ sop: 'b', z: 1 })];

    const store = useDICOMStore();
    const result = await store.importChunks([scout, ...slices], {
      createChunkImage,
    });

    expect(created).toHaveLength(2);
    const ids = Object.keys(result);
    expect(ids).toHaveLength(2);
    expect(Object.values(result)).toContainEqual([scout]);
    expect(Object.values(result)).toContainEqual(slices);

    const imageCacheStore = useImageCacheStore();
    ids.forEach((id) => expect(imageCacheStore.imageById[id]).toBeDefined());
    expect(ids.map((id) => store.volumeInfo[id].NumberOfSlices).sort()).toEqual(
      [1, 2]
    );
    expect(store.studyVolumes['1.2.826.0.1.3680043.9.1'].sort()).toEqual(
      [...ids].sort()
    );
  });

  it('keeps two series in one batch apart', async () => {
    const { createChunkImage } = imageFactory();
    const first = chunkFor({ sop: 'a', series: SERIES_UID });
    const second = chunkFor({ sop: 'b', series: OTHER_SERIES_UID });

    const store = useDICOMStore();
    const result = await store.importChunks([first, second], {
      createChunkImage,
    });

    const ids = Object.keys(result);
    expect(ids).toHaveLength(2);
    expect(
      ids.map((id) => store.volumeInfo[id].SeriesInstanceUID).sort()
    ).toEqual([SERIES_UID, OTHER_SERIES_UID].sort());
  });
});
