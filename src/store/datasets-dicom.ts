import { defineStore } from 'pinia';
import { Image } from 'itk-wasm';
import { Chunk } from '@/src/core/streaming/chunk';
import { useImageCacheStore } from '@/src/store/image-cache';
import DicomChunkImage from '@/src/core/streaming/dicomChunkImage';
import DicomCineImage from '@/src/core/cine/DicomCineImage';
import { parseCineDicom } from '@/src/core/cine/parseCineDicom';
import {
  createDicomCollectionRegistry,
  groupChunksBySeries,
  type CollectionUpdate,
  type DicomCollectionRegistry,
} from '@/src/core/dicom/collectionRegistry';
import type { ProgressiveImage } from '@/src/core/progressiveImage';
import { isUltrasoundMultiframeSopClass, Tags } from '@/src/core/dicomTags';
import { ensureError, removeFromArray } from '../utils';

export const ANONYMOUS_PATIENT = 'Anonymous';
export const ANONYMOUS_PATIENT_ID = 'ANONYMOUS';

export function imageCacheMultiKey(offset: number, asThumbnail: boolean) {
  return `${offset}!!${asThumbnail}`;
}

export type VolumeKeys = {
  patientKey: string;
  studyKey: string;
  volumeKey: string;
};

export type PatientInfo = {
  PatientID: string;
  PatientName: string;
  PatientBirthDate: string;
  PatientSex: string;
};

export type StudyInfo = {
  StudyID: string;
  StudyInstanceUID: string;
  StudyDate: string;
  StudyTime: string;
  AccessionNumber: string;
  StudyDescription: string;
};

export type VolumeInfo = {
  NumberOfSlices: number;
  VolumeID: string;
  Modality: string;
  SeriesInstanceUID: string;
  SeriesNumber: string;
  SeriesDescription: string;
  WindowLevel: string;
  WindowWidth: string;
  // For 'cine', NumberOfSlices is the frame count. Optional for back-compat
  // with saved state that predates the field.
  kind?: 'volume' | 'cine';
};

type State = {
  // volumeKey -> imageCacheMultiKey -> ITKImage
  sliceData: Record<string, Record<string, Image>>;

  // volume invalidation information
  needsRebuild: Record<string, boolean>;

  // patientKey -> patient info
  patientInfo: Record<string, PatientInfo>;
  // patientKey -> array of studyKeys
  patientStudies: Record<string, string[]>;

  // studyKey -> study info
  studyInfo: Record<string, StudyInfo>;
  // studyKey -> array of volumeKeys
  studyVolumes: Record<string, string[]>;

  // volumeKey -> volume info
  volumeInfo: Record<string, VolumeInfo>;

  // parent pointers
  // volumeKey -> studyKey
  volumeStudy: Record<string, string>;
  // studyKey -> patientKey
  studyPatient: Record<string, string>;
};

/**
 * Trims and collapses multiple spaces into one.
 * @param name
 * @returns string
 */
const cleanupName = (name: string) => {
  return name.trim().replace(/\s+/g, ' ');
};

export const getDisplayName = (info: VolumeInfo) => {
  return (
    cleanupName(info.SeriesDescription || info.SeriesNumber) ||
    info.SeriesInstanceUID
  );
};

export function isCineChunkGroup(chunks: Chunk[]): boolean {
  if (chunks.length !== 1) return false;
  const meta = chunks[0].metadata;
  if (!meta) return false;
  const lookup = Object.fromEntries(meta);
  const sopClass = lookup[Tags.SOPClassUID] ?? '';
  const numberOfFrames = parseInt(
    (lookup[Tags.NumberOfFrames] ?? '0').trim(),
    10
  );
  return isUltrasoundMultiframeSopClass(sopClass) && numberOfFrames > 1;
}

export const getWindowLevels = (info: VolumeInfo) => {
  const { WindowWidth, WindowLevel } = info;
  if (
    WindowWidth == null ||
    WindowLevel == null ||
    WindowWidth === '' ||
    WindowLevel === ''
  )
    return []; // missing tag
  const widths = WindowWidth.split('\\').map(parseFloat);
  const levels = WindowLevel.split('\\').map(parseFloat);
  if (
    widths.some((w) => Number.isNaN(w)) ||
    levels.some((l) => Number.isNaN(l))
  ) {
    console.error('Invalid WindowWidth or WindowLevel DICOM tags');
    return [];
  }
  if (widths.length !== levels.length) {
    console.error(
      'Different numbers of WindowWidth and WindowLevel DICOM tags'
    );
    return [];
  }
  return widths.map((width, i) => ({ width, level: levels[i] }));
};

// One import session per store instance, so a fresh pinia replans from nothing
// and the chunks the registry holds stay outside reactive state.
type ImportSession = {
  registry: DicomCollectionRegistry;
  // Series key to the transaction the next import of that series waits on.
  lanes: Map<string, Promise<unknown>>;
};

const sessions = new WeakMap<object, ImportSession>();

const sessionFor = (store: object) => {
  const existing = sessions.get(store);
  if (existing) return existing;
  const created: ImportSession = {
    registry: createDicomCollectionRegistry(),
    lanes: new Map(),
  };
  sessions.set(store, created);
  return created;
};

// Planning, preparing and committing one series must not interleave: a later
// replan can dissolve an ID an earlier call is still inserting, which would
// resurrect the dead volume. Lanes are per series, so one stuck import blocks
// only the series it names.
const inSeriesTransaction = <T>(
  store: object,
  seriesKey: string,
  run: () => Promise<T>
) => {
  const { lanes } = sessionFor(store);
  const transaction = (lanes.get(seriesKey) ?? Promise.resolve()).then(run);
  lanes.set(
    seriesKey,
    transaction.catch(() => {})
  );
  return transaction;
};

// A chunk volume, as this store uses it. An instanceof would refuse an
// injected image, so the capability check names the method it calls.
type ChunkVolume = Pick<DicomChunkImage, 'setChunks' | 'getChunks'>;

const canHoldChunks = (
  image: ProgressiveImage
): image is ProgressiveImage & ChunkVolume =>
  typeof (image as Partial<ChunkVolume>).setChunks === 'function';

export type ImportChunksDeps = {
  createChunkImage?: () => DicomChunkImage;
  parseCineDicom?: typeof parseCineDicom;
};

export type ImportChunksResult = {
  // Collection ID to every chunk whose provenance the collection now covers,
  // not just the ones this batch brought.
  volumes: Record<string, Chunk[]>;
  // Collection IDs a replan dissolved. Their datasets must be removed.
  dissolved: string[];
};

/**
 * A batch whose series did not all commit. Each series commits on its own
 * lane, so what landed is reported alongside the failure instead of being
 * thrown away with it.
 */
export class PartialImportError extends Error {
  readonly committed: ImportChunksResult;

  // The chunks of every series that failed, so the caller blames those sources
  // and not the whole batch.
  readonly failed: Chunk[];

  constructor(cause: Error, committed: ImportChunksResult, failed: Chunk[]) {
    super(cause.message);
    this.name = 'PartialImportError';
    this.cause = cause;
    this.committed = committed;
    this.failed = failed;
  }
}

type DatabaseRecord = {
  patient: PatientInfo;
  study: StudyInfo;
  volume: VolumeInfo;
};

/**
 * One collection's replacement, prepared before any store is touched. `add`
 * builds a fresh image off-store, `grow` has already applied its members to
 * the image an earlier import registered, and `none` is a collection already
 * loaded as it is planned.
 */
type Candidate =
  | { kind: 'none' }
  | {
      kind: 'add';
      id: string;
      image: ProgressiveImage;
      record: DatabaseRecord;
    }
  | {
      kind: 'grow';
      id: string;
      image: ProgressiveImage & ChunkVolume;
      // The membership held before this batch grew the image, so a sibling's
      // failure can put it back.
      previous: Chunk[];
      record: DatabaseRecord;
    };

// Every image a batch builds, so a failure releases them all. An uncommitted
// candidate owns a volume buffer nothing else can free.
const candidateTracker = () => {
  const built: ProgressiveImage[] = [];
  return {
    track: <T extends ProgressiveImage>(image: T) => {
      built.push(image);
      return image;
    },
    release: () => built.forEach((image) => image.dispose()),
  };
};

/**
 * Puts the images a failed batch already grew back to the membership they held,
 * so an abandoned plan leaves no image holding members no record names.
 */
const undoGrowth = (candidates: Candidate[]) =>
  Promise.all(
    candidates.map((candidate) =>
      candidate.kind === 'grow'
        ? candidate.image.setChunks(candidate.previous).catch((err) => {
            console.error('Failed to restore DICOM volume membership', err);
          })
        : null
    )
  );

type PrepareDeps = {
  createChunkImage: () => DicomChunkImage;
  parseCine: typeof parseCineDicom;
  track: ReturnType<typeof candidateTracker>['track'];
};

const volumeRecord = (id: string, members: Chunk[]): DatabaseRecord => {
  const metaPairs = members[0].metadata;
  if (!metaPairs) throw new Error('Metadata not ready');
  const metadata = Object.fromEntries(metaPairs);
  return {
    patient: {
      PatientID: metadata[Tags.PatientID],
      PatientName: metadata[Tags.PatientName],
      PatientBirthDate: metadata[Tags.PatientBirthDate],
      PatientSex: metadata[Tags.PatientSex],
    },
    study: {
      StudyID: metadata[Tags.StudyID],
      StudyInstanceUID: metadata[Tags.StudyInstanceUID],
      StudyDate: metadata[Tags.StudyDate],
      StudyTime: metadata[Tags.StudyTime],
      AccessionNumber: metadata[Tags.AccessionNumber],
      StudyDescription: metadata[Tags.StudyDescription],
    },
    volume: {
      NumberOfSlices: members.length,
      VolumeID: id,
      Modality: metadata[Tags.Modality],
      SeriesInstanceUID: metadata[Tags.SeriesInstanceUID],
      SeriesNumber: metadata[Tags.SeriesNumber],
      SeriesDescription: metadata[Tags.SeriesDescription],
      WindowLevel: metadata[Tags.WindowLevel],
      WindowWidth: metadata[Tags.WindowWidth],
      kind: 'volume',
    },
  };
};

const cineRecord = (
  id: string,
  header: ReturnType<typeof parseCineDicom>['header']
): DatabaseRecord => ({
  patient: header.patient,
  study: header.study,
  volume: {
    NumberOfSlices: header.numberOfFrames,
    VolumeID: id,
    Modality: header.series.Modality,
    SeriesInstanceUID: header.series.SeriesInstanceUID,
    SeriesNumber: header.series.SeriesNumber,
    SeriesDescription: header.series.SeriesDescription,
    WindowLevel: '',
    WindowWidth: '',
    kind: 'cine',
  },
});

const tryParseCine = (parse: typeof parseCineDicom, buffer: ArrayBuffer) => {
  try {
    return parse(buffer);
  } catch (err) {
    console.warn(
      'Failed to parse cine DICOM; falling back to volume import',
      err
    );
    return null;
  }
};

/** Null when the clip is not a cine this app can play, so the volume path takes it. */
async function prepareCine(
  loaded: Record<string, VolumeInfo>,
  id: string,
  chunk: Chunk,
  deps: PrepareDeps
): Promise<Candidate | null> {
  // A state-file reload already built this clip.
  if (loaded[id]?.kind === 'cine') return { kind: 'none' };

  const cachedImage = useImageCacheStore().imageById[id];
  if (cachedImage && !(cachedImage instanceof DicomCineImage)) {
    throw new Error(
      `Volume ${id} is already loaded as a non-cine progressive image; cannot re-import as a cine clip.`
    );
  }

  await chunk.loadData();
  const blob = chunk.dataBlob;
  if (!blob) throw new Error('Cine DICOM chunk has no data');

  const parsed = tryParseCine(deps.parseCine, await blob.arrayBuffer());
  if (!parsed || !DicomCineImage.isSupported(parsed.header)) return null;

  return {
    kind: 'add',
    id,
    image: deps.track(new DicomCineImage(parsed)),
    record: cineRecord(id, parsed.header),
  };
}

async function prepareVolume(
  id: string,
  members: Chunk[],
  deps: PrepareDeps
): Promise<Candidate> {
  const cachedImage = useImageCacheStore().imageById[id];
  if (cachedImage && !canHoldChunks(cachedImage)) {
    throw new Error(
      `Volume ${id} is already loaded as a non-chunk progressive image; cannot re-import as a chunk volume.`
    );
  }

  const record = volumeRecord(id, members);
  // Growth is part of preparation, not of the commit: the members have to be
  // in the image before any record promises them, and a membership the image
  // cannot hold has to fail while the batch can still be abandoned.
  if (cachedImage) {
    const previous = cachedImage.getChunks();
    await cachedImage.setChunks(members);
    return { kind: 'grow', id, image: cachedImage, previous, record };
  }

  const image = deps.track(deps.createChunkImage());
  await image.setChunks(members);
  return { kind: 'add', id, image, record };
}

/** Builds a collection's replacement without touching any store. */
async function prepareCandidate(
  loaded: Record<string, VolumeInfo>,
  { id, members }: CollectionUpdate,
  deps: PrepareDeps
): Promise<Candidate> {
  if (isCineChunkGroup(members)) {
    const cine = await prepareCine(loaded, id, members[0], deps);
    if (cine) return cine;
  }
  return prepareVolume(id, members, deps);
}

type CommitTarget = {
  volumeInfo: Record<string, VolumeInfo>;
  _updateDatabase: (
    patient: PatientInfo,
    study: StudyInfo,
    volume: VolumeInfo
  ) => void;
  deleteVolume: (volumeKey: string) => void;
};

/**
 * Applies a prepared batch. Synchronous by contract: no await separates the
 * first store mutation from the last, and stale IDs go last so nothing visible
 * is removed before its replacement exists.
 */
function commitPlan(
  store: CommitTarget,
  candidates: Candidate[],
  dissolved: string[]
) {
  const imageCacheStore = useImageCacheStore();

  candidates.forEach((candidate) => {
    if (candidate.kind === 'none') return;

    if (candidate.kind === 'grow') {
      // The image already holds the members preparation gave it, so this load
      // covers them.
      candidate.image.startLoad();
    } else {
      imageCacheStore.addProgressiveImage(candidate.image, {
        id: candidate.id,
      });
    }

    const { patient, study, volume } = candidate.record;
    store._updateDatabase(patient, study, volume);
    candidate.image.setName(getDisplayName(volume));
  });

  dissolved.forEach((id) => {
    imageCacheStore.removeImage(id);
    store.deleteVolume(id);
  });
}

export const useDICOMStore = defineStore('dicom', {
  state: (): State => ({
    sliceData: {},
    patientInfo: {},
    patientStudies: {},
    studyInfo: {},
    studyVolumes: {},
    volumeInfo: {},
    volumeStudy: {},
    studyPatient: {},
    needsRebuild: {},
  }),
  actions: {
    async importChunks(
      chunks: Chunk[],
      deps: ImportChunksDeps = {}
    ): Promise<ImportChunksResult> {
      const createChunkImage =
        deps.createChunkImage ?? (() => new DicomChunkImage());
      const parseCine = deps.parseCineDicom ?? parseCineDicom;
      const { registry } = sessionFor(this);

      const batches = [...groupChunksBySeries(chunks)];
      const perSeries = batches.map(([seriesKey, batch]) =>
        inSeriesTransaction(this, seriesKey, async () => {
          const { updates, removed, rollback } = await registry.register(batch);

          const { track, release } = candidateTracker();
          const prepared = await Promise.allSettled(
            updates.map((update) =>
              prepareCandidate(this.volumeInfo, update, {
                createChunkImage,
                parseCine,
                track,
              })
            )
          );

          const candidates = prepared.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : []
          );
          const failure = prepared.find(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected'
          );
          if (failure) {
            // Every candidate has settled, so nothing is still writing to the
            // images this puts back before the lane releases.
            await undoGrowth(candidates);
            release();
            // A failure must not pin its chunks, or a corrected re-import
            // keeps receiving the one that failed.
            rollback([seriesKey]);
            throw failure.reason;
          }

          commitPlan(this, candidates, removed);

          return {
            volumes: updates.map(
              ({ id, provenance }) => [id, provenance] as const
            ),
            dissolved: removed,
          };
        })
      );

      const settled = await Promise.allSettled(perSeries);
      const results = settled.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      );
      const committed = {
        volumes: Object.fromEntries(results.flatMap(({ volumes }) => volumes)),
        dissolved: results.flatMap(({ dissolved }) => dissolved),
      };

      const failure = settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected'
      );
      // A lane that committed still has datasets to reconcile, so a sibling's
      // failure reports what landed instead of discarding it, and names only
      // the chunks whose own lane failed.
      if (failure)
        throw new PartialImportError(
          ensureError(failure.reason),
          committed,
          settled.flatMap((result, index) =>
            result.status === 'rejected' ? batches[index][1] : []
          )
        );

      return committed;
    },

    _updateDatabase(
      patient: PatientInfo,
      study: StudyInfo,
      volume: VolumeInfo
    ) {
      const patientKey = patient.PatientID;
      const studyKey = study.StudyInstanceUID;
      const volumeKey = volume.VolumeID;

      if (!(patientKey in this.patientInfo)) {
        this.patientInfo[patientKey] = patient;
        this.patientStudies[patientKey] = [];
      }

      if (!(studyKey in this.studyInfo)) {
        this.studyInfo[studyKey] = study;
        this.studyVolumes[studyKey] = [];
        this.studyPatient[studyKey] = patientKey;
        this.patientStudies[patientKey].push(studyKey);
      }

      if (!(volumeKey in this.volumeInfo)) {
        this.volumeStudy[volumeKey] = studyKey;
        this.sliceData[volumeKey] = {};
        this.studyVolumes[studyKey].push(volumeKey);
      }
      // A re-import grows the membership, so the record is rewritten.
      this.volumeInfo[volumeKey] = volume;
    },

    // You should probably call datasetStore.remove instead as this does not
    // remove files/images/layers associated with the volume
    deleteVolume(volumeKey: string) {
      // Releases the chunks the registry pinned for this collection, so a
      // removed volume stops holding its DICOM bytes.
      sessionFor(this).registry.forget(volumeKey);

      if (volumeKey in this.volumeInfo) {
        const studyKey = this.volumeStudy[volumeKey];
        delete this.volumeInfo[volumeKey];
        delete this.sliceData[volumeKey];
        delete this.volumeStudy[volumeKey];

        removeFromArray(this.studyVolumes[studyKey], volumeKey);
        if (this.studyVolumes[studyKey].length === 0) {
          this._deleteStudy(studyKey);
        }
      }
    },

    _deleteStudy(studyKey: string) {
      if (studyKey in this.studyInfo) {
        const patientKey = this.studyPatient[studyKey];
        delete this.studyInfo[studyKey];
        delete this.studyPatient[studyKey];

        [...this.studyVolumes[studyKey]].forEach((volumeKey) =>
          this.deleteVolume(volumeKey)
        );
        delete this.studyVolumes[studyKey];

        removeFromArray(this.patientStudies[patientKey], studyKey);
        if (this.patientStudies[patientKey].length === 0) {
          this._deletePatient(patientKey);
        }
      }
    },

    _deletePatient(patientKey: string) {
      if (patientKey in this.patientInfo) {
        delete this.patientInfo[patientKey];

        [...this.patientStudies[patientKey]].forEach((studyKey) =>
          this._deleteStudy(studyKey)
        );
        delete this.patientStudies[patientKey];
      }
    },
  },
});
