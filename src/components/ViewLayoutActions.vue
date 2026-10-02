<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import { useElementSize } from '@vueuse/core';
import type { LayoutDirection } from '@/src/types/layout';
import { useViewStore } from '@/src/store/views';
import ReasonedAction from '@/src/components/ReasonedAction.vue';

const props = defineProps<{ viewId: string }>();
const viewStore = useViewStore();
const control = useTemplateRef<HTMLElement>('control');
const container = computed(() =>
  control.value?.closest<HTMLElement>('.layout-container')
);
const { width, height } = useElementSize(container);
const splitReasons = computed(() => {
  const bounds = viewStore.getViewLayoutBounds(props.viewId);
  if (!bounds || !width.value || !height.value) {
    return {
      row: 'View size is not available yet',
      column: 'View size is not available yet',
    };
  }
  const paneWidth = (width.value * bounds.width) / 100;
  const paneHeight = (height.value * bounds.height) / 100;
  return {
    row:
      paneWidth < 320
        ? 'This view is too narrow to split side by side'
        : paneHeight < 120
          ? 'This view is too short to keep its controls usable'
          : '',
    column:
      paneHeight < 240
        ? 'This view is too short to split top and bottom'
        : paneWidth < 160
          ? 'This view is too narrow to keep its controls usable'
          : '',
  };
});
const closeReason = computed(() =>
  viewStore.layoutViews.length <= 1 ? 'Keep at least one view open' : ''
);

function split(direction: LayoutDirection) {
  if (!splitReasons.value[direction]) {
    viewStore.splitView(props.viewId, direction);
  }
}
</script>

<template>
  <span ref="control" class="d-inline-flex">
    <v-menu location="top end">
      <template #activator="{ props: menuProps }">
        <v-btn
          v-bind="menuProps"
          icon="mdi-view-split-vertical"
          size="x-small"
          variant="text"
          class="pointer-events-all"
          aria-label="Split or close view"
          @click.stop
          @dblclick.stop
        >
          <v-icon size="small">mdi-view-split-vertical</v-icon>
          <v-tooltip activator="parent" location="top"
            >Split or close view</v-tooltip
          >
        </v-btn>
      </template>
      <v-list density="compact" aria-label="View actions">
        <ReasonedAction :reason="splitReasons.row" block v-slot="{ disabled }">
          <v-list-item
            prepend-icon="mdi-view-column-outline"
            title="Split side by side"
            :disabled="disabled"
            @click="split('row')"
          />
        </ReasonedAction>
        <ReasonedAction
          :reason="splitReasons.column"
          block
          v-slot="{ disabled }"
        >
          <v-list-item
            prepend-icon="mdi-view-agenda-outline"
            title="Split top and bottom"
            :disabled="disabled"
            @click="split('column')"
          />
        </ReasonedAction>
        <v-divider />
        <ReasonedAction :reason="closeReason" block v-slot="{ disabled }">
          <v-list-item
            prepend-icon="mdi-close"
            title="Close view"
            :disabled="disabled"
            @click="viewStore.closeView(viewId)"
          />
        </ReasonedAction>
      </v-list>
    </v-menu>
  </span>
</template>
