<template>
  <v-text-field
    :model-value="modelValue ?? ''"
    :label="param.title || param.id"
    :hint="param.description"
    density="compact"
    hide-details="auto"
    persistent-hint
    @update:model-value="(v) => emit('update:modelValue', v)"
  />
</template>

<script setup lang="ts">
import type { ParsedParam } from '@/src/processing/adapters/slicer-cli/parser';

defineProps<{
  param: ParsedParam;
  modelValue: string | null | undefined;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
}>();
</script>
