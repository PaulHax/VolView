<template>
  <div v-if="jobs.length > 0">
    <div class="text-subtitle-2 mb-1">Jobs</div>
    <v-list density="compact" class="job-list">
      <v-list-item
        v-for="job in jobs"
        :key="job.jobId"
        :title="taskTitleFor(job.jobId)"
        :subtitle="subtitleFor(job)"
      >
        <template #append>
          <v-chip
            v-if="job.state === 'success'"
            color="success"
            size="x-small"
            variant="tonal"
          >
            ✓
          </v-chip>
          <v-chip
            v-else-if="job.state === 'error'"
            color="error"
            size="x-small"
            variant="tonal"
          >
            !
          </v-chip>
          <v-progress-circular
            v-else-if="job.state === 'running' || job.state === 'pending'"
            indeterminate
            size="16"
            width="2"
          />
        </template>

        <!-- Per-result actions: shown only on successful jobs with results. -->
        <template
          v-if="job.state === 'success' && resultsFor(job.jobId).length > 0"
        >
          <div class="ml-2 mt-1">
            <div
              v-for="result in resultsFor(job.jobId)"
              :key="result.id"
              class="result-row mb-1"
            >
              <div class="text-caption font-weight-medium">
                {{ result.name }}
              </div>
              <div class="d-flex flex-wrap" style="gap: 4px">
                <v-btn
                  v-if="result.role !== 'download'"
                  size="x-small"
                  variant="tonal"
                  :loading="loadingResultIds.has(result.id + ':open')"
                  @click="dispatch(job.jobId, result, 'open')"
                >
                  Open
                </v-btn>
                <v-btn
                  v-if="canBeLayer(result)"
                  size="x-small"
                  variant="tonal"
                  :loading="loadingResultIds.has(result.id + ':layer')"
                  @click="dispatch(job.jobId, result, 'layer')"
                >
                  Add as layer
                </v-btn>
                <v-btn
                  v-if="canBeSegmentGroup(result)"
                  size="x-small"
                  variant="tonal"
                  :loading="loadingResultIds.has(result.id + ':segmentGroup')"
                  @click="dispatch(job.jobId, result, 'segmentGroup')"
                >
                  Add as segment group
                </v-btn>
              </div>
            </div>
          </div>
        </template>
      </v-list-item>
    </v-list>
    <v-alert
      v-for="job in failedJobs"
      :key="`${job.jobId}-err`"
      type="error"
      density="compact"
      class="mt-2 text-caption"
    >
      <div class="font-weight-medium">{{ taskTitleFor(job.jobId) }}</div>
      <pre class="error-log">{{ job.errorTail }}</pre>
    </v-alert>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';

import { useProvidersStore } from '@/src/store/providers';
import { applyIntent } from '@/src/actions/processResults';
import type { ResultIntent } from '@/src/processing/intents';
import type { ProcessingResult } from '@/src/processing/types';

const providers = useProvidersStore();

const jobs = computed(() => Array.from(providers.jobs.values()));
const failedJobs = computed(() =>
  jobs.value.filter((j) => j.state === 'error' && j.errorTail)
);

const loadingResultIds = reactive(new Set<string>());

function resultsFor(jobId: string): ProcessingResult[] {
  return providers.jobResults.get(jobId) ?? [];
}

function taskTitleFor(jobId: string): string {
  return providers.submittedContexts.get(jobId)?.taskId ?? jobId;
}

function subtitleFor(job: { state: string; progress?: number }): string {
  const pct =
    job.progress != null ? ` (${Math.round(job.progress * 100)}%)` : '';
  return `${job.state}${pct}`;
}

const IMAGE_LIKE_MIMETYPES = [
  'application/dicom',
  'application/vnd.unknown.nifti-1',
  'application/vnd.unknown.metaimage',
  'application/vnd.unknown.nrrd',
];

function canBeLayer(result: ProcessingResult): boolean {
  if (result.role === 'state' || result.role === 'download') return false;
  // Either explicitly tagged as a layer, or looks like an image.
  if (result.role === 'layer') return true;
  if (result.role === 'segmentGroup') return false;
  return looksLikeImage(result);
}

function canBeSegmentGroup(result: ProcessingResult): boolean {
  if (result.role === 'segmentGroup') return true;
  if (result.role === 'layer' || result.role === 'base') return false;
  return looksLikeImage(result);
}

function looksLikeImage(result: ProcessingResult): boolean {
  if (result.mimeType && IMAGE_LIKE_MIMETYPES.includes(result.mimeType)) {
    return true;
  }
  const lower = result.name.toLowerCase();
  return (
    lower.endsWith('.nii') ||
    lower.endsWith('.nii.gz') ||
    lower.endsWith('.mha') ||
    lower.endsWith('.mhd') ||
    lower.endsWith('.nrrd') ||
    lower.endsWith('.dcm')
  );
}

// Map an explicit action button to the intent it requests. The user's choice —
// not the result's role — determines the intent here.
function actionToIntent(
  action: 'open' | 'layer' | 'segmentGroup',
  result: ProcessingResult
): ResultIntent {
  const file = { url: result.url, name: result.name };
  switch (action) {
    case 'open':
      return { intent: 'add-base-image', ...file };
    case 'layer':
      return { intent: 'add-layer', ...file };
    case 'segmentGroup':
      return {
        intent: 'attach-segment-group',
        ...file,
        segments: result.segments ?? [],
      };
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown result action: ${exhaustive}`);
    }
  }
}

async function dispatch(
  jobId: string,
  result: ProcessingResult,
  action: 'open' | 'layer' | 'segmentGroup'
) {
  const key = `${result.id}:${action}`;
  loadingResultIds.add(key);
  try {
    const ctx = providers.submittedContexts.get(jobId);
    await applyIntent(actionToIntent(action, result), ctx);
  } catch (err) {
    console.error('Failed to load result', result, err);
  } finally {
    loadingResultIds.delete(key);
  }
}
</script>

<style scoped>
.job-list :deep(.v-list-item) {
  padding-inline-start: 0;
}
.error-log {
  white-space: pre-wrap;
  font-size: 0.7rem;
  margin: 4px 0 0;
}
.result-row {
  padding: 2px 0;
}
</style>
