<template>
  <v-text-field
    :model-value="modelValue ?? ''"
    :label="param.title || param.id"
    :hint="param.description"
    :min="param.min"
    :max="param.max"
    :step="param.step ?? 'any'"
    type="number"
    density="compact"
    hide-details="auto"
    persistent-hint
    @update:model-value="onInput"
  />
</template>

<script setup lang="ts">
import type { ParsedParam } from '@/src/processing/adapters/slicer-cli/parser';

const props = defineProps<{
  param: ParsedParam;
  modelValue: number | null | undefined;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: number | null): void;
}>();

function onInput(text: string) {
  if (text === '' || text === null || text === undefined) {
    emit('update:modelValue', null);
    return;
  }
  const isInt = props.param.slicerType === 'integer';
  const parsed = isInt ? parseInt(text, 10) : parseFloat(text);
  emit('update:modelValue', Number.isFinite(parsed) ? parsed : null);
}
</script>
