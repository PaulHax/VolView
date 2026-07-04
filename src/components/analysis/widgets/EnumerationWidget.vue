<template>
  <v-select
    :model-value="modelValue ?? null"
    :items="items"
    :label="param.title || param.id"
    :hint="param.help"
    density="compact"
    hide-details="auto"
    persistent-hint
    @update:model-value="onUpdate"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { VolViewTaskParameter } from '@/processing-contract';

const props = defineProps<{
  param: VolViewTaskParameter;
  modelValue: string | null | undefined;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: string | null): void;
}>();

// The enum options live only on the `enum` kind.
const items = computed(() =>
  props.param.kind === 'enum' ? props.param.options : []
);
const onUpdate = (v: unknown) =>
  emit('update:modelValue', (v ?? null) as string | null);
</script>
