<template>
  <v-text-field
    :model-value="filename"
    :label="(param.title || param.id) + ' (output filename)'"
    :hint="param.description"
    density="compact"
    hide-details="auto"
    persistent-hint
    @update:model-value="onInput"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ParsedParam } from '@/src/processing/adapters/slicer-cli/parser';
import type { ProcessingOutputRequest } from '@/src/processing/types';

const props = defineProps<{
  param: ParsedParam;
  modelValue: ProcessingOutputRequest | null | undefined;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: ProcessingOutputRequest): void;
}>();

const filename = computed(() => props.modelValue?.name ?? '');

function onInput(text: string) {
  emit('update:modelValue', { name: text });
}
</script>
