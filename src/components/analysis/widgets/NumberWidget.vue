<template>
  <v-text-field
    :model-value="modelValue ?? ''"
    :label="param.title || param.id"
    :hint="param.help"
    :min="numeric?.min"
    :max="numeric?.max"
    :step="numeric?.step ?? 'any'"
    type="number"
    density="compact"
    hide-details="auto"
    persistent-hint
    @update:model-value="onInput"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { VolViewTaskParameter } from '@/processing-contract';

const props = defineProps<{
  param: VolViewTaskParameter;
  modelValue: number | null | undefined;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: number | null): void;
}>();

// Only int/float carry min/max/step; narrow so the template can read them.
const numeric = computed(() =>
  props.param.kind === 'int' || props.param.kind === 'float'
    ? props.param
    : null
);

function onInput(text: string) {
  if (text === '' || text === null || text === undefined) {
    emit('update:modelValue', null);
    return;
  }
  const isInt = props.param.kind === 'int';
  const parsed = isInt ? parseInt(text, 10) : parseFloat(text);
  emit('update:modelValue', Number.isFinite(parsed) ? parsed : null);
}
</script>
