<template>
  <div class="file-widget">
    <div class="text-caption font-weight-medium">
      {{ param.title || param.id }}
      <span v-if="param.required" class="text-error">*</span>
    </div>
    <div class="text-caption text-medium-emphasis mb-1">
      {{ param.description }}
    </div>
    <div class="text-caption">
      <span v-if="modelValue" class="text-success">
        ✓ bound to active dataset
      </span>
      <span v-else class="text-medium-emphasis">
        (No active dataset — load one first)
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ParsedParam } from '@/src/processing/adapters/slicer-cli/parser';
import type { SourceRef } from '@/src/processing/types';

defineProps<{
  param: ParsedParam;
  modelValue: SourceRef | string | null | undefined;
  sourceLabel?: string;
}>();
</script>

<style scoped>
.file-widget {
  padding: 6px 0;
}
</style>
