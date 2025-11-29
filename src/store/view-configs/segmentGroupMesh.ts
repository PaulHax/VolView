import { reactive, computed, unref, MaybeRef } from 'vue';
import { defineStore } from 'pinia';

import {
  DoubleKeyRecord,
  deleteSecondKey,
  getDoubleKeyRecord,
  patchDoubleKeyRecord,
} from '@/src/utils/doubleKeyRecord';
import { Maybe } from '@/src/types';
import { SegmentGroupMeshConfig } from '@/src/store/view-configs/types';

type Config = SegmentGroupMeshConfig;

export const defaultConfig = (): Config => ({
  enabled: false,
  opacity: 1.0,
});

export const useSegmentGroupMeshConfigStore = defineStore(
  'segmentGroupMeshConfig',
  () => {
    const configs = reactive<DoubleKeyRecord<Config>>({});

    const getConfig = (viewID: Maybe<string>, dataID: Maybe<string>) =>
      getDoubleKeyRecord(configs, viewID, dataID) ?? defaultConfig();

    const updateConfig = (
      viewID: string,
      dataID: string,
      patch: Partial<Config>
    ) => {
      const config = {
        ...defaultConfig(),
        ...getConfig(viewID, dataID),
        ...patch,
      };

      patchDoubleKeyRecord(configs, viewID, dataID, config);
    };

    const removeView = (viewID: string) => {
      delete configs[viewID];
    };

    const removeData = (dataID: string, viewID?: string) => {
      if (viewID) {
        delete configs[viewID]?.[dataID];
      } else {
        deleteSecondKey(configs, dataID);
      }
    };

    const updateAllConfigs = (dataID: string, patch: Partial<Config>) => {
      Object.keys(configs).forEach((viewID) => {
        updateConfig(viewID, dataID, patch);
      });
    };

    return {
      configs,
      getConfig,
      updateConfig,
      removeView,
      removeData,
      updateAllConfigs,
    };
  }
);

export const useGlobalSegmentGroupMeshConfig = (dataId: MaybeRef<string>) => {
  const store = useSegmentGroupMeshConfigStore();

  const configs = computed(() =>
    Object.keys(store.configs).map((viewID) => ({
      config: store.getConfig(viewID, unref(dataId)),
      viewID,
    }))
  );

  const config = computed(() => configs.value[0]?.config ?? defaultConfig());

  const updateConfig = (patch: Partial<Config>) => {
    const id = unref(dataId);
    if (configs.value.length === 0) {
      store.updateConfig('3D', id, patch);
    } else {
      configs.value.forEach(({ viewID }) =>
        store.updateConfig(viewID, id, patch)
      );
    }
  };

  return { config, updateConfig };
};
