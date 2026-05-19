<template>
  <v-select
    :model-value="modelValue ?? null"
    :items="items"
    :label="param.title || param.id"
    :hint="param.description"
    density="compact"
    variant="outlined"
    hide-details="auto"
    persistent-hint
    @update:model-value="onUpdate"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ParsedParam } from '@/src/processing/adapters/slicer-cli/parser';

type EnumValue = string | number;

const props = defineProps<{
  param: ParsedParam;
  modelValue: EnumValue | null | undefined;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: EnumValue | null): void;
}>();

const items = computed(() => (props.param.values ?? []) as EnumValue[]);
const onUpdate = (v: unknown) =>
  emit('update:modelValue', v as EnumValue | null);
</script>
