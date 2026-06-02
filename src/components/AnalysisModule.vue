<template>
  <div class="analysis-module pa-3">
    <div class="text-h6 mb-2">Analysis</div>
    <div
      v-if="providers.providerCount === 0"
      class="text-caption text-medium-emphasis"
    >
      No analysis providers are configured for this dataset.
    </div>

    <template v-else>
      <v-select
        v-if="showProviderSelect"
        v-model="selectedProviderId"
        :items="providerItems"
        item-title="label"
        item-value="id"
        label="Provider"
        density="compact"
        hide-details
        class="mb-3"
      />

      <div v-if="loadingProvider" class="text-caption text-medium-emphasis">
        Loading provider…
      </div>
      <div v-else-if="providerError" class="text-error text-caption">
        {{ providerError }}
      </div>

      <template v-if="provider">
        <TaskPicker
          v-if="tasks.length"
          :tasks="tasks"
          :model-value="selectedTaskId"
          @update:task-id="onTaskSelected"
          class="mb-3"
        />
        <div v-else class="text-caption text-medium-emphasis mb-3">
          No tasks available.
        </div>

        <div v-if="loadingTask" class="text-caption">Loading task spec…</div>
        <TaskForm
          v-else-if="doc"
          :doc="doc"
          :initial-values="initialValues"
          :issues="issues"
          :submitting="submitting"
          @update:values="onValuesUpdate"
          @submit="onSubmit"
        />
      </template>

      <JobList class="mt-4" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useToast } from 'vue-toastification';

import { useProvidersStore } from '@/src/store/providers';
import { useCurrentImage } from '@/src/composables/useCurrentImage';
import { useImageCacheStore } from '@/src/store/image-cache';
import { autoLoadProcessingResults } from '@/src/actions/processResults';
import type {
  ProcessingProvider,
  ProcessingValue,
  SlicerCliTaskSummary,
} from '@/src/processing/types';
import type {
  SlicerCliDocument,
  SlicerCliValidationIssue,
} from '@/src/processing/adapters/slicer-cli';
import type { ParsedParam } from '@/src/processing/adapters/slicer-cli/parser';

import TaskPicker from './analysis/TaskPicker.vue';
import TaskForm from './analysis/TaskForm.vue';
import JobList from './analysis/JobList.vue';

const providers = useProvidersStore();
const { currentImageID } = useCurrentImage('global');
const imageCache = useImageCacheStore();
const toast = useToast();

const providerItems = computed(() =>
  Array.from(providers.configs.values()).map((c) => ({
    id: c.id,
    label: c.label,
  }))
);
const showProviderSelect = computed(() => providerItems.value.length > 1);

const selectedProviderId = ref<string | null>(
  providerItems.value[0]?.id ?? null
);

const provider = ref<ProcessingProvider | null>(null);
const loadingProvider = ref(false);
const providerError = ref<string | null>(null);

const tasks = ref<SlicerCliTaskSummary[]>([]);
const selectedTaskId = ref<string | null>(null);

const doc = ref<SlicerCliDocument | null>(null);
const loadingTask = ref(false);
const initialValues = ref<Record<string, ProcessingValue>>({});
const currentValues = ref<Record<string, ProcessingValue>>({});
const issues = ref<SlicerCliValidationIssue[]>([]);
const submitting = ref(false);

watch(
  providerItems,
  (items) => {
    if (items.length === 0) {
      selectedProviderId.value = null;
      return;
    }
    if (
      !selectedProviderId.value ||
      !items.some((item) => item.id === selectedProviderId.value)
    ) {
      selectedProviderId.value = items[0].id;
    }
  },
  { immediate: true }
);

watch(
  selectedProviderId,
  async (id) => {
    provider.value = null;
    tasks.value = [];
    doc.value = null;
    selectedTaskId.value = null;
    if (!id) return;
    loadingProvider.value = true;
    providerError.value = null;
    try {
      const p = await providers.getProvider(id);
      provider.value = p;
      const ctx = providers.configs.get(id)?.context ?? { loadedSources: [] };
      tasks.value = await p.listTasks(ctx);
      if (tasks.value.length > 0) {
        // Will trigger the selectedTaskId watcher below.
        selectedTaskId.value = tasks.value[0].id;
      }
    } catch (err) {
      providerError.value = (err as Error).message;
    } finally {
      loadingProvider.value = false;
    }
  },
  { immediate: true }
);

watch(selectedTaskId, (id) => {
  onTaskSelected(id);
});

async function onTaskSelected(taskId: string | null) {
  selectedTaskId.value = taskId;
  if (!taskId || !provider.value) {
    doc.value = null;
    return;
  }
  loadingTask.value = true;
  doc.value = null;
  try {
    const xml = await provider.value.getTaskXml(taskId);
    const adapter = await import('@/src/processing/adapters/slicer-cli');
    const parsed = adapter.parseXml(xml);
    doc.value = parsed;
    const defaults = await provider.value.getDefaultBindings(taskId, {
      loadedSources: [],
    });
    const initial = adapter.getInitialValues(parsed, defaults);
    // Pre-bind first required image/file input to the active source ref.
    const first = firstRequiredInput(parsed);
    if (first && !initial[first.id] && activeSourceRef.value) {
      initial[first.id] = activeSourceRef.value;
    }
    initialValues.value = initial;
    currentValues.value = { ...initial };
    issues.value = adapter.validate(parsed, currentValues.value);
  } finally {
    loadingTask.value = false;
  }
}

async function onValuesUpdate(values: Record<string, ProcessingValue>) {
  currentValues.value = values;
  if (!doc.value) return;
  const adapter = await import('@/src/processing/adapters/slicer-cli');
  issues.value = adapter.validate(doc.value, values);
}

async function onSubmit(values: Record<string, ProcessingValue>) {
  if (!provider.value || !selectedTaskId.value || !selectedProviderId.value)
    return;
  submitting.value = true;
  try {
    const config = providers.configs.get(selectedProviderId.value);
    const jobId = await providers.submitJob(
      selectedProviderId.value,
      selectedTaskId.value,
      values,
      {
        activeSourceRef:
          config?.context?.activeSourceRef ?? activeSourceRef.value,
        activeDatasetId: currentImageID.value ?? undefined,
      }
    );

    console.log('[analysis] submitted jobId=', jobId);
  } catch (err) {
    console.error('[analysis] submit failed', err);
  } finally {
    submitting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Active-dataset binding
// ---------------------------------------------------------------------------

const activeSourceRef = computed(() => {
  const config = providers.configs.get(selectedProviderId.value ?? '');
  if (!config?.context) return undefined;
  // Multi-dataset matching is post-MVP. For the folder-launch case the config
  // either advertises a single source or an explicit `activeSourceRef`, so
  // we prefer that. Strict file-name matching against the active DICOM image
  // would always fail (DICOM-series names come from headers, not file names).
  const sources = config.context.loadedSources ?? [];
  if (sources.length === 1 && sources[0].sourceRef) {
    return sources[0].sourceRef;
  }
  if (currentImageID.value) {
    const name = imageCache.getImageMetadata(currentImageID.value)?.name;
    if (name) {
      const match = sources.find((s) => s.name === name);
      if (match?.sourceRef) return match.sourceRef;
    }
  }
  return config.context.activeSourceRef ?? sources[0]?.sourceRef ?? undefined;
});

const firstRequiredInput = (d: SlicerCliDocument | null) => {
  if (!d) return null;
  const required = d.parameters.find(
    (p: ParsedParam) =>
      (p.type === 'image' || p.type === 'file') &&
      p.channel === 'input' &&
      p.required
  );
  if (required) return required;
  return (
    d.parameters.find(
      (p: ParsedParam) =>
        (p.type === 'image' || p.type === 'file') && p.channel === 'input'
    ) ?? null
  );
};

// When the active source ref changes after the form has been rendered (e.g.
// the active dataset changes mid-flow), re-bind the first input.
watch(activeSourceRef, (nextRef) => {
  if (!nextRef || !doc.value) return;
  const first = firstRequiredInput(doc.value);
  if (!first) return;
  if (initialValues.value[first.id]) return;
  initialValues.value = { ...initialValues.value, [first.id]: nextRef };
});

// ---------------------------------------------------------------------------
// Result loading + completion toasts
// ---------------------------------------------------------------------------

const seenToastJobs = new Set<string>();
let unsubscribe: (() => void) | null = null;

onMounted(() => {
  unsubscribe = providers.onJobComplete((status, results, context) => {
    if (seenToastJobs.has(status.jobId)) return;
    seenToastJobs.add(status.jobId);
    if (status.state === 'success') {
      // Auto-load only overlays (segment groups). Everything else waits for
      // a user click in JobList so we don't clobber the current view.
      autoLoadProcessingResults(results, context).catch((err) => {
        console.error('Failed to auto-load results', err);
      });
      const count = results.length;
      toast.success(
        `Job complete. ${count} result${count === 1 ? '' : 's'} available — open from the Jobs panel.`,
        { timeout: 5000 }
      );
    } else if (status.state === 'error') {
      toast.error(
        `Job failed${status.errorTail ? `: ${status.errorTail.slice(0, 80)}` : ''}`
      );
    } else if (status.state === 'cancelled') {
      toast.info('Job cancelled');
    }
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
});
</script>

<style scoped>
.analysis-module {
  height: 100%;
  overflow: auto;
}
</style>
