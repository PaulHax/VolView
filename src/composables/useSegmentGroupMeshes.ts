import {
  MaybeRef,
  computed,
  onScopeDispose,
  shallowRef,
  unref,
  watchEffect,
} from 'vue';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import { useDebounceFn } from '@vueuse/core';
import { labelmapToPolyDatas } from 'labelmap-polydata/labelmapToPolyDatas';
import { useSegmentGroupStore } from '@/src/store/segmentGroups';
import { onVTKEvent } from '@/src/composables/onVTKEvent';
import LabelmapWorker from './labelmapMesh.worker?worker';

export type PolyDataRecord = Record<number, vtkPolyData>;

export const useSegmentGroupMeshes = (segmentGroupId: MaybeRef<string>) => {
  const segmentGroupStore = useSegmentGroupStore();
  const meshes = shallowRef<PolyDataRecord>({});
  const isGenerating = shallowRef(false);

  const worker = new LabelmapWorker();
  onScopeDispose(() => worker.terminate());

  const labelmap = computed(
    () => segmentGroupStore.dataIndex[unref(segmentGroupId)]
  );

  const regenerate = async () => {
    const lm = labelmap.value;
    if (!lm) {
      meshes.value = {};
      return;
    }

    isGenerating.value = true;
    try {
      const result = await labelmapToPolyDatas(lm, { worker });
      meshes.value = result;
    } catch (e) {
      console.error('Failed to generate meshes:', e);
      meshes.value = {};
    } finally {
      isGenerating.value = false;
    }
  };

  const debouncedRegenerate = useDebounceFn(regenerate, 300);

  onVTKEvent(labelmap, 'onModified', debouncedRegenerate);

  watchEffect(() => {
    if (labelmap.value) {
      regenerate();
    }
  });

  return { meshes, isGenerating };
};
