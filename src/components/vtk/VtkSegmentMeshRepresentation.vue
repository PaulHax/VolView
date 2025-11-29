<script setup lang="ts">
import { inject, toRefs, watchEffect, MaybeRef, computed, unref } from 'vue';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import type { RGBAColor } from '@kitware/vtk.js/types';
import { VtkViewContext } from '@/src/components/vtk/context';
import { useVtkRepresentation } from '@/src/core/vtk/useVtkRepresentation';

type Props = {
  polyData: MaybeRef<vtkPolyData>;
  color: RGBAColor;
  opacity: number;
  visible: boolean;
};

const props = defineProps<Props>();
const { polyData, color, opacity, visible } = toRefs(props);

const view = inject(VtkViewContext);
if (!view) throw new Error('No VtkView');

const polyDataComputed = computed(() => unref(polyData.value));

const rep = useVtkRepresentation({
  view,
  data: polyDataComputed,
  vtkActorClass: vtkActor,
  vtkMapperClass: vtkMapper,
});

watchEffect(() => {
  const [r, g, b] = color.value;
  rep.property.setColor(r / 255, g / 255, b / 255);
  rep.property.setOpacity(opacity.value);
  rep.actor.setVisibility(visible.value);
});

defineExpose(rep);
</script>

<template><slot></slot></template>
