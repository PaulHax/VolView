<template>
  <div v-if="jobs.length > 0">
    <div class="text-subtitle-2 mb-1">Jobs</div>
    <v-list density="compact" class="job-list">
      <v-list-item
        v-for="job in jobs"
        :key="job.jobId"
        :subtitle="subtitleFor(job)"
      >
        <template #title>
          <span class="job-id">{{ job.jobId }}</span>
        </template>

        <template #append>
          <div class="d-flex align-center" style="gap: 4px">
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
            <v-chip
              v-else-if="job.state === 'cancelled'"
              color="grey"
              size="x-small"
              variant="tonal"
            >
              ✕
            </v-chip>
            <template
              v-else-if="job.state === 'running' || job.state === 'pending'"
            >
              <v-progress-circular indeterminate size="16" width="2" />
              <!-- Best-effort cancel (contract Seam 3; D5): one neutral store
                   call. The poller converges the job to its terminal state, so
                   this button disappears once it settles. -->
              <v-btn
                size="x-small"
                variant="text"
                :loading="cancellingJobIds.has(job.jobId)"
                @click="cancel(job.jobId)"
              >
                Cancel
              </v-btn>
            </template>
          </div>
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
                  v-if="canOpen(result)"
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
                <!-- Download floor (contract Seam 2): every result stays a
                     downloadable file. This is the fallback when a result is not
                     auto-shown (failed corroboration) or has only the `download`
                     intent (no in-app representation). -->
                <v-btn
                  size="x-small"
                  variant="text"
                  :href="result.url"
                  :download="result.name"
                  target="_blank"
                  rel="noopener"
                >
                  Download
                </v-btn>
              </div>
            </div>
          </div>
        </template>
        <div
          v-else-if="job.state === 'error' && job.errorTail"
          class="job-error-summary mt-1"
        >
          <pre class="error-log">{{ errorSummaryFor(job.errorTail) }}</pre>
        </div>
      </v-list-item>
    </v-list>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';

import { useProvidersStore } from '@/src/store/providers';
import { useMessageStore } from '@/src/store/messages';
import { applyIntent } from '@/src/actions/processResults';
import type { ResultIntent } from '@/processing-contract';
import {
  canOpen,
  canBeLayer,
  canBeSegmentGroup,
} from '@/src/processing/resultActions';
import type { ProcessingResult } from '@/src/processing/types';

const providers = useProvidersStore();
const messageStore = useMessageStore();

const jobs = computed(() => Array.from(providers.jobs.values()));

const loadingResultIds = reactive(new Set<string>());
// Jobs with an in-flight cancel request (drives the Cancel button spinner).
const cancellingJobIds = reactive(new Set<string>());

// Best-effort cancel: fire the one neutral store call and let the poller
// converge the job to its terminal state (the store never fabricates
// `cancelled`). Errors are surfaced by the store; we only own the button state.
async function cancel(jobId: string) {
  cancellingJobIds.add(jobId);
  try {
    await providers.cancelJob(jobId);
  } finally {
    cancellingJobIds.delete(jobId);
  }
}

function resultsFor(jobId: string): ProcessingResult[] {
  return providers.jobResults.get(jobId) ?? [];
}

function taskTitleFor(jobId: string): string {
  return providers.submittedContexts.get(jobId)?.taskId ?? jobId;
}

function subtitleFor(job: {
  jobId: string;
  state: string;
  progress?: number;
}): string {
  const pct =
    job.progress != null ? ` (${Math.round(job.progress * 100)}%)` : '';
  return `${taskTitleFor(job.jobId)} - ${job.state}${pct}`;
}

function errorSummaryFor(errorTail: string): string {
  const normalized = errorTail.trim().replace(/\s+/g, ' ');
  return normalized.length > 240
    ? `${normalized.slice(0, 237).trimEnd()}...`
    : normalized;
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
        intent: 'add-segment-group',
        ...file,
        ...(result.segments ? { segments: result.segments } : {}),
        ...(result.source ? { source: result.source } : {}),
      };
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown result action: ${exhaustive}`);
    }
  }
}

// Wording for the failure toast, mirroring the noun on the clicked button.
const ACTION_NOUN: Record<'open' | 'layer' | 'segmentGroup', string> = {
  open: 'a dataset',
  layer: 'a layer',
  segmentGroup: 'a segment group',
};
const LOAD_FAILED_DETAIL =
  'The result file could not be loaded — it may be missing, corrupt, or not a volume image.';

function reportActionFailed(
  result: ProcessingResult,
  action: 'open' | 'layer' | 'segmentGroup',
  details: string
) {
  messageStore.addError(
    `Could not add "${result.name}" as ${ACTION_NOUN[action]}`,
    { details }
  );
}

// The single explicit-action boundary. Both ways applying a result can fail
// surface here as one message: a null load (`applyIntent` returns false) and a
// thrown store call (e.g. `convertImageToLabelmap` on non-intersecting bounds).
// The auto-show pipeline is separate and stays silent on a declined result.
async function dispatch(
  jobId: string,
  result: ProcessingResult,
  action: 'open' | 'layer' | 'segmentGroup'
) {
  const key = `${result.id}:${action}`;
  loadingResultIds.add(key);
  try {
    const ctx = providers.submittedContexts.get(jobId);
    const applied = await applyIntent(actionToIntent(action, result), ctx);
    if (!applied) reportActionFailed(result, action, LOAD_FAILED_DETAIL);
  } catch (err) {
    console.error('Failed to load result', result, err);
    reportActionFailed(result, action, String(err));
  } finally {
    loadingResultIds.delete(key);
  }
}
</script>

<style scoped>
.job-list :deep(.v-list-item) {
  padding-inline-start: 0;
}
.job-list :deep(.v-list-item__content),
.job-id {
  user-select: text;
  cursor: text;
}
.error-log {
  white-space: pre-wrap;
  font-size: 0.7rem;
  margin: 4px 0 0;
}
.job-error-summary {
  color: rgb(var(--v-theme-error));
}
.result-row {
  padding: 2px 0;
}
</style>
