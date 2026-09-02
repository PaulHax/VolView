import { defineStore } from 'pinia';
import { Image } from 'itk-wasm';
import { Chunk } from '@/src/core/streaming/chunk';
import { useImageCacheStore } from '@/src/store/image-cache';
import DicomChunkImage from '@/src/core/streaming/dicomChunkImage';
import DicomCineImage from '@/src/core/cine/DicomCineImage';
import { parseCineDicom } from '@/src/core/cine/parseCineDicom';
import {
  createDicomCollectionRegistry,
  type DicomCollectionRegistry,
} from '@/src/core/dicom/collectionRegistry';
import type { ProgressiveImage } from '@/src/core/progressiveImage';
import { isUltrasoundMultiframeSopClass, Tags } from '@/src/core/dicomTags';
import { removeFromArray } from '../utils';

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
  transactions: Promise<unknown>;
};

const sessions = new WeakMap<object, ImportSession>();

const sessionFor = (store: object) => {
  const existing = sessions.get(store);
  if (existing) return existing;
  const created: ImportSession = {
    registry: createDicomCollectionRegistry(),
    transactions: Promise.resolve(),
  };
  sessions.set(store, created);
  return created;
};

// Planning and applying must not interleave: a later replan can dissolve an ID
// an earlier call is still inserting, which would resurrect the dead volume.
const inTransaction = <T>(store: object, run: () => Promise<T>) => {
  const session = sessionFor(store);
  const transaction = session.transactions.then(run);
  session.transactions = transaction.catch(() => {});
  return transaction;
};

// Everything the store asks of a chunk volume, so the capability check below
// names exactly what it calls. An instanceof would refuse an injected image.
type ChunkVolume = Pick<
  DicomChunkImage,
  'setChunks' | 'startLoad' | 'getChunks' | 'getDicomMetadata' | 'setName'
>;

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
      const imageCacheStore = useImageCacheStore();

      return inTransaction(this, async () => {
        const { updates, removed, rollback } =
          await sessionFor(this).registry.register(chunks);

        // A replan can dissolve a collection by moving its members elsewhere.
        // Undo exactly what a previous import created for that ID.
        removed.forEach((id) => {
          imageCacheStore.removeImage(id);
          this.deleteVolume(id);
        });

        const applied = await Promise.allSettled(
          updates.map(async ({ id, members }) => {
            if (isCineChunkGroup(members)) {
              const importedAsCine = await this._importCineChunk(
                id,
                members[0],
                parseCine
              );
              if (importedAsCine) return;
            }

            const cachedImage = imageCacheStore.imageById[id];
            if (cachedImage && !canHoldChunks(cachedImage)) {
              throw new Error(
                `Volume ${id} is already loaded as a non-chunk progressive image; cannot re-import as a chunk volume.`
              );
            }
            const image = cachedImage ?? createChunkImage();

            await image.setChunks(members);
            // Registration starts the first load; a re-import starts its own.
            if (cachedImage) image.startLoad();
            else imageCacheStore.addProgressiveImage(image, { id });

            // update database
            const metaPairs = image.getDicomMetadata();
            if (!metaPairs) throw new Error('Metdata not ready');
            const metadata = Object.fromEntries(metaPairs);

            const patientInfo: PatientInfo = {
              PatientID: metadata[Tags.PatientID],
              PatientName: metadata[Tags.PatientName],
              PatientBirthDate: metadata[Tags.PatientBirthDate],
              PatientSex: metadata[Tags.PatientSex],
            };

            const studyInfo: StudyInfo = {
              StudyID: metadata[Tags.StudyID],
              StudyInstanceUID: metadata[Tags.StudyInstanceUID],
              StudyDate: metadata[Tags.StudyDate],
              StudyTime: metadata[Tags.StudyTime],
              AccessionNumber: metadata[Tags.AccessionNumber],
              StudyDescription: metadata[Tags.StudyDescription],
            };

            const volumeInfo: VolumeInfo = {
              NumberOfSlices: image.getChunks().length,
              VolumeID: id,
              Modality: metadata[Tags.Modality],
              SeriesInstanceUID: metadata[Tags.SeriesInstanceUID],
              SeriesNumber: metadata[Tags.SeriesNumber],
              SeriesDescription: metadata[Tags.SeriesDescription],
              WindowLevel: metadata[Tags.WindowLevel],
              WindowWidth: metadata[Tags.WindowWidth],
              kind: 'volume',
            };

            this._updateDatabase(patientInfo, studyInfo, volumeInfo);

            // save the image name
            image.setName(getDisplayName(volumeInfo));
          })
        );

        const rejected = applied.flatMap((result, index) =>
          result.status === 'rejected'
            ? [{ update: updates[index], reason: result.reason }]
            : []
        );
        if (rejected.length > 0) {
          // An uncommitted failure must not pin its chunks, or a corrected
          // re-import keeps receiving the one that failed.
          rollback(rejected.map(({ update }) => update.seriesKey));
          throw rejected[0].reason;
        }

        return {
          volumes: Object.fromEntries(
            updates.map(({ id, provenance }) => [id, provenance])
          ),
          dissolved: removed,
        };
      });
    },

    async _importCineChunk(
      id: string,
      chunk: Chunk,
      parseCine: typeof parseCineDicom = parseCineDicom
    ): Promise<boolean> {
      const imageCacheStore = useImageCacheStore();

      // If we already created this cine image (state-file reload), bail.
      if (this.volumeInfo[id]?.kind === 'cine') {
        return true;
      }

      const cachedImage = imageCacheStore.imageById[id];
      if (cachedImage && !(cachedImage instanceof DicomCineImage)) {
        throw new Error(
          `Volume ${id} is already loaded as a non-cine progressive image; cannot re-import as a cine clip.`
        );
      }

      await chunk.loadData();
      const blob = chunk.dataBlob;
      if (!blob) throw new Error('Cine DICOM chunk has no data');
      const buffer = await blob.arrayBuffer();
      let parsed: ReturnType<typeof parseCineDicom>;
      try {
        parsed = parseCine(buffer);
      } catch (err) {
        console.warn(
          'Failed to parse cine DICOM; falling back to volume import',
          err
        );
        return false;
      }

      if (!DicomCineImage.isSupported(parsed.header)) {
        return false;
      }

      const image = new DicomCineImage(parsed);
      imageCacheStore.addProgressiveImage(image, { id });

      const { patient, study, series } = parsed.header;
      const volumeInfo: VolumeInfo = {
        NumberOfSlices: parsed.header.numberOfFrames,
        VolumeID: id,
        Modality: series.Modality,
        SeriesInstanceUID: series.SeriesInstanceUID,
        SeriesNumber: series.SeriesNumber,
        SeriesDescription: series.SeriesDescription,
        WindowLevel: '',
        WindowWidth: '',
        kind: 'cine',
      };

      this._updateDatabase(patient, study, volumeInfo);

      image.setName(getDisplayName(volumeInfo));
      return true;
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
