// Processing providers store.
//
// Holds provider *configs* (registered on app boot from the manifest config
// JSON) and *instances* (created lazily on first `getProvider` call —
// dynamic-imports the generic engine provider chunk).
//
// Also owns the whole tracked-job lifecycle (contract "Seam 3 — job lifecycle";
// decisions.md D5): the submitted-job records, the poll loop, the terminal
// completion firing, and — the tier-1 durability half (Chunk 12) — a store-level
// replay so a job that finishes while the Jobs tab is unmounted still fires its
// side effects exactly once when the tab remounts. The record + machinery live
// HERE (not in the Jobs component) so they survive an unmount / tab-switch /
// layout change. Tier-1 is in-memory ONLY — it deliberately does NOT survive a
// page reload; cold-reload re-discovery is tier-2 (Chunk 19).

import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';

import type { NeutralJobHandle } from '@/processing-contract';
import type {
  ProcessingJobStatus,
  ProcessingProvider,
  ProcessingProviderConfig,
  ProcessingResult,
  ProcessingValue,
  SubmittedJobContext,
} from '@/src/processing/types';
import { collectProvenanceUris } from '@/src/processing/engine/mintInput';
import {
  passesWatermark,
  reassociateBase,
} from '@/src/processing/engine/rediscover';
import { useMessageStore } from '@/src/store/messages';
import { useDatasetStore } from '@/src/store/datasets';

// ---------------------------------------------------------------------------
// Lifecycle tuning constants
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = 2000;
// Bounded transient-error retries before a poll gives up and fails the job loud
// (item 3 — never an infinite quiet loop). Counts CONSECUTIVE transient errors;
// any successful poll resets it.
export const MAX_POLL_RETRIES = 4;
// Ceiling on the exponential poll backoff so a long-lived transient outage never
// stretches the retry interval without bound.
export const MAX_POLL_BACKOFF_MS = 30000;

const TERMINAL_STATES = new Set<ProcessingJobStatus['state']>([
  'success',
  'error',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// Poll/results error classification
//
// The engine transport throws an `Error` carrying the HTTP `status` (see
// engine/transport.ts). We fail LOUD but discriminate so the poll loop retries
// only what is genuinely transient:
//   * 401 / 403       → session/auth expiry — the whole same-origin session is
//                       dead (item 7). Stop everything, prompt a reload.
//   * 404 / 410       → the job or its base image is gone (item 8, server half).
//   * other 4xx       → permanent — the request is malformed/forbidden; no retry.
//   * 5xx / no status → transient — a network blip or server hiccup; retry with
//                       backoff up to MAX_POLL_RETRIES, then fail the job.
// ---------------------------------------------------------------------------

type PollErrorKind =
  | 'transient'
  | 'permanent'
  | 'session-expired'
  | 'resource-gone';

const classifyError = (err: unknown): PollErrorKind => {
  const status = (err as { status?: number } | null | undefined)?.status;
  if (status === 401 || status === 403) return 'session-expired';
  if (status === 404 || status === 410) return 'resource-gone';
  if (typeof status === 'number' && status >= 400 && status < 500)
    return 'permanent';
  // 5xx or no HTTP status (fetch rejected — offline / DNS / CORS) → transient.
  return 'transient';
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// ---------------------------------------------------------------------------
// Completion payload
//
// A single object (functional, extensible) delivered to every completion
// listener. `baseImageMissing` flags item 8: the originating base image was
// removed before the job finished, so results must be surfaced (never silently
// dropped) but not auto-attached to a parent that no longer exists.
// ---------------------------------------------------------------------------

export type JobCompletion = {
  status: ProcessingJobStatus;
  results: ProcessingResult[];
  context?: SubmittedJobContext;
  baseImageMissing?: boolean;
};

type CompletionListener = (completion: JobCompletion) => void;

const loadProvider = async (
  config: ProcessingProviderConfig
): Promise<ProcessingProvider> => {
  // Dynamic import — Vite emits a separate chunk for the generic engine that's
  // only fetched when some surface (typically the Jobs tab) actually
  // instantiates a provider, keeping the engine out of the boot bundle. There
  // is one generic engine and no per-backend branch: every provider is the
  // engine transport reading the neutral-facade default descriptor.
  const { createProvider } = await import('@/src/processing/engine/provider');
  return createProvider(config);
};

export const useProvidersStore = defineStore('providers', () => {
  // Configs are populated on app boot from the manifest config.
  const configs = reactive(new Map<string, ProcessingProviderConfig>());

  // Provider instances are created lazily on first request.
  const instances = reactive(new Map<string, ProcessingProvider>());
  const loading = reactive(new Map<string, Promise<ProcessingProvider>>());

  // Job tracking — populated when the user submits a task.
  const jobs = reactive(new Map<string, ProcessingJobStatus>());
  const submittedContexts = reactive(new Map<string, SubmittedJobContext>());
  const jobResults = reactive(new Map<string, ProcessingResult[]>());
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-job count of consecutive transient poll errors (bounded-retry backoff).
  const pollRetries = new Map<string, number>();

  // Set once when a mid-job request meets 401/403: the same-origin session is
  // dead. The Jobs component watches this to prompt a reload (item 7).
  const sessionExpired = ref(false);

  // Tier-2 session watermark (Chunk 19, D5): the restored session zip's own
  // server-side save instant, surfaced on the launch manifest and set at load.
  // A re-discovered result auto-attaches iff `finishedAt > sessionSavedAt`; no
  // restored session → undefined → attach all (exact MVP parity). Server clock
  // only — nothing new is stored, no state-file change.
  const sessionSavedAt = ref<string | undefined>(undefined);

  // Subscribers fired when a job reaches a terminal state with its results.
  // Used by the Jobs component to load result files + toast (Phase 5).
  const completionListeners = new Set<CompletionListener>();
  // The last terminal completion for each job, retained so a listener that
  // subscribes AFTER the event (the Jobs tab was unmounted when the job
  // finished) can be replayed on remount. In-memory only (tier-1).
  const terminalCompletions = new Map<string, JobCompletion>();
  // Store-level seen-set: jobIds whose completion has already been delivered to
  // a listener. This is what makes replay fire each job's side effects EXACTLY
  // ONCE across tab unmount/remount — the component re-subscribes with a FRESH
  // callback every mount, so a per-callback set (the old component-local
  // `seenToastJobs`) would double-fire. Never persisted (reload = tier-2).
  const firedCompletions = new Set<string>();

  // Reactive counter so components can `v-if="providers.providerCount > 0"`.
  const providerCount = ref(0);

  function registerProviderConfig(config: ProcessingProviderConfig) {
    configs.set(config.id, config);
    providerCount.value = configs.size;
  }

  // Drop every tracked job + its timers and reset the completion bookkeeping
  // (item 6, clear half). Split out so a provider reset wipes in-flight jobs
  // rather than leaking their pollers and stale records.
  function clearJobs() {
    Array.from(pollTimers.keys()).forEach(stopPolling);
    jobs.clear();
    jobResults.clear();
    submittedContexts.clear();
    terminalCompletions.clear();
    firedCompletions.clear();
    sessionExpired.value = false;
    sessionSavedAt.value = undefined;
  }

  function clearProviders() {
    configs.clear();
    instances.clear();
    loading.clear();
    providerCount.value = 0;
    clearJobs();
  }

  async function getProvider(id: string): Promise<ProcessingProvider> {
    const existing = instances.get(id);
    if (existing) return existing;
    const inflight = loading.get(id);
    if (inflight) return inflight;
    const config = configs.get(id);
    if (!config) throw new Error(`Unknown provider id: ${id}`);
    const promise = loadProvider(config).then((provider) => {
      instances.set(id, provider);
      loading.delete(id);
      return provider;
    });
    loading.set(id, promise);
    return promise;
  }

  function recordJob(status: ProcessingJobStatus) {
    jobs.set(status.jobId, status);
  }

  function recordSubmittedContext(context: SubmittedJobContext) {
    submittedContexts.set(context.jobId, context);
  }

  // -------------------------------------------------------------------------
  // Completion delivery + tier-1 replay (item 1)
  // -------------------------------------------------------------------------

  // Deliver a terminal completion to current listeners, retain it for replay,
  // and mark it seen. If NO listener is subscribed (Jobs tab unmounted) the
  // completion is retained but NOT marked seen, so the next `onJobComplete`
  // subscriber replays it — exactly once.
  function deliverCompletion(completion: JobCompletion) {
    terminalCompletions.set(completion.status.jobId, completion);
    if (completionListeners.size === 0) return;
    firedCompletions.add(completion.status.jobId);
    completionListeners.forEach((cb) => cb(completion));
  }

  function onJobComplete(cb: CompletionListener): () => void {
    completionListeners.add(cb);
    // Replay every terminal completion this store has not yet delivered to a
    // listener. Marking as we go keeps a subsequent remount from re-firing.
    terminalCompletions.forEach((completion, jobId) => {
      if (firedCompletions.has(jobId)) return;
      firedCompletions.add(jobId);
      cb(completion);
    });
    return () => completionListeners.delete(cb);
  }

  // -------------------------------------------------------------------------
  // Timer + error lifecycle
  // -------------------------------------------------------------------------

  function stopPolling(jobId: string) {
    const timer = pollTimers.get(jobId);
    if (timer) clearTimeout(timer);
    pollTimers.delete(jobId);
    // Per-job transient bookkeeping is dropped on terminal/stop (item 6).
    pollRetries.delete(jobId);
  }

  function scheduleNextPoll(
    provider: ProcessingProvider,
    jobId: string,
    delay: number
  ) {
    const timer = setTimeout(() => pollOnce(provider, jobId), delay);
    pollTimers.set(jobId, timer);
  }

  // Fail LOUD: synthesize a terminal `error` status, surface it, and route it
  // through the same completion path as any other terminal job so JobList shows
  // it and the seen-set/replay covers it. `detail` prefixes the surfaced tail.
  function failJob(
    jobId: string,
    err: unknown,
    title: string,
    detail?: string
  ): ProcessingJobStatus {
    stopPolling(jobId);
    const message = errorMessage(err);
    const errorTail = detail ? `${detail}: ${message}` : message;
    const status: ProcessingJobStatus = { jobId, state: 'error', errorTail };
    recordJob(status);
    useMessageStore().addError(title, { details: errorTail });
    return status;
  }

  // The session is dead (401/403). Stop ALL polling and surface a persistent,
  // reload-me message once (item 7). Same-origin means no subtler recovery —
  // the whole Girder session, not just this job, is gone.
  function markSessionExpired(err: unknown) {
    if (sessionExpired.value) return;
    sessionExpired.value = true;
    Array.from(pollTimers.keys()).forEach(stopPolling);
    useMessageStore().addError(
      'Your session has expired. Reload the page to continue.',
      { error: err instanceof Error ? err : undefined, persist: true }
    );
  }

  function handlePollError(
    provider: ProcessingProvider,
    jobId: string,
    err: unknown
  ) {
    const kind = classifyError(err);
    if (kind === 'session-expired') {
      markSessionExpired(err);
      return;
    }
    if (kind === 'resource-gone') {
      const status = failJob(
        jobId,
        err,
        'Processing job failed',
        'the job or its base image may have been deleted'
      );
      deliverCompletion({
        status,
        results: [],
        context: submittedContexts.get(jobId),
      });
      return;
    }
    if (kind === 'permanent') {
      const status = failJob(jobId, err, 'Processing job failed');
      deliverCompletion({
        status,
        results: [],
        context: submittedContexts.get(jobId),
      });
      return;
    }
    // transient — bounded retries with exponential backoff, then fail loud.
    const attempts = (pollRetries.get(jobId) ?? 0) + 1;
    if (attempts > MAX_POLL_RETRIES) {
      const status = failJob(
        jobId,
        err,
        'Processing job failed',
        `polling gave up after ${MAX_POLL_RETRIES} retries`
      );
      deliverCompletion({
        status,
        results: [],
        context: submittedContexts.get(jobId),
      });
      return;
    }
    pollRetries.set(jobId, attempts);
    const delay = Math.min(
      POLL_INTERVAL_MS * 2 ** attempts,
      MAX_POLL_BACKOFF_MS
    );
    scheduleNextPoll(provider, jobId, delay);
  }

  // -------------------------------------------------------------------------
  // Terminal completion (result-read gating, items 5 + 8)
  // -------------------------------------------------------------------------

  // Item 8 (client half): the originating base image was removed mid-job. Its
  // id was recorded at submit but is gone from the dataset store now.
  function baseImageMissing(context?: SubmittedJobContext): boolean {
    const id = context?.activeDatasetId;
    if (!id) return false; // no base bound at submit — nothing to lose
    return !useDatasetStore().idsAsSelections.includes(id);
  }

  // Shared terminal-completion path. Reached from both the poller and the
  // born-terminal fast-path in `submitJob`, so a synchronous job lands results
  // identically to a polled one. Assumes `status.state` is already terminal.
  async function fireCompletion(
    provider: ProcessingProvider,
    status: ProcessingJobStatus
  ) {
    const { jobId } = status;
    const context = submittedContexts.get(jobId);

    // Item 5: result reads gate on terminal SUCCESS. A non-success terminal
    // (error/cancelled) delivers no results — but is never confused with an
    // empty success because the status travels with it.
    if (status.state !== 'success') {
      deliverCompletion({ status, results: [], context });
      return;
    }

    // Item 5: a results-fetch error is an ERROR, never empty results. On
    // failure mark the job errored (loud) and deliver the errored status — the
    // old `notify([])` conflated "fetch failed" with "succeeded, no outputs".
    let results: ProcessingResult[];
    try {
      results = await provider.getResults(jobId);
    } catch (err) {
      if (classifyError(err) === 'session-expired') {
        markSessionExpired(err);
        return;
      }
      const errored = failJob(jobId, err, 'Failed to fetch job results');
      deliverCompletion({ status: errored, results: [], context });
      return;
    }
    jobResults.set(jobId, results);

    // Item 8: base image removed mid-job → detect + message; results are still
    // recorded (JobList shows them) and delivered, never silently dropped.
    const missing = baseImageMissing(context);
    if (missing) {
      const count = results.length;
      useMessageStore().addWarning(
        'Base image was closed before the job finished',
        {
          details: `${count} result${count === 1 ? '' : 's'} for this job are available in the Jobs panel but were not attached automatically.`,
        }
      );
    }
    deliverCompletion({ status, results, context, baseImageMissing: missing });
  }

  async function pollOnce(provider: ProcessingProvider, jobId: string) {
    let status: ProcessingJobStatus;
    try {
      status = await provider.getJob(jobId);
    } catch (err) {
      handlePollError(provider, jobId, err);
      return;
    }
    // Any successful poll resets the transient-error backoff.
    pollRetries.delete(jobId);
    recordJob(status);
    if (TERMINAL_STATES.has(status.state)) {
      stopPolling(jobId);
      await fireCompletion(provider, status);
      return;
    }
    scheduleNextPoll(provider, jobId, POLL_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // Submit (item 4 — surface failure, never swallow to console)
  // -------------------------------------------------------------------------

  async function submitJob(
    providerId: string,
    taskId: string,
    values: Record<string, ProcessingValue>,
    submittedContext: Omit<
      SubmittedJobContext,
      'jobId' | 'submittedAt' | 'taskId' | 'providerId'
    >
  ): Promise<string> {
    try {
      const provider = await getProvider(providerId);
      const config = configs.get(providerId);
      const ctx = config?.context ?? {};
      const jobRef = await provider.runTask(taskId, values, ctx);
      const jobId = jobRef.jobId;
      recordSubmittedContext({
        jobId,
        taskId,
        providerId,
        submittedAt: new Date().toISOString(),
        ...submittedContext,
      });

      // Async-with-sync-fast-path (decisions.md D5): a provider may hand back a
      // job that is already terminal. Record its real state and route it
      // through the same completion path as a polled job, but never register a
      // poller. Polling stays the driver only for jobs not yet terminal.
      const initialStatus: ProcessingJobStatus = jobRef.status
        ? { ...jobRef.status, jobId }
        : { jobId, state: 'pending' };
      recordJob(initialStatus);
      if (TERMINAL_STATES.has(initialStatus.state)) {
        await fireCompletion(provider, initialStatus);
        return jobId;
      }

      // Immediate first poll, then self-scheduling with backoff on error.
      pollOnce(provider, jobId);
      return jobId;
    } catch (err) {
      // Item 4: submit failure is surfaced in the UI, not swallowed to a
      // console.error. Re-thrown so the caller's form resets its submitting
      // flag and can distinguish success from failure.
      useMessageStore().addError('Failed to submit job', {
        error: err instanceof Error ? err : undefined,
      });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Cancel (contract "Seam 3 — job lifecycle" best-effort; D5)
  // -------------------------------------------------------------------------

  // Request cancellation of a tracked job. One neutral engine call — no Girder
  // route/id/JobStatus knowledge here. Deliberately does NOT record a terminal
  // status itself: cancel is best-effort (the job may finish before the cancel
  // lands), so the EXISTING poller stays the single source of convergence and
  // fires completion exactly once on whatever terminal state the backend
  // reports. A cancel of an unknown/untracked job is a no-op (fail closed,
  // never throws to the UI).
  async function cancelJob(jobId: string) {
    const context = submittedContexts.get(jobId);
    if (!context) return;
    try {
      const provider = await getProvider(context.providerId);
      await provider.cancelJob(jobId);
    } catch (err) {
      // Best-effort: surface the failure but leave the poller running so a job
      // that terminates on its own still converges. A mid-cancel 401/403 is the
      // same dead-session signal the poller uses.
      if (classifyError(err) === 'session-expired') {
        markSessionExpired(err);
        return;
      }
      useMessageStore().addError('Failed to cancel job', {
        error: err instanceof Error ? err : undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Tier-2 cold-reload re-discovery (contract "Seam 3 — job lifecycle"; D5)
  //
  // A reloaded page re-finds its jobs through the ONE neutral, capability-gated
  // op (`listRecentJobs`) and auto-re-attaches each terminal result with no
  // click — surfacing the start-job → close-browser → finishes → reopen flow.
  // Reuses the existing poll → results → intents machinery; the come-back
  // (already-terminal) case is applied HEADLESSLY here (no mounted Jobs tab
  // needed), gated by the session watermark + scene-state idempotency.
  // -------------------------------------------------------------------------

  function setSessionWatermark(instant: string | undefined) {
    sessionSavedAt.value = instant;
  }

  type ReattachCandidate = { id: string; uris: string[] };

  async function reattachOneJob(
    provider: ProcessingProvider,
    providerId: string,
    handle: NeutralJobHandle,
    candidates: ReattachCandidate[],
    watermark: string | undefined
  ) {
    // Already tracked this session (a tier-1 submit owns it) → do not re-adopt.
    if (submittedContexts.has(handle.jobId) || jobs.has(handle.jobId)) return;

    // Tier-2 reload economy — watermark short-circuit (Chunk 27; review §4.4;
    // NO wire change). A non-empty `finishedAt` means the job is TERMINAL (facade
    // `_projectFinishedAt` returns "" for a still-running job — non-empty ⇔
    // terminal). A terminal handle whose terminal instant fails the session
    // watermark can never auto-attach (its result predates the restored scene),
    // so skip it WHOLE: no `recordSubmittedContext`, no `getJob`, no `getResults`.
    // Reload cost then scales with post-watermark jobs, not all job history. A
    // still-running handle (`finishedAt === ''`) fails this guard — `passesWatermark`
    // fails open for an empty instant — and falls through to the poller path below.
    if (handle.finishedAt && !passesWatermark(handle.finishedAt, watermark)) {
      return;
    }

    // Re-associate the base by matching the job's input opaque URIs against the
    // reloaded scene's provenance (Seam 1) — uniform for every format.
    const baseId = reassociateBase(handle.inputUris, candidates);
    const context: SubmittedJobContext = {
      jobId: handle.jobId,
      taskId: handle.taskId,
      providerId,
      submittedAt: handle.finishedAt || new Date().toISOString(),
      ...(baseId ? { activeDatasetId: baseId } : {}),
      ...(handle.finishedAt ? { finishedAt: handle.finishedAt } : {}),
    };
    recordSubmittedContext(context);

    // Tier-2 reload economy — `state` on the handle (Chunk 27; the additive wire
    // half). When the facade stamps the neutral projected `state`, a TERMINAL-
    // NON-SUCCESS handle (`error`/`cancelled`) has no results to apply (result
    // reads gate on terminal success), so record its terminal status straight off
    // the handle and skip the `getJob` round-trip entirely. A terminal-SUCCESS
    // handle still fetches (proceeds exactly as today — it needs `getResults`),
    // and an ABSENT `state` (a pre-upgrade facade) falls through to the unchanged
    // `getJob` path — so a stateless producer behaves precisely as before.
    if (
      handle.state &&
      TERMINAL_STATES.has(handle.state) &&
      handle.state !== 'success'
    ) {
      recordJob({ jobId: handle.jobId, state: handle.state });
      return;
    }

    let status: ProcessingJobStatus;
    try {
      status = await provider.getJob(handle.jobId);
    } catch (err) {
      if (classifyError(err) === 'session-expired') markSessionExpired(err);
      return; // never fabricate a state for a re-discovered job
    }
    recordJob(status);

    if (!TERMINAL_STATES.has(status.state)) {
      // Still running from a prior page life: hand it to the normal poller to
      // finish this session (it terminates post-watermark, so it attaches via
      // tier-1). scheduleNextPoll (not pollOnce) avoids an immediate re-fetch —
      // we already have a fresh status.
      scheduleNextPoll(provider, handle.jobId, POLL_INTERVAL_MS);
      return;
    }
    // Result reads gate on terminal SUCCESS (contract Seam 3).
    if (status.state !== 'success') return;

    let results: ProcessingResult[];
    try {
      results = await provider.getResults(handle.jobId);
    } catch (err) {
      if (classifyError(err) === 'session-expired') markSessionExpired(err);
      else
        useMessageStore().addError(
          'Failed to fetch re-discovered job results',
          {
            error: err instanceof Error ? err : undefined,
          }
        );
      return; // a results-fetch error is an error, never a silent empty attach
    }
    jobResults.set(handle.jobId, results);

    // Headless auto-re-attach — additive-only, through the SAME applier tier-1
    // uses (convertImageToLabelmap via the state-file restore path), gated by
    // the watermark + scene-state idempotency. Dynamically imported so the
    // provider store never statically pulls the loader graph into the boot
    // bundle. With no re-associated base there is nothing to attach to.
    if (baseId) {
      const { autoLoadProcessingResults } =
        await import('@/src/actions/processResults');
      await autoLoadProcessingResults(results, context, watermark);
    }
  }

  async function reattachProviderJobs(
    providerId: string,
    candidates: ReattachCandidate[],
    watermark: string | undefined
  ) {
    let provider: ProcessingProvider;
    try {
      provider = await getProvider(providerId);
    } catch {
      return;
    }
    // Capability-gated: a backend with no durable enumeration (MONAI `/infer`)
    // advertises no `listRecentJobs` → degrade to tier-1 (in-session replay).
    if (!provider.listRecentJobs) return;
    let handles: NeutralJobHandle[];
    try {
      handles = await provider.listRecentJobs();
    } catch (err) {
      // A re-discovery failure is never fatal to the session — log and degrade.
      console.error('Tier-2 job re-discovery failed', err);
      return;
    }
    await Promise.all(
      handles.map((handle) =>
        reattachOneJob(provider, providerId, handle, candidates, watermark)
      )
    );
  }

  // Called once on load (App boot, after the launch data + providers are in).
  // Idempotent: a job already tracked this session is skipped.
  async function reattachRecentJobs() {
    const datasetStore = useDatasetStore();
    // Re-attach candidates: each reloaded image dataset + its verbatim
    // provenance URIs. Empty-provenance datasets (local drops / archives) can
    // never match a job input, so they are dropped up front.
    const candidates: ReattachCandidate[] = datasetStore.idsAsSelections
      .map((id: string) => ({
        id,
        uris: collectProvenanceUris(datasetStore.getDataSource(id)),
      }))
      .filter((candidate: ReattachCandidate) => candidate.uris.length > 0);
    const watermark = sessionSavedAt.value;

    await Promise.all(
      Array.from(configs.keys()).map((providerId) =>
        reattachProviderJobs(providerId, candidates, watermark)
      )
    );
  }

  return {
    configs,
    instances,
    jobs,
    jobResults,
    submittedContexts,
    providerCount,
    sessionExpired,
    sessionSavedAt,

    registerProviderConfig,
    clearProviders,
    clearJobs,
    getProvider,
    recordJob,
    recordSubmittedContext,
    submitJob,
    cancelJob,
    onJobComplete,
    stopPolling,
    setSessionWatermark,
    reattachRecentJobs,
  };
});
