<script setup lang="ts">
import { computed, toRefs } from 'vue';
import VtkSegmentMeshRepresentation from '@/src/components/vtk/VtkSegmentMeshRepresentation.vue';
import { useSegmentGroupMeshes } from '@/src/composables/useSegmentGroupMeshes';
import { useSegmentGroupStore } from '@/src/store/segmentGroups';
import { useSegmentGroupMeshConfigStore } from '@/src/store/view-configs/segmentGroupMesh';

type Props = {
  viewId: string;
  segmentGroupId: string;
};

const props = defineProps<Props>();
const { viewId, segmentGroupId } = toRefs(props);

const segmentGroupStore = useSegmentGroupStore();
const meshConfigStore = useSegmentGroupMeshConfigStore();

const { meshes } = useSegmentGroupMeshes(segmentGroupId);

const meshConfig = computed(() =>
  meshConfigStore.getConfig(viewId.value, segmentGroupId.value)
);

const metadata = computed(
  () => segmentGroupStore.metadataByID[segmentGroupId.value]
);

const visibleSegments = computed(() => {
  if (!metadata.value || !meshConfig.value.enabled) return [];

  const { segments } = metadata.value;
  return segments.order
    .map((value) => ({
      value,
      segment: segments.byValue[value],
      polyData: meshes.value[value],
    }))
    .filter(({ segment, polyData }) => segment.visible && polyData);
});
</script>

<template>
  <vtk-segment-mesh-representation
    v-for="{ value, segment, polyData } in visibleSegments"
    :key="value"
    :poly-data="polyData"
    :color="segment.color"
    :opacity="meshConfig.opacity"
    :visible="segment.visible"
  />
</template>
