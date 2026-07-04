<template>
  <div class="file-widget">
    <div class="text-caption font-weight-medium">
      {{ param.title || param.id }}
      <span v-if="param.required" class="text-error">*</span>
    </div>
    <div v-if="param.help" class="text-caption text-medium-emphasis mb-1">
      {{ param.help }}
    </div>
    <div class="text-caption">
      <span v-if="modelValue" class="text-success"> ✓ input bound </span>
      <span v-else class="text-medium-emphasis">
        Input — binds to the active dataset at submit
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { VolViewTaskParameter } from '@/processing-contract';
import type { SourceRef } from '@/src/processing/types';

// Renders a `sourceRef` input. The bound value ({ type, uris } minted from
// provenance) is wired in Chunk 8; here the input is rendered, not minted.
defineProps<{
  param: VolViewTaskParameter;
  modelValue: SourceRef | string | null | undefined;
}>();
</script>

<style scoped>
.file-widget {
  padding: 6px 0;
}
</style>
