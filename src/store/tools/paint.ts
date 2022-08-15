import { useCurrentImage } from '@/src/composables/useCurrentImage';
import { ref, watch } from '@vue/composition-api';
import { vec3 } from 'gl-matrix';
import { defineStore } from 'pinia';
import { useLabelmapStore } from '../datasets-labelmaps';

export const usePaintToolStore = defineStore('paint', () => {
  type _This = ReturnType<typeof usePaintToolStore>;

  const activeLabelmapID = ref<string | null>(null);
  const brushSize = ref(8);
  const brushValue = ref(1);
  const strokePoints = ref<vec3[]>([]);
  const labelmapOpacity = ref(1);
  const isActive = ref(false);

  const { currentImageID } = useCurrentImage();

  function getWidgetFactory(this: _This) {
    return this.$paint.factory;
  }

  // --- actions --- //

  function selectOrCreateLabelmap(imageID: string | null) {
    if (!imageID) {
      activeLabelmapID.value = null;
      return;
    }

    const labelmapStore = useLabelmapStore();
    const found = Object.entries(labelmapStore.parentImage).find(
      ([, parentID]) => imageID === parentID
    );
    if (found) {
      [activeLabelmapID.value] = found;
    } else {
      activeLabelmapID.value = labelmapStore.newLabelmapFromImage(imageID);
    }
  }

  function setBrushSize(this: _This, size: number) {
    brushSize.value = Math.round(size);
    this.$paint.setBrushSize(size);
  }

  function setBrushValue(this: _This, value: number) {
    brushValue.value = value;
    this.$paint.setBrushValue(value);
  }

  function setLabelmapOpacity(opacity: number) {
    if (opacity >= 0 && opacity <= 1) {
      labelmapOpacity.value = opacity;
    }
  }

  function doPaintStroke(this: _This, axisIndex: 0 | 1 | 2) {
    if (!activeLabelmapID.value) {
      return;
    }

    const labelmapStore = useLabelmapStore();
    const labelmap = labelmapStore.labelmaps[activeLabelmapID.value];
    if (!labelmap) {
      return;
    }

    const lastIndex = strokePoints.value.length - 1;
    if (lastIndex >= 0) {
      const lastPoint = strokePoints.value[lastIndex];
      const prevPoint =
        lastIndex >= 1 ? strokePoints.value[lastIndex - 1] : undefined;
      this.$paint.paintLabelmap(labelmap, axisIndex, lastPoint, prevPoint);
    }
  }

  function startStroke(this: _This, indexPoint: vec3, axisIndex: 0 | 1 | 2) {
    strokePoints.value = [vec3.clone(indexPoint)];
    doPaintStroke.call(this, axisIndex);
  }

  function placeStrokePoint(
    this: _This,
    indexPoint: vec3,
    axisIndex: 0 | 1 | 2
  ) {
    strokePoints.value.push(indexPoint);
    doPaintStroke.call(this, axisIndex);
  }

  function endStroke(this: _This, indexPoint: vec3, axisIndex: 0 | 1 | 2) {
    strokePoints.value.push(indexPoint);
    doPaintStroke.call(this, axisIndex);
  }

  // --- setup and teardown --- //

  function setup(this: _This) {
    const imageID = currentImageID.value;
    if (!imageID) {
      return false;
    }
    selectOrCreateLabelmap(imageID);
    this.$paint.setBrushSize(this.brushSize);

    isActive.value = true;
    return true;
  }

  function teardown() {
    activeLabelmapID.value = null;
    isActive.value = false;
  }

  // --- change labelmap if paint is active --- //

  watch(currentImageID, (imageID) => {
    if (isActive.value) {
      selectOrCreateLabelmap(imageID);
    }
  });

  return {
    // state
    activeLabelmapID,
    brushSize,
    brushValue,
    strokePoints,
    labelmapOpacity,
    isActive,

    // actions and getters
    getWidgetFactory,
    setup,
    teardown,
    selectOrCreateLabelmap,
    setBrushSize,
    setBrushValue,
    setLabelmapOpacity,
    startStroke,
    placeStrokePoint,
    endStroke,
  };
});
