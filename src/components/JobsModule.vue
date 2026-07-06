<template>
  <div class="jobs-module pa-3">
    <div
      v-if="providers.providerCount === 0"
      class="text-caption text-medium-emphasis"
    >
      No processing providers are configured for this dataset.
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

import { useProvidersStore } from '@/src/store/providers';
import { useCurrentImage } from '@/src/composables/useCurrentImage';
import { useImageCacheStore } from '@/src/store/image-cache';
import { useDatasetStore } from '@/src/store/datasets';
import { useCropStore } from '@/src/store/tools/crop';
import { autoLoadProcessingResults } from '@/src/actions/processResults';
import type {
  ProcessingProvider,
  ProcessingValue,
  SubmittedJobDisplay,
  SubmittedJobParameterDisplay,
  TaskSummary,
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
import {
  bindLabelmapInputs,
  labelmapStageTargets,
  mintLabelmapValue,
  type SegmentGroupView,
} from '@/src/processing/engine/mintLabelmap';
import { cropPlanesToWorldBounds } from '@/src/processing/engine/bounds';
import { usePaintToolStore } from '@/src/store/tools/paint';
import { useSegmentGroupStore } from '@/src/store/segmentGroups';
import { useMessageStore } from '@/src/store/messages';
import { writeSegmentation } from '@/src/io/readWriteImage';
import { getDataSourceName } from '@/src/io/import/dataSource';
import type { InputValue, VolViewTaskParameter } from '@/processing-contract';
import { TYPE_TAG_LABELMAP } from '@/processing-contract';

import TaskPicker from './analysis/TaskPicker.vue';
import TaskForm from './analysis/TaskForm.vue';
import JobList from './analysis/JobList.vue';

const providers = useProvidersStore();
const { currentImageID } = useCurrentImage('global');
const imageCache = useImageCacheStore();
const datasetStore = useDatasetStore();
const cropStore = useCropStore();
const paintStore = usePaintToolStore();
const segmentGroupStore = useSegmentGroupStore();
const messageStore = useMessageStore();

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

const tasks = ref<TaskSummary[]>([]);
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
      const ctx = providers.configs.get(id)?.context ?? {};
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

  // Seam-1 labelmap half (Chunk 15): stage the bound segment group(s) for
  // facade-minted URIs BEFORE submit. A staging failure is not surfaced by the
  // store, so surface it here (fail loud) and abort before running the job.
  let stagedValues: Record<string, ProcessingValue>;
  try {
    stagedValues = await stageLabelmapInputs(model, finalValues);
  } catch (err) {
    messageStore.addError('Failed to stage segment group input', {
      error: err instanceof Error ? err : undefined,
    });
    submitting.value = false;
    return;
  }

  try {
    await providers.submitJob(
      selectedProviderId.value,
      selectedTaskId.value,
      stagedValues,
      {
        activeDatasetId: currentImageID.value ?? undefined,
        display: buildJobDisplay(model, finalValues),
      }
    );
  } catch {
    // Item 4: the failure is already surfaced by the store (message center);
    // swallow here only to reset `submitting` and avoid an unhandled rejection.
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

function activeImageName(): string | undefined {
  const id = currentImageID.value;
  return (
    imageCache.getImageMetadata(id)?.name ??
    getDataSourceName(activeDataSource()) ??
    undefined
  );
}

// A pure read-only view of the segment-group store for the labelmap binder
// (contract Seam 1, client half; Chunk 15). The bound background is the active
// image, so the fallback chain + `parentImage` guard resolve against it.
function segmentGroupView(): SegmentGroupView {
  return {
    orderByParent: segmentGroupStore.orderByParent,
    metadataByID: segmentGroupStore.metadataByID,
  };
}

function bindLabelmaps(model: TaskFormModel) {
  return bindLabelmapInputs(
    model,
    currentImageID.value ?? undefined,
    paintStore.activeSegmentGroupID,
    segmentGroupView()
  );
}

// Apply every active-image-derived binding (crop bounds + the minted image
// input) onto a base value set, overwriting only the bound params. The labelmap
// value is NOT set here: a segment group has no server provenance, so it earns
// URIs only at Run via the async staging POST (`stageLabelmapInputs`).
function applyActiveBindings(
  model: TaskFormModel,
  base: Record<string, ProcessingValue>
): Record<string, ProcessingValue> {
  const withBounds = applyBoundsBindings(model, base);
  const image = bindImageInputs(model, activeDataSource());
  return { ...withBounds, ...image.values };
}

// Recompute the submit-gating issues and refresh the per-widget bind state. The
// image and labelmap sourceRef params are gated by their binders (fail closed on
// no-provenance / no segment group / >1 input), which own them fully, so the
// generic per-param check is suppressed for them to avoid a duplicate "required"
// message. A no-provenance background blocks submit via the image binder even
// when a labelmap is resolvable — the labelmap flow is blocked "for free".
function computeIssues(
  model: TaskFormModel,
  values: Record<string, ProcessingValue>
): FormValidationIssue[] {
  const image = bindImageInputs(model, activeDataSource());
  const labelmap = bindLabelmaps(model);
  sourceRefStates.value = { ...image.states, ...labelmap.states };
  const boundParams = new Set([
    ...Object.keys(image.states),
    ...Object.keys(labelmap.states),
  ]);
  const generic = validateFormValues(model, values).filter(
    (i) => !boundParams.has(i.parameter)
  );
  return [...image.issues, ...labelmap.issues, ...generic];
}

// Seam-1 labelmap half (Chunk 15), the ASYNC step. After the fail-closed gate
// passes, serialize each bound segment group to a compressed `seg.nrrd` (the
// literal 'seg.nrrd' token is required so `maybeBuildSegNrrdMetadata` embeds
// segment names/colors; gzip is automatic), POST it to the facade staging
// endpoint, and mint `{ type:"labelmap", uris }` from the facade-minted
// response. Two HTTP calls (stage, then run) behind one Run click; staging is
// automatic — the one explicit carve-out to the never-silent-upload pin.
async function stageLabelmapInputs(
  model: TaskFormModel,
  values: Record<string, ProcessingValue>
): Promise<Record<string, ProcessingValue>> {
  const p = provider.value;
  if (!p) return values;
  const targets = labelmapStageTargets(bindLabelmaps(model));
  if (targets.length === 0) return values;

  const staged = await Promise.all(
    targets.map(async ({ parameterId, segmentGroupId }) => {
      const metadata = segmentGroupStore.metadataByID[segmentGroupId];
      const labelmap = segmentGroupStore.dataIndex[segmentGroupId];
      const serialized = await writeSegmentation(
        'seg.nrrd',
        labelmap,
        metadata
      );
      const uris = await p.stageInput(
        new Blob([serialized]),
        `${metadata.name}.seg.nrrd`
      );
      return [parameterId, mintLabelmapValue(uris)] as const;
    })
  );
  return { ...values, ...Object.fromEntries(staged) };
}

function fieldLabel(field: VolViewTaskParameter): string {
  return field.title || field.id;
}

function formatProcessingValue(
  field: VolViewTaskParameter,
  value: ProcessingValue
): string {
  if (field.kind === 'sourceRef') {
    if (field.accepts.includes(TYPE_TAG_LABELMAP)) {
      const groupId = paintStore.activeSegmentGroupID;
      return groupId
        ? (segmentGroupStore.metadataByID[groupId]?.name ?? groupId)
        : 'bound segment group';
    }
    return activeImageName() ?? 'active dataset';
  }
  if (field.kind === 'bounds') {
    return Array.isArray(value) && value.length > 0
      ? value.map((n) => (typeof n === 'number' ? n.toFixed(1) : n)).join(', ')
      : 'not set';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') {
    const input = value as InputValue;
    return input.type;
  }
  if (value === null || value === undefined || value === '') return 'not set';
  return String(value);
}

function isSummaryParameter(
  field: VolViewTaskParameter,
  value: ProcessingValue
): boolean {
  if (field.kind === 'sourceRef' || field.kind === 'bounds') return false;
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function buildJobDisplay(
  model: TaskFormModel,
  values: Record<string, ProcessingValue>
): SubmittedJobDisplay {
  let summaryCount = 0;
  const parameters: SubmittedJobParameterDisplay[] = model.fields.map(
    (field) => {
      const value = values[field.id];
      const summary = summaryCount < 2 && isSummaryParameter(field, value);
      if (summary) summaryCount += 1;
      return {
        id: field.id,
        label: fieldLabel(field),
        value: formatProcessingValue(field, value),
        ...(summary ? { summary } : {}),
      };
    }
  );
  const inputName = activeImageName();
  return {
    taskTitle: model.title,
    ...(inputName ? { inputName } : {}),
    parameters,
  };
}

watch(
  () => {
    const id = currentImageID.value;
    return {
      id,
      crop: id ? cropStore.croppingByImageID[id] : undefined,
      // Refresh the labelmap widget state as the user paints / selects a group.
      activeSegmentGroup: paintStore.activeSegmentGroupID,
      groupCount: id ? (segmentGroupStore.orderByParent[id]?.length ?? 0) : 0,
    };
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
// Result loading + completion messages
//
// The dedup seen-set lives in the store now (Chunk 12): a job that finishes
// while this tab is unmounted replays into a fresh subscription exactly once on
// remount, so no completion handling is lost across a tab switch.
// ---------------------------------------------------------------------------

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  unsubscribe = providers.onJobComplete(
    ({ status, results, context, baseImageMissing }) => {
      if (status.state === 'success') {
        // Item 8: if the originating base image was closed mid-job the store
        // already surfaced a message; skip the auto-attach (there is no parent
        // to attach to) but the results still show in the Jobs panel.
        if (!baseImageMissing) {
          // Auto-load only overlays (segment groups). Everything else waits for
          // a user click in JobList so we don't clobber the current view. The
          // watermark is passed for consistency with tier-2 (Chunk 19); a
          // tier-1 in-session context carries no `finishedAt`, so it always
          // attaches regardless (MVP parity).
          autoLoadProcessingResults(
            results,
            context,
            providers.sessionSavedAt
          ).catch((err) => {
            console.error('Failed to auto-load results', err);
          });
        }
      }
    }
  );
});

onBeforeUnmount(() => {
  unsubscribe?.();
});
</script>

<style scoped>
.jobs-module {
  height: 100%;
  overflow: auto;
}
</style>
