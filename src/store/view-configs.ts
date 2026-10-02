import { defineStore } from 'pinia';

import useViewSliceStore from './view-configs/slicing';
import { useWindowingStore } from './view-configs/windowing';
import useLayerColoringStore from './view-configs/layers';
import useViewCameraStore from './view-configs/camera';
import useVolumeColoringStore from './view-configs/volume-coloring';
import useCinePlaybackStore from './view-configs/cine-playback';
import { useViewStore } from './views';
import { StateFile, ViewConfig } from '../io/state-file/schema';

// Oblique viewers own these synthetic view IDs for their four renderers.
const ownedViewIDs = (viewID: string) =>
  ['', '-axial', '-coronal', '-sagittal', '-multi-oblique'].map(
    (suffix) => viewID + suffix
  );

const copyConfigs = <T>(
  configs: Record<string, Record<string, T>>,
  sourceID: string,
  targetID: string,
  update: (viewID: string, dataID: string, config: T) => void
) => {
  Object.entries(configs[sourceID] ?? {}).forEach(([dataID, config]) => {
    // Configs contain JSON values; clones keep nested camera/coloring state independent.
    update(targetID, dataID, JSON.parse(JSON.stringify(config)) as T);
  });
};

/**
 * This store saves view configuration that is associated with a specific
 * view. The key is a synthetic id generated from the view ID and data ID.
 */
export const useViewConfigStore = defineStore('viewConfig', () => {
  const viewSliceStore = useViewSliceStore();
  const windowingStore = useWindowingStore();
  const layerColoringStore = useLayerColoringStore();
  const viewCameraStore = useViewCameraStore();
  const volumeColoringStore = useVolumeColoringStore();
  const cinePlaybackStore = useCinePlaybackStore();
  const viewStore = useViewStore();

  const removeView = (viewID: string) => {
    ownedViewIDs(viewID).forEach((id) => {
      viewSliceStore.removeView(id);
      windowingStore.removeView(id);
      layerColoringStore.removeView(id);
      viewCameraStore.removeView(id);
      volumeColoringStore.removeView(id);
      cinePlaybackStore.removeView(id);
    });
  };

  const removeData = (dataID: string, viewID?: string) => {
    viewSliceStore.removeData(dataID, viewID);
    windowingStore.removeData(dataID, viewID);
    layerColoringStore.removeData(dataID, viewID);
    viewCameraStore.removeData(dataID, viewID);
    volumeColoringStore.removeData(dataID, viewID);
    cinePlaybackStore.removeData(dataID, viewID);
  };

  const serialize = (stateFile: StateFile) => {
    viewSliceStore.serialize(stateFile);
    windowingStore.serialize(stateFile);
    layerColoringStore.serialize(stateFile);
    viewCameraStore.serialize(stateFile);
    volumeColoringStore.serialize(stateFile);
    cinePlaybackStore.serialize(stateFile);
  };

  const deserialize = (
    viewID: string,
    config: Record<string, ViewConfig>,
    dataIDMap: Record<string, string>
  ) => {
    // First update the view config map to use the new dataIDs
    const updatedConfig: Record<string, ViewConfig> = {};
    Object.entries(config).forEach(([dataID, viewConfig]) => {
      const newDataID = dataIDMap[dataID];
      // A dataset that failed to restore has no new id to carry its config.
      if (newDataID) updatedConfig[newDataID] = viewConfig;
    });

    viewSliceStore.deserialize(viewID, updatedConfig);
    windowingStore.deserialize(viewID, updatedConfig);
    layerColoringStore.deserialize(viewID, updatedConfig);
    viewCameraStore.deserialize(viewID, updatedConfig);
    volumeColoringStore.deserialize(viewID, updatedConfig);
    cinePlaybackStore.deserialize(viewID, updatedConfig);
  };

  const deserializeAll = (
    manifest: StateFile['manifest'],
    dataIDMap: Record<string, string>
  ) => {
    if (!manifest.viewByID) return;

    Object.entries(manifest.viewByID).forEach(([viewID, view]) => {
      if (view.config) {
        deserialize(viewID, view.config, dataIDMap);
      }
    });
  };

  viewStore.ViewSplitEvent.on((sourceID, targetID) => {
    const sourceIDs = ownedViewIDs(sourceID);
    ownedViewIDs(targetID).forEach((id, index) => {
      const source = sourceIDs[index];
      copyConfigs(
        viewSliceStore.configs,
        source,
        id,
        viewSliceStore.updateConfig
      );
      copyConfigs(
        windowingStore.configs,
        source,
        id,
        windowingStore.updateConfig
      );
      copyConfigs(
        layerColoringStore.configs,
        source,
        id,
        layerColoringStore.updateConfig
      );
      copyConfigs(
        viewCameraStore.configs,
        source,
        id,
        (viewID, dataID, config) => {
          viewCameraStore.updateConfig(viewID, dataID, config);
          viewCameraStore.setAutoFitState(
            viewID,
            dataID,
            viewCameraStore.getAutoFitState(source, dataID)
          );
          if (viewCameraStore.isCameraInitialized(source, dataID)) {
            viewCameraStore.markCameraAsInitialized(viewID, dataID);
          }
        }
      );
      copyConfigs(
        volumeColoringStore.configs,
        source,
        id,
        volumeColoringStore.updateConfig
      );
      copyConfigs(
        cinePlaybackStore.configs,
        source,
        id,
        (viewID, dataID, config) => {
          cinePlaybackStore.updateConfig(viewID, dataID, {
            ...config,
            playing: false,
          });
        }
      );
    });
  });

  viewStore.ViewRemovedEvent.on(removeView);

  return {
    removeView,
    removeData,
    serialize,
    deserialize,
    deserializeAll,
  };
});
