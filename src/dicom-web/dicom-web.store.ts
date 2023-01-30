import { ref, set } from '@vue/composition-api';
import { defineStore } from 'pinia';
import {
  convertSuccessResultToDataSelection,
  useDatasetStore,
} from '../store/datasets';

import { PatientInfo, useDICOMStore } from '../store/datasets-dicom';
import { useMessageStore } from '../store/messages';
import { useDicomMetaStore } from './dicom-meta.store';
import {
  searchForStudies,
  fetchSeries as fetchSeriesFromServer,
  FetchSeriesOptions,
  fetchInstanceThumbnail,
  retrieveStudyMetadata,
} from './dicomWeb';

export enum ProgressState {
  Remote,
  Pending,
  Error,
  Done,
}

interface VolumeProgress {
  state: ProgressState;
  progress: number;
}

interface Progress {
  [name: string]: VolumeProgress;
}

export const isDownloadable = (progress?: VolumeProgress) =>
  !progress ||
  [ProgressState.Pending, ProgressState.Done].every(
    (state) => state !== progress.state
  );

export const DICOM_WEB_CONFIGURED =
  process.env.VUE_APP_DICOM_WEB_URL !== undefined;

async function getAllPatients(host: string): Promise<PatientInfo[]> {
  const instances = await searchForStudies(host);
  const dicoms = useDicomMetaStore();
  instances.forEach((instance) => dicoms.importMeta(instance));
  return Object.values(dicoms.patientInfo);
}

/**
 * Collect DICOM data from DICOMWeb
 */
export const useDicomWebStore = defineStore('dicom-web', () => {
  const host = ref(process.env.VUE_APP_DICOM_WEB_URL as string);
  const isSetup = ref(false);
  const message = ref('');

  const patients = ref([] as PatientInfo[]);

  const fetchDicomList = async () => {
    patients.value = [];
    message.value = '';
    try {
      patients.value = await getAllPatients(host.value);

      if (patients.value.length === 0) {
        message.value = 'Found zero dicoms';
      }
    } catch (e) {
      message.value = 'Failed to fetch list of DICOM metadata';
      console.error(e);
    }
  };

  const fetchVolumeThumbnail = async (volumeKey: string) => {
    const dicoms = useDicomMetaStore();
    const volumeInfo = dicoms.volumeInfo[volumeKey];
    const middleSlice = Math.floor(volumeInfo.NumberOfSlices / 2);
    const middleInstance = dicoms.volumeInstances[volumeKey]
      .map((instanceKey) => dicoms.instanceInfo[instanceKey])
      .sort(
        ({ InstanceNumber: a }, { InstanceNumber: b }) => Number(a) - Number(b)
      )[middleSlice];

    const studyKey = dicoms.volumeStudy[volumeKey];
    const studyInfo = dicoms.studyInfo[studyKey];
    const instance = {
      studyInstanceUID: studyInfo.StudyInstanceUID,
      seriesInstanceUID: volumeInfo.SeriesInstanceUID,
      sopInstanceUID: middleInstance.SopInstanceUID,
    };
    return fetchInstanceThumbnail(host.value, instance);
  };

  const fetchSeries = async (
    seriesInfo: FetchSeriesOptions
  ): Promise<File[]> => {
    return fetchSeriesFromServer(host.value, seriesInfo);
  };

  const fetchPatientMeta = async (patientKey: string) => {
    const dicoms = useDicomMetaStore();
    const studies = await Promise.all(
      dicoms.patientStudies[patientKey]
        .map((studyKey) => dicoms.studyInfo[studyKey])
        .map(({ StudyInstanceUID }) =>
          retrieveStudyMetadata(host.value, {
            studyInstanceUID: StudyInstanceUID,
          })
        )
    );
    studies.flat().forEach((instance) => dicoms.importMeta(instance));
  };

  const volumes = ref({} as Progress);

  const downloadVolume = async (volumeKey: string) => {
    const datasets = useDatasetStore();
    const dicoms = useDicomMetaStore();

    if (!isDownloadable(volumes.value[volumeKey])) return;

    set(volumes.value, volumeKey, {
      ...volumes.value[volumeKey],
      state: ProgressState.Pending,
      progress: 0,
    });

    const { SeriesInstanceUID: seriesInstanceUID } =
      dicoms.volumeInfo[volumeKey];
    const studyKey = dicoms.volumeStudy[volumeKey];
    const { StudyInstanceUID: studyInstanceUID } = dicoms.studyInfo[studyKey];
    const seriesInfo = { studyInstanceUID, seriesInstanceUID };

    try {
      const files = await fetchSeries(seriesInfo);
      if (files) {
        const [loadResult] = await datasets.loadFiles(files);
        if (loadResult?.loaded) {
          const selection = convertSuccessResultToDataSelection(loadResult);
          datasets.setPrimarySelection(selection);
          set(volumes.value, volumeKey, {
            ...volumes.value[volumeKey],
            state: ProgressState.Done,
            progress: 100,
          });
        } else {
          throw new Error('Failed to load DICOM.');
        }
      } else {
        throw new Error('Fetch came back falsy.');
      }
    } catch (error) {
      const messageStore = useMessageStore();
      messageStore.addError('Failed to load DICOM', error as Error);
    }
  };

  const loadedDicoms = useDICOMStore();
  loadedDicoms.$onAction(({ name, args, after }) => {
    console.log(name);
    if (name !== 'deleteVolume') {
      return;
    }
    after(() => {
      const [loadedVolumeKey] = args;
      const volumeKey = Object.keys(volumes.value).find((key) =>
        loadedVolumeKey.startsWith(key)
      );
      if (volumeKey)
        set(volumes.value, volumeKey, {
          ...volumes.value[volumeKey],
          state: ProgressState.Remote,
          progress: 0,
        });
    });
  });

  return {
    host,
    message,
    isSetup,
    patients,
    volumes,
    fetchDicomList,
    fetchVolumeThumbnail,
    fetchSeries,
    fetchPatientMeta,
    downloadVolume,
  };
});
