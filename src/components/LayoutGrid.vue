<script setup lang="ts">
import { computed } from 'vue';
import type { Layout } from '@/src/types/layout';
import { useViewStore } from '@/src/store/views';
import { useToolStore } from '@/src/store/tools';
import { Tools } from '@/src/store/tools/types';
import { getLayoutSlots } from '@/src/utils/layoutEditing';
import LayoutGridItem from '@/src/components/LayoutGridItem.vue';

const props = defineProps<{ layout: Layout }>();
const viewStore = useViewStore();

const items = computed(() =>
  getLayoutSlots(props.layout).flatMap(
    ({ slotIndex, left, top, width, height }) => {
      const view = viewStore.getViewForSlot(slotIndex);
      return view
        ? [
            {
              viewId: view.id,
              style: {
                left: `${left}%`,
                top: `${top}%`,
                width: `${width}%`,
                height: `${height}%`,
              },
            },
          ]
        : [];
    }
  )
);

function maximize(id: string) {
  if (useToolStore().currentTool !== Tools.Polygon) {
    viewStore.setActiveView(id);
    viewStore.toggleActiveViewMaximized();
  }
}
</script>

<template>
  <div class="layout-container flex-equal">
    <LayoutGridItem
      v-for="item in items"
      :key="item.viewId"
      class="layout-item"
      :style="item.style"
      :view-id="item.viewId"
      @pointerdown.capture="viewStore.setActiveView(item.viewId)"
      @dblclick="maximize(item.viewId)"
    />
  </div>
</template>

<style scoped src="@/src/components/styles/utils.css"></style>
<style scoped>
.layout-container {
  position: relative;
  min-height: 0;
}
.layout-item {
  position: absolute;
  display: flex;
  min-width: 0;
  min-height: 0;
}
</style>
