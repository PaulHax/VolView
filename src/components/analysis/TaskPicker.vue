<template>
  <v-select
    v-model="selected"
    :items="tasks"
    item-title="title"
    item-value="id"
    label="Task"
    density="compact"
    variant="outlined"
    hide-details
    @update:model-value="(v) => emit('update:taskId', v as string | null)"
  />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { SlicerCliTaskSummary } from '@/src/processing/types';

const props = defineProps<{
  tasks: SlicerCliTaskSummary[];
  modelValue?: string | null;
}>();
const emit = defineEmits<{
  (e: 'update:taskId', id: string | null): void;
}>();

const selected = ref<string | null>(props.modelValue ?? null);
watch(
  () => props.modelValue,
  (v) => {
    selected.value = v ?? null;
  }
);
</script>
