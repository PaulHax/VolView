<template>
  <div v-if="jobs.length > 0">
    <v-list density="compact" class="job-list">
      <v-list-item v-for="job in jobs" :key="job.jobId">
        <template #title>
          <span class="job-title">
            {{ jobTitleFor(job.jobId) }}
            <v-tooltip activator="parent" location="top">
              {{ jobTooltipFor(job) }}
            </v-tooltip>
          </span>
        </template>

        <template #subtitle>
          <div class="job-labels">
            <span class="job-label job-id">
              Job {{ job.jobId }}
              <v-tooltip activator="parent" location="top">
                Job {{ job.jobId }}
              </v-tooltip>
            </span>
          </div>
        </template>

        <template #append>
          <div class="job-actions">
            <div class="cancel-slot">
              <!-- Best-effort cancel (contract Seam 3; D5): one neutral store
                   call. The poller converges the job to its terminal state, so
                   this button disappears once it settles. -->
              <v-btn
                v-if="job.state === 'running' || job.state === 'pending'"
                icon="mdi-close"
                size="x-small"
                variant="text"
                density="compact"
                :loading="cancellingJobIds.has(job.jobId)"
                :disabled="cancellingJobIds.has(job.jobId)"
                :aria-label="
                  cancellingJobIds.has(job.jobId)
                    ? 'Canceling job'
                    : 'Cancel job'
                "
                @click="cancel(job.jobId)"
              >
                <v-tooltip activator="parent" location="top">
                  {{
                    cancellingJobIds.has(job.jobId)
                      ? 'Canceling job'
                      : 'Cancel job'
                  }}
                </v-tooltip>
              </v-btn>
            </div>
            <div class="status-slot">
              <v-progress-circular
                v-if="job.state === 'running' || job.state === 'pending'"
                indeterminate
                size="16"
                width="2"
              />
              <v-icon v-else :icon="statusIconFor(job.state)" size="16" />
              <v-tooltip activator="parent" location="top">
                {{ statusTooltipFor(job) }}
              </v-tooltip>
            </div>
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
                <span class="result-name">
                  {{ result.name }}
                  <v-tooltip activator="parent" location="top">
                    {{ result.name }}
                  </v-tooltip>
                </span>
              </div>
            </div>
          </div>
        </template>
        <div v-else-if="job.state === 'error'" class="job-error-summary mt-1">
          <pre class="error-log">{{ errorSummaryFor(job) }}</pre>
        </div>
        <div v-if="parametersFor(job.jobId).length > 0" class="job-parameters">
          <v-btn
            size="x-small"
            variant="text"
            class="px-0"
            :prepend-icon="
              expandedJobIds.has(job.jobId)
                ? 'mdi-chevron-down'
                : 'mdi-chevron-right'
            "
            @click="toggleParameters(job.jobId)"
          >
            Parameters
          </v-btn>
          <v-expand-transition>
            <dl v-if="expandedJobIds.has(job.jobId)" class="parameter-list">
              <div
                v-for="parameter in parametersFor(job.jobId)"
                :key="parameter.id"
                class="parameter-row"
              >
                <dt>{{ parameter.label }}</dt>
                <dd>{{ parameter.value }}</dd>
                <v-tooltip activator="parent" location="top">
                  {{ parameter.label }}: {{ parameter.value }}
                </v-tooltip>
              </div>
            </dl>
          </v-expand-transition>
        </div>
      </v-list-item>
    </v-list>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';

import { useProvidersStore } from '@/src/store/providers';
import type {
  ProcessingResult,
  SubmittedJobContext,
  SubmittedJobParameterDisplay,
} from '@/src/processing/types';

const providers = useProvidersStore();

const jobs = computed(() =>
  Array.from(providers.jobs.values()).sort((a, b) => {
    const aSubmittedAt = providers.submittedContexts.get(a.jobId)?.submittedAt;
    const bSubmittedAt = providers.submittedContexts.get(b.jobId)?.submittedAt;
    return timestampFor(bSubmittedAt) - timestampFor(aSubmittedAt);
  })
);

const expandedJobIds = reactive(new Set<string>());
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

function contextFor(jobId: string): SubmittedJobContext | undefined {
  return providers.submittedContexts.get(jobId);
}

function taskTitleFor(jobId: string): string {
  const context = contextFor(jobId);
  return context?.display?.taskTitle ?? context?.taskId ?? jobId;
}

function summaryParametersFor(jobId: string): SubmittedJobParameterDisplay[] {
  return contextFor(jobId)?.display?.parameters.filter((p) => p.summary) ?? [];
}

function parametersFor(jobId: string): SubmittedJobParameterDisplay[] {
  return contextFor(jobId)?.display?.parameters ?? [];
}

function jobTitleFor(jobId: string): string {
  const context = contextFor(jobId);
  const pieces = [
    taskTitleFor(jobId),
    context?.display?.inputName,
    ...summaryParametersFor(jobId).map((p) => `${p.label}: ${p.value}`),
  ].filter((piece): piece is string => !!piece);
  return pieces.join(' - ');
}

function timestampFor(instant: string | undefined): number {
  if (!instant) return 0;
  const timestamp = Date.parse(instant);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function statusTooltipFor(job: {
  jobId: string;
  state: string;
  progress?: number;
}): string {
  if (cancellingJobIds.has(job.jobId)) return 'canceling';
  const pct =
    job.progress != null ? ` (${Math.round(job.progress * 100)}%)` : '';
  return `${job.state}${pct}`;
}

function jobTooltipFor(job: {
  jobId: string;
  state: string;
  progress?: number;
}): string {
  return `${jobTitleFor(job.jobId)} - ${statusTooltipFor(job)}`;
}

function statusIconFor(state: string): string {
  switch (state) {
    case 'success':
      return 'mdi-check';
    case 'error':
      return 'mdi-alert-circle-outline';
    case 'cancelled':
      return 'mdi-close';
    default:
      return 'mdi-circle-outline';
  }
}

function toggleParameters(jobId: string) {
  if (expandedJobIds.has(jobId)) {
    expandedJobIds.delete(jobId);
    return;
  }
  expandedJobIds.add(jobId);
}

function errorSummaryFor(job: { jobId: string; errorTail?: string }): string {
  const normalized =
    job.errorTail?.trim().replace(/\s+/g, ' ') ||
    `The provider reported this job failed but did not include error details. Job ID: ${job.jobId}`;
  return normalized.length > 240
    ? `${normalized.slice(0, 237).trimEnd()}...`
    : normalized;
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
.job-list :deep(.v-list-item__content) {
  min-width: 0;
}
.job-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.job-label {
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-size: 0.72rem;
  line-height: 1.2;
}
.job-id {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-actions {
  display: grid;
  grid-template-columns: 24px 20px;
  align-items: center;
  justify-content: end;
  column-gap: 2px;
  width: 46px;
}
.cancel-slot,
.status-slot {
  display: flex;
  align-items: center;
  justify-content: center;
}
.cancel-slot {
  width: 24px;
}
.status-slot {
  width: 20px;
  color: rgba(var(--v-theme-on-surface), 0.85);
}
.job-parameters {
  margin-top: 2px;
}
.parameter-list {
  margin: 2px 0 0 8px;
  font-size: 0.72rem;
}
.parameter-row {
  display: grid;
  grid-template-columns: minmax(72px, 40%) minmax(0, 1fr);
  column-gap: 8px;
  min-width: 0;
}
.parameter-row dt {
  color: rgba(var(--v-theme-on-surface), 0.7);
}
.parameter-row dt,
.parameter-row dd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.parameter-row dd {
  min-width: 0;
  margin: 0;
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
.result-name {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
