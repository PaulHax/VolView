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
      <span v-if="binding === 'no-provenance'" class="text-error">
        The active volume was not loaded from the server, so it cannot be used
        as an input.
      </span>
      <span v-else-if="binding === 'ambiguous'" class="text-error">
        This task needs more than one image input, which this version cannot
        bind automatically.
      </span>
      <span v-else-if="boundUriCount > 0" class="text-success">
        ✓ bound to the active dataset ({{ boundUriCount }}
        {{ boundUriCount === 1 ? 'file' : 'files' }})
      </span>
      <span v-else class="text-medium-emphasis">
        Input — binds to the active dataset at submit
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { VolViewTaskParameter, InputValue } from '@/processing-contract';
import type { SourceRefBindingState } from '@/src/processing/engine/mintInput';

// Renders a `sourceRef` input. The bound value ({ type, format?, uris }) is
// minted from the active volume's provenance by the parent (Chunk 8); this
// widget only reflects that state — it never mints, and there is no picker (v1).
const props = defineProps<{
  param: VolViewTaskParameter;
  modelValue: InputValue | null | undefined;
  // Fail-closed/bound state resolved by the parent's provenance mint.
  binding?: SourceRefBindingState;
}>();

const boundUriCount = computed(() => props.modelValue?.uris.length ?? 0);
</script>

<style scoped>
.file-widget {
  padding: 6px 0;
}
</style>
