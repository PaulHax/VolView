<script setup lang="ts">
import ViewLayoutActions from '@/src/components/ViewLayoutActions.vue';
import { useViewStore } from '@/src/store/views';
import { Maybe } from '@/src/types';
import { computed, toRefs } from 'vue';

const props = defineProps<{
  viewId: string;
  imageId: Maybe<string>;
}>();
const { viewId, imageId } = toRefs(props);

const viewStore = useViewStore();

const viewName = computed(() => {
  const viewInfo = viewStore.getView(viewId.value);
  return viewInfo?.name ?? '';
});

const availableViewNames = computed(() =>
  viewStore.availableViewsForSwitcher.map((v) => v.name)
);

function updateView(newViewName: string) {
  const selectedView = viewStore.availableViewsForSwitcher.find(
    (v) => v.name === newViewName
  );
  if (!selectedView) return;
  viewStore.replaceView(viewId.value, {
    ...selectedView,
    dataID: imageId.value,
  });
}
</script>

<template>
  <div class="view-controls pointer-events-all" @dblclick.stop>
    <ViewLayoutActions :view-id="viewId" />
    <v-select
      :model-value="viewName"
      @update:model-value="updateView($event)"
      :items="availableViewNames"
      density="compact"
      hide-details
      variant="solo"
      class="pointer-events-all view-type-select"
      aria-label="View type"
    ></v-select>
  </div>
</template>

<style scoped>
.view-controls {
  position: absolute;
  right: 4px;
  bottom: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.view-type-select {
  width: 90px;
  flex: 0 0 90px;
  max-width: 90px;
  font-size: 0.8125rem;
  margin-left: auto;
  color: rgb(var(--v-theme-on-surface));
  text-shadow: none;
  letter-spacing: normal;
}

.view-type-select :deep(.v-field__input) {
  padding: 0 4px;
  min-height: 20px;
  text-align: right;
  font-size: 0.8125rem;
}

.view-type-select :deep(.v-field) {
  min-height: 20px;
}

.view-type-select :deep(.v-field__append-inner) {
  padding-top: 0;
  padding-right: 2px;
}

.view-type-select :deep(.v-input__control) {
  min-height: 20px;
}

.view-type-select :deep(.v-field__overlay) {
  background-color: transparent;
}

.view-type-select :deep(.v-icon) {
  font-size: 0.875rem;
}
</style>
