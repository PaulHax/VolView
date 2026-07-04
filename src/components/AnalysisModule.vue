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
        <div v-else-if="taskError" class="text-error text-caption">
          {{ taskError }}
        </div>
        <TaskForm
          v-else-if="taskModel"
          :model="taskModel"
          :initial-values="initialValues"
          :issues="issues"
          :source-ref-states="sourceRefStates"
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
import { useDatasetStore } from '@/src/store/datasets';
import { useCropStore } from '@/src/store/tools/crop';
import { autoLoadProcessingResults } from '@/src/actions/processResults';
import type {
  ProcessingProvider,
  ProcessingValue,
  SlicerCliTaskSummary,
} from '@/src/processing/types';
import {
  buildTaskFormModel,
  initialFormValues,
  validateFormValues,
  type TaskFormModel,
  type FormValidationIssue,
} from '@/src/processing/engine/formModel';
import {
  bindImageInputs,
  type SourceRefBindingState,
} from '@/src/processing/engine/mintInput';
import { cropPlanesToWorldBounds } from '@/src/processing/engine/bounds';

import TaskPicker from './analysis/TaskPicker.vue';
import TaskForm from './analysis/TaskForm.vue';
import JobList from './analysis/JobList.vue';

const providers = useProvidersStore();
const { currentImageID } = useCurrentImage('global');
const imageCache = useImageCacheStore();
const datasetStore = useDatasetStore();
const cropStore = useCropStore();
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

const taskModel = ref<TaskFormModel | null>(null);
const loadingTask = ref(false);
const taskError = ref<string | null>(null);
const initialValues = ref<Record<string, ProcessingValue>>({});
const currentValues = ref<Record<string, ProcessingValue>>({});
const issues = ref<FormValidationIssue[]>([]);
// Per-`sourceRef`-param bind state, surfaced inline by FileWidget (Seam-1 mint).
const sourceRefStates = ref<Record<string, SourceRefBindingState>>({});
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
    taskModel.value = null;
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

// ---------------------------------------------------------------------------
// Task spec → form model
//
// Fetch the server-emitted, zod-validated task spec and render the form from
// it. No XML is parsed at runtime; the engine hides any param it cannot type
// and refuses submit if a required one was hidden (fail closed).
// ---------------------------------------------------------------------------

async function onTaskSelected(taskId: string | null) {
  selectedTaskId.value = taskId;
  if (!taskId || !provider.value) {
    taskModel.value = null;
    return;
  }
  loadingTask.value = true;
  taskError.value = null;
  taskModel.value = null;
  try {
    const envelope = await provider.value.getTaskSpec(taskId);
    const model = buildTaskFormModel(envelope);
    taskModel.value = model;
    const initial = applyActiveBindings(model, initialFormValues(model));
    initialValues.value = initial;
    currentValues.value = { ...initial };
    issues.value = computeIssues(model, initial);
  } catch (err) {
    taskError.value = (err as Error).message;
  } finally {
    loadingTask.value = false;
  }
}

function onValuesUpdate(values: Record<string, ProcessingValue>) {
  currentValues.value = values;
  if (!taskModel.value) return;
  issues.value = computeIssues(taskModel.value, values);
}

async function onSubmit(values: Record<string, ProcessingValue>) {
  if (!provider.value || !selectedTaskId.value || !selectedProviderId.value)
    return;
  const model = taskModel.value;
  if (!model) return;

  // Seam-1 client half (Chunk 8): mint the bound input value from the active
  // volume's OWN provenance at submit, then fail closed if anything is
  // unbindable or invalid — never submit a volume with no server URIs.
  const finalValues = applyActiveBindings(model, values);
  const finalIssues = computeIssues(model, finalValues);
  if (finalIssues.length > 0) {
    currentValues.value = finalValues;
    issues.value = finalIssues;
    return;
  }

  submitting.value = true;
  try {
    const config = providers.configs.get(selectedProviderId.value);
    const jobId = await providers.submitJob(
      selectedProviderId.value,
      selectedTaskId.value,
      finalValues,
      {
        activeSourceRef: config?.context?.activeSourceRef,
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
// `bounds` binds from the crop tool
//
// A `bounds` parameter takes its value from the crop box of the active image,
// converted to a world-space LPS 6-tuple. It tracks the crop tool: re-binding
// whenever the active image or its crop box changes.
// ---------------------------------------------------------------------------

function worldBoundsForActive() {
  const id = currentImageID.value;
  if (!id) return null;
  const planes = cropStore.croppingByImageID[id];
  if (!planes) return null;
  const meta = imageCache.getImageMetadata(id);
  if (!meta) return null;
  return cropPlanesToWorldBounds(
    planes,
    meta.indexToWorld,
    meta.lpsOrientation
  );
}

function applyBoundsBindings(
  model: TaskFormModel,
  values: Record<string, ProcessingValue>
): Record<string, ProcessingValue> {
  const world = worldBoundsForActive();
  if (!world) return values;
  const next = { ...values };
  model.fields.forEach((f) => {
    if (f.kind === 'bounds') next[f.id] = [...world];
  });
  return next;
}

// ---------------------------------------------------------------------------
// Seam-1 input binding (contract "Seam 1 — inputs", client half; Chunk 8)
//
// The background image input auto-binds to the ACTIVE dataset: its value is
// minted from that volume's OWN provenance (its verbatim server URIs), never a
// facade-advertised source. A volume with no URI provenance (local drop /
// archive / restored state) is not bindable — the widget says so inline and
// submit is refused. Bounds and image inputs both track the active image, so
// they rebind together whenever it (or its crop box) changes.
// ---------------------------------------------------------------------------

function activeDataSource() {
  return datasetStore.getDataSource(currentImageID.value);
}

// Apply every active-image-derived binding (crop bounds + the minted image
// input) onto a base value set, overwriting only the bound params.
function applyActiveBindings(
  model: TaskFormModel,
  base: Record<string, ProcessingValue>
): Record<string, ProcessingValue> {
  const withBounds = applyBoundsBindings(model, base);
  const image = bindImageInputs(model, activeDataSource());
  return { ...withBounds, ...image.values };
}

// Recompute the submit-gating issues and refresh the per-widget bind state. The
// image params are gated by the mint (fail closed on no-provenance or >1 image
// input), which owns them fully, so the generic per-param check is suppressed
// for them to avoid a duplicate "required" message.
function computeIssues(
  model: TaskFormModel,
  values: Record<string, ProcessingValue>
): FormValidationIssue[] {
  const image = bindImageInputs(model, activeDataSource());
  sourceRefStates.value = image.states;
  const imageParams = new Set(Object.keys(image.states));
  const generic = validateFormValues(model, values).filter(
    (i) => !imageParams.has(i.parameter)
  );
  return [...image.issues, ...generic];
}

watch(
  () => {
    const id = currentImageID.value;
    return { id, crop: id ? cropStore.croppingByImageID[id] : undefined };
  },
  () => {
    const model = taskModel.value;
    if (!model) return;
    const rebound = applyActiveBindings(model, currentValues.value);
    initialValues.value = rebound;
    currentValues.value = { ...rebound };
    issues.value = computeIssues(model, rebound);
  },
  { deep: true }
);

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
