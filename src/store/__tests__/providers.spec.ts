import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import {
  useProvidersStore,
  POLL_INTERVAL_MS,
  MAX_POLL_RETRIES,
} from '@/src/store/providers';
import { MessageType, useMessageStore } from '@/src/store/messages';
import type {
  ProcessingJobRef,
  ProcessingJobStatus,
  ProcessingProvider,
  ProcessingResult,
} from '@/src/processing/types';

// The store checks the dataset store to detect a base image deleted mid-job
// (item 8). Mock it to a controllable id list so the whole lifecycle suite stays
// hermetic (no real dataset subtree). `generateBugReport` — reached whenever the
// message store surfaces an error — only reads `idsAsSelections` from this store,
// so this mock also keeps that path working.
const { datasetState } = vi.hoisted(() => ({
  datasetState: {
    ids: [] as string[],
    // Provenance the tier-2 re-association reads (getDataSource → DataSource).
    sources: {} as Record<string, unknown>,
  },
}));
vi.mock('@/src/store/datasets', () => ({
  useDatasetStore: () => ({
    idsAsSelections: datasetState.ids,
    getDataSource: (id: string) => datasetState.sources[id],
  }),
}));

// The tier-2 re-attach path dynamically imports the applier; mock it so the
// heavy loader graph never loads here and the call is assertable.
const { autoLoadMock } = vi.hoisted(() => ({ autoLoadMock: vi.fn() }));
vi.mock('@/src/actions/processResults', () => ({
  autoLoadProcessingResults: autoLoadMock,
}));

// Minimal fake provider — only the methods the lifecycle exercises are real.
const makeProvider = (
  overrides: Partial<ProcessingProvider>
): ProcessingProvider => ({
  config: {
    id: 'p1',
    label: 'Fake',
    baseUrl: 'http://localhost/',
  },
  listTasks: vi.fn().mockResolvedValue([]),
  getTaskSpec: vi.fn().mockResolvedValue({
    specVersion: 1,
    id: 't',
    title: 'T',
    parameters: [],
    outputs: [],
  }),
  getDefaultBindings: vi.fn().mockResolvedValue({}),
  runTask: vi.fn(),
  getJob: vi.fn(),
  getResults: vi.fn().mockResolvedValue(resultsBundle()),
  cancelJob: vi.fn().mockResolvedValue({ jobId: 'x', state: 'cancelled' }),
  stageInput: vi.fn().mockResolvedValue([]),
  ...overrides,
});

const sampleResults: ProcessingResult[] = [
  { id: 'r1', name: 'out.nrrd', url: 'http://localhost/out.nrrd' },
];

// getResults now resolves the {results, missing} envelope bundle (Chunk 28); wrap
// a plain result list for the mocks. `missing` defaults to 0 (a clean success).
const resultsBundle = (results: ProcessingResult[] = [], missing = 0) => ({
  results,
  missing,
});

// An error carrying an HTTP status, exactly as the engine transport throws
// (engine/transport.ts `HttpError`). The store's `classifyError` reads `.status`.
const httpError = (status: number): Error => {
  const err = new Error(`Request failed: ${status}`) as Error & {
    status: number;
  };
  err.status = status;
  return err;
};

describe('Providers store — job lifecycle (D5 async-with-sync-fast-path)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    datasetState.ids = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes a born-terminal job through completion without scheduling a poller', async () => {
    const store = useProvidersStore();

    const status: ProcessingJobStatus = { jobId: 'job-sync', state: 'success' };
    const getJob = vi.fn();
    const getResults = vi.fn().mockResolvedValue(resultsBundle(sampleResults));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-sync', status } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob, getResults });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    const jobId = await store.submitJob('p1', 'task-1', {}, {});

    // Completion fired exactly once with the terminal status + fetched results.
    expect(jobId).toBe('job-sync');
    expect(getResults).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status,
        results: sampleResults,
        context: expect.objectContaining({
          jobId: 'job-sync',
          taskId: 'task-1',
        }),
      })
    );
    expect(store.jobs.get('job-sync')?.state).toBe('success');
    expect(store.jobResults.get('job-sync')).toEqual(sampleResults);
    expect(
      useMessageStore().messages.filter((m) => m.type === MessageType.Success)
    ).toEqual([
      expect.objectContaining({
        title: 'Job complete: task-1',
        options: expect.objectContaining({
          details: '1 result available in the Jobs panel.',
        }),
      }),
    ]);

    // No poller: getJob is never called, even after intervals elapse.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(getJob).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('polls non-terminal jobs until terminal, then completes once', async () => {
    const store = useProvidersStore();

    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ jobId: 'job-async', state: 'running' })
      .mockResolvedValue({ jobId: 'job-async', state: 'success' });
    const getResults = vi.fn().mockResolvedValue(resultsBundle(sampleResults));
    // No `status` on the ref → store treats the job as pending and polls.
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-async' } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob, getResults });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    await store.submitJob('p1', 'task-1', {}, {});

    // Immediate poll observed `running` — still polling, not complete.
    await vi.advanceTimersByTimeAsync(0);
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();

    // Next interval observes `success` → completion fires once.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { jobId: 'job-async', state: 'success' },
        results: sampleResults,
        context: expect.objectContaining({ jobId: 'job-async' }),
      })
    );

    // Poller stopped after terminal — no further getJob calls.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  // Cancel (contract Seam 3 best-effort; D5): the cancel action is ONE neutral
  // engine call. It does not terminalize the job itself — the EXISTING poller
  // converges on whatever terminal state the backend reports, so `cancelled` is
  // never fabricated and completion still fires exactly once.
  it('cancel action fires one engine call; the poller converges on cancelled', async () => {
    const store = useProvidersStore();

    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ jobId: 'job-cancel', state: 'running' })
      .mockResolvedValue({ jobId: 'job-cancel', state: 'cancelled' });
    const getResults = vi.fn().mockResolvedValue(resultsBundle(sampleResults));
    const cancelJob = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-cancel', state: 'cancelled' });
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-cancel' } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob, getResults, cancelJob });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    const jobId = await store.submitJob('p1', 'task-1', {}, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(getJob).toHaveBeenCalledTimes(1);

    // The user cancels — one neutral engine call with the job id.
    await store.cancelJob(jobId);
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith('job-cancel');
    // Cancel itself did NOT complete the job — the poller is still the driver.
    expect(listener).not.toHaveBeenCalled();
    expect(store.jobs.get('job-cancel')?.state).toBe('running');

    // The existing poller observes the backend's terminal `cancelled`.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(store.jobs.get('job-cancel')?.state).toBe('cancelled');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { jobId: 'job-cancel', state: 'cancelled' },
        results: [],
        context: expect.objectContaining({ jobId: 'job-cancel' }),
      })
    );
    // A cancelled (non-success) terminal fetches no results.
    expect(getResults).not.toHaveBeenCalled();

    // Poller stopped after terminal.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  // Fail closed: cancelling a job the store never tracked is a no-op that never
  // reaches a provider and never throws to the UI.
  it('cancel of an untracked job is a no-op', async () => {
    const store = useProvidersStore();
    const cancelJob = vi.fn();
    store.instances.set('p1', makeProvider({ cancelJob }));

    await expect(store.cancelJob('ghost')).resolves.toBeUndefined();
    expect(cancelJob).not.toHaveBeenCalled();
  });

  // Best-effort: a failed cancel request is surfaced (not thrown), and the
  // poller keeps running so a job that terminates on its own still converges.
  it('surfaces a cancel failure without throwing and keeps polling', async () => {
    const store = useProvidersStore();

    const getJob = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-cf', state: 'running' });
    const cancelJob = vi.fn().mockRejectedValue(httpError(500));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-cf' } as ProcessingJobRef);
    store.instances.set('p1', makeProvider({ runTask, getJob, cancelJob }));

    const jobId = await store.submitJob('p1', 'task-1', {}, {});
    await vi.advanceTimersByTimeAsync(0);

    await expect(store.cancelJob(jobId)).resolves.toBeUndefined();

    const errs = useMessageStore().messages.filter(
      (m) => m.type === MessageType.Error
    );
    expect(errs.some((m) => /cancel/i.test(m.title))).toBe(true);
    // Poller is untouched — the job is still tracked and polling.
    expect(store.jobs.get('job-cf')?.state).toBe('running');
  });

  // An adapter that meets a malformed wire status returns an `error` job state
  // (item 4.3). `error` is terminal, so the poller must stop rather than loop
  // forever, and completion fires with no results (state is not `success`).
  it('stops polling and completes with no results when a job errors', async () => {
    const store = useProvidersStore();

    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ jobId: 'job-err', state: 'running' })
      .mockResolvedValue({
        jobId: 'job-err',
        state: 'error',
        errorTail: 'boom',
      });
    const getResults = vi.fn().mockResolvedValue(resultsBundle(sampleResults));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-err' } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob, getResults });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    await store.submitJob('p1', 'task-1', {}, {});

    await vi.advanceTimersByTimeAsync(0); // running — still polling
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // error — terminal
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(store.jobs.get('job-err')?.state).toBe('error');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({ jobId: 'job-err', state: 'error' }),
        results: [],
        context: expect.objectContaining({ jobId: 'job-err' }),
      })
    );
    expect(
      useMessageStore().messages.filter((m) => m.type === MessageType.Error)
    ).toEqual([
      expect.objectContaining({
        title: 'Job failed: task-1',
        options: expect.objectContaining({ details: 'boom' }),
      }),
    ]);
    expect(getResults).not.toHaveBeenCalled();

    // Poller stopped — no further polls no matter how much time elapses.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  // The born-terminal fast-path equivalent: a malformed born-terminal ref is
  // validated to an `error` status at the adapter seam, so the store routes it
  // through completion once and never registers a poller (no infinite poll).
  it('routes a born-terminal error ref through completion without polling', async () => {
    const store = useProvidersStore();

    const status: ProcessingJobStatus = {
      jobId: 'job-born-err',
      state: 'error',
      errorTail: 'malformed',
    };
    const getJob = vi.fn();
    const getResults = vi.fn().mockResolvedValue(resultsBundle(sampleResults));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-born-err', status } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob, getResults });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    const jobId = await store.submitJob('p1', 'task-1', {}, {});

    expect(jobId).toBe('job-born-err');
    expect(store.jobs.get('job-born-err')?.state).toBe('error');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({
          jobId: 'job-born-err',
          state: 'error',
        }),
        results: [],
        context: expect.objectContaining({ jobId: 'job-born-err' }),
      })
    );
    expect(
      useMessageStore().messages.filter((m) => m.type === MessageType.Error)
    ).toEqual([
      expect.objectContaining({
        title: 'Job failed: task-1',
        options: expect.objectContaining({ details: 'malformed' }),
      }),
    ]);
    expect(getResults).not.toHaveBeenCalled();

    // No poller registered — getJob never called even after intervals elapse.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('surfaces a clear fallback when a job error has no backend details', async () => {
    const store = useProvidersStore();

    const status: ProcessingJobStatus = {
      jobId: 'job-no-detail',
      state: 'error',
    };
    const runTask = vi.fn().mockResolvedValue({
      jobId: 'job-no-detail',
      status,
    } as ProcessingJobRef);
    const provider = makeProvider({
      runTask,
      getJob: vi.fn(),
      getResults: vi.fn(),
    });
    store.instances.set('p1', provider);

    await store.submitJob('p1', 'task-1', {}, {});

    expect(
      useMessageStore().messages.filter((m) => m.type === MessageType.Error)
    ).toEqual([
      expect.objectContaining({
        title: 'Job failed: task-1',
        options: expect.objectContaining({
          details: expect.stringContaining('did not include error details'),
        }),
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Chunk 12 — tier-1 durability + failure UX.
//
// Each of the seven PLAN "Job-tracking failure UX" behaviors gets an explicit
// case; the marquee case is the tab-switch replay (unmount → terminal event →
// remount → exactly one replay).
// ---------------------------------------------------------------------------

describe('Providers store — tier-1 durability + failure UX (Chunk 12)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    datasetState.ids = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const errorMessages = () =>
    useMessageStore().messages.filter((m) => m.type === MessageType.Error);
  const warningMessages = () =>
    useMessageStore().messages.filter((m) => m.type === MessageType.Warning);

  // Item 1 — the durability acceptance: a job that finishes while the Jobs tab
  // is unmounted (no listener) replays into a fresh subscription EXACTLY ONCE.
  it('replays a terminal completion to a listener that subscribes after the event (tab-switch replay, item 1)', async () => {
    const store = useProvidersStore();

    const status: ProcessingJobStatus = {
      jobId: 'job-replay',
      state: 'success',
    };
    const getJob = vi.fn();
    const getResults = vi.fn().mockResolvedValue(resultsBundle(sampleResults));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-replay', status } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob, getResults });
    store.instances.set('p1', provider);

    // Job finishes with NO listener subscribed (Jobs tab unmounted). The records
    // survive the unmount (JobList would still render it on remount).
    await store.submitJob('p1', 'task-1', {}, {});
    expect(store.jobs.get('job-replay')?.state).toBe('success');
    expect(store.jobResults.get('job-replay')).toEqual(sampleResults);

    // Remount: subscribe now → the completion replays exactly once.
    const listener = vi.fn();
    const unsubscribe = store.onJobComplete(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ status, results: sampleResults })
    );

    // Unmount, then remount with a FRESH callback (as the component does each
    // mount): the already-delivered completion is NOT replayed a second time.
    unsubscribe();
    const listener2 = vi.fn();
    store.onJobComplete(listener2);
    expect(listener2).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Item 3 — the poll loop bounds transient retries with exponential backoff and
  // then fails the job loud; it never loops quietly forever.
  it('bounds transient poll retries with backoff, then fails the job loud (item 3)', async () => {
    const store = useProvidersStore();

    // No HTTP status → a network blip → transient (retryable).
    const getJob = vi.fn().mockRejectedValue(new Error('network blip'));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-flaky' } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    await store.submitJob('p1', 'task-1', {}, {});

    // The immediate poll failed once. Backoff means the next retry is NOT at the
    // base interval — advancing one base interval fires no second poll.
    await vi.advanceTimersByTimeAsync(0);
    expect(getJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getJob).toHaveBeenCalledTimes(1);

    // Drive the bounded retries to exhaustion.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    // Bounded: exactly MAX_POLL_RETRIES retries after the first attempt.
    expect(getJob).toHaveBeenCalledTimes(MAX_POLL_RETRIES + 1);
    // Failed loud: the job is errored and surfaced (never a quiet infinite loop).
    expect(store.jobs.get('job-flaky')?.state).toBe('error');
    expect(errorMessages().length).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({ state: 'error' }),
        results: [],
      })
    );

    // The loop is truly stopped — no further polling.
    const settled = getJob.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(getJob).toHaveBeenCalledTimes(settled);
  });

  // Item 3 (permanent branch) — a 4xx is not transient: no retry, fail at once.
  it('fails a job immediately on a permanent poll error, without retrying (item 3)', async () => {
    const store = useProvidersStore();

    const getJob = vi.fn().mockRejectedValue(httpError(400));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-bad' } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob });
    store.instances.set('p1', provider);

    await store.submitJob('p1', 'task-1', {}, {});
    await vi.advanceTimersByTimeAsync(0);

    expect(getJob).toHaveBeenCalledTimes(1);
    expect(store.jobs.get('job-bad')?.state).toBe('error');
    expect(errorMessages().length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(getJob).toHaveBeenCalledTimes(1); // never retried
  });

  // Item 4 — a submit failure is surfaced in the UI (message center), not
  // swallowed to a console.error.
  it('surfaces a submit failure in the message center instead of swallowing it (item 4)', async () => {
    const store = useProvidersStore();

    const runTask = vi.fn().mockRejectedValue(new Error('submit exploded'));
    const provider = makeProvider({ runTask });
    store.instances.set('p1', provider);

    await expect(store.submitJob('p1', 'task-1', {}, {})).rejects.toThrow(
      'submit exploded'
    );

    const errs = errorMessages();
    expect(errs.length).toBe(1);
    expect(errs[0].title).toMatch(/submit/i);
  });

  // Item 5 — result reads gate on success AND a results-fetch error is an ERROR,
  // never empty results (the old `notify([])` conflated failure with empty).
  it('treats a results-fetch error as an error, never empty results (item 5)', async () => {
    const store = useProvidersStore();

    const status: ProcessingJobStatus = {
      jobId: 'job-fetch-fail',
      state: 'success',
    };
    const getResults = vi.fn().mockRejectedValue(new Error('results 500'));
    const runTask = vi.fn().mockResolvedValue({
      jobId: 'job-fetch-fail',
      status,
    } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getResults, getJob: vi.fn() });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    await store.submitJob('p1', 'task-1', {}, {});

    // The gate opened on success, so results were attempted...
    expect(getResults).toHaveBeenCalledTimes(1);
    // ...but the failure became an ERROR, not an empty-results success.
    expect(store.jobs.get('job-fetch-fail')?.state).toBe('error');
    expect(store.jobResults.get('job-fetch-fail')).toBeUndefined();
    expect(errorMessages().some((m) => /result/i.test(m.title))).toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    const completion = listener.mock.calls[0][0];
    expect(completion.status.state).toBe('error');
    expect(completion.results).toEqual([]);
  });

  // Item 6 — timers are stopped and job records dropped on clear (no leak of an
  // in-flight poller or stale record on a provider reset).
  it('stops timers and drops job records on clear (item 6)', async () => {
    const store = useProvidersStore();

    // A running (non-terminal) job → a live poll timer to leak.
    const getJob = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-live', state: 'running' });
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-live' } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob });
    store.instances.set('p1', provider);

    await store.submitJob('p1', 'task-1', {}, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(store.jobs.size).toBe(1);
    const polledBeforeClear = getJob.mock.calls.length;

    // Clear → records dropped AND the poll timer stopped.
    store.clearProviders();
    expect(store.jobs.size).toBe(0);
    expect(store.jobResults.size).toBe(0);
    expect(store.submittedContexts.size).toBe(0);

    // Timer really stopped — no more polling after the clear.
    await vi.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
    expect(getJob).toHaveBeenCalledTimes(polledBeforeClear);
  });

  // Item 7 — a 401/403 mid-job means the whole same-origin session is dead:
  // flag it (so the UI prompts a reload), surface a persistent message, and stop
  // all polling.
  it('marks the session expired and stops all polling on a 401 mid-job (item 7)', async () => {
    const store = useProvidersStore();

    const getJob = vi.fn().mockRejectedValue(httpError(401));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-401' } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getJob });
    store.instances.set('p1', provider);

    await store.submitJob('p1', 'task-1', {}, {});
    await vi.advanceTimersByTimeAsync(0);

    expect(store.sessionExpired).toBe(true);
    const expiry = errorMessages().find((m) =>
      /session has expired/i.test(m.title)
    );
    expect(expiry).toBeDefined();
    expect(expiry?.options.persist).toBe(true);

    // No retry storm on a dead session — polling stopped entirely.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(getJob).toHaveBeenCalledTimes(1);
  });

  // Item 8 — the originating base image was removed mid-job: detect + message,
  // and the result is NOT silently dropped (it stays in the Jobs panel).
  it('detects a base image deleted mid-job and messages without dropping the result (item 8)', async () => {
    datasetState.ids = []; // the originating dataset is gone
    const store = useProvidersStore();

    const status: ProcessingJobStatus = {
      jobId: 'job-orphan',
      state: 'success',
    };
    const getResults = vi.fn().mockResolvedValue(resultsBundle(sampleResults));
    const runTask = vi.fn().mockResolvedValue({
      jobId: 'job-orphan',
      status,
    } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getResults, getJob: vi.fn() });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    // Submitted against a dataset that is no longer loaded at completion time.
    await store.submitJob(
      'p1',
      'task-1',
      {},
      { activeDatasetId: 'ds-removed' }
    );

    // Detected + messaged (a warning)...
    expect(warningMessages().some((m) => /base image/i.test(m.title))).toBe(
      true
    );
    // ...and the result is retained, not silently dropped.
    expect(store.jobResults.get('job-orphan')).toEqual(sampleResults);
    const completion = listener.mock.calls[0][0];
    expect(completion.baseImageMissing).toBe(true);
    expect(completion.results).toEqual(sampleResults);
  });

  // Item 8 (no false positive) — when the base image is still loaded, no
  // deleted-base warning fires and the completion is a normal auto-attach.
  it('does not flag a missing base image when the originating dataset is still loaded (item 8)', async () => {
    datasetState.ids = ['ds-present'];
    const store = useProvidersStore();

    const status: ProcessingJobStatus = { jobId: 'job-ok', state: 'success' };
    const getResults = vi.fn().mockResolvedValue(resultsBundle(sampleResults));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-ok', status } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getResults, getJob: vi.fn() });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    await store.submitJob(
      'p1',
      'task-1',
      {},
      { activeDatasetId: 'ds-present' }
    );

    expect(warningMessages().some((m) => /base image/i.test(m.title))).toBe(
      false
    );
    const completion = listener.mock.calls[0][0];
    expect(completion.baseImageMissing).toBeFalsy();
    expect(completion.results).toEqual(sampleResults);
  });

  // Chunk 28 — the facade could not resolve some recorded outputs (deleted /
  // unreadable): a non-zero `missing` on a SUCCESS is a partial loss. Surface a
  // warning that names the count WITHOUT dropping the results that resolved.
  it('surfaces a partial-loss warning on a non-zero missing count, still applying the results', async () => {
    datasetState.ids = ['ds-present'];
    const store = useProvidersStore();

    const status: ProcessingJobStatus = { jobId: 'job-miss', state: 'success' };
    // Two outputs were recorded; the facade could resolve only one.
    const getResults = vi
      .fn()
      .mockResolvedValue(resultsBundle(sampleResults, 2));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-miss', status } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getResults, getJob: vi.fn() });
    store.instances.set('p1', provider);

    const listener = vi.fn();
    store.onJobComplete(listener);

    await store.submitJob(
      'p1',
      'task-1',
      {},
      { activeDatasetId: 'ds-present' }
    );

    // A warning naming the count is surfaced...
    const warning = warningMessages().find((m) =>
      /could not be retrieved/i.test(m.title)
    );
    expect(warning).toBeTruthy();
    expect(warning?.title).toContain('2');
    // ...and the results that DID resolve are still recorded + delivered.
    expect(store.jobResults.get('job-miss')).toEqual(sampleResults);
    expect(listener.mock.calls[0][0].results).toEqual(sampleResults);
  });

  // No false positive: a clean success (missing 0) surfaces NO output-loss warning.
  it('surfaces no partial-loss warning when nothing is missing', async () => {
    datasetState.ids = ['ds-present'];
    const store = useProvidersStore();

    const status: ProcessingJobStatus = {
      jobId: 'job-clean',
      state: 'success',
    };
    const getResults = vi
      .fn()
      .mockResolvedValue(resultsBundle(sampleResults, 0));
    const runTask = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-clean', status } as ProcessingJobRef);
    const provider = makeProvider({ runTask, getResults, getJob: vi.fn() });
    store.instances.set('p1', provider);
    store.onJobComplete(vi.fn());

    await store.submitJob(
      'p1',
      'task-1',
      {},
      { activeDatasetId: 'ds-present' }
    );

    expect(
      warningMessages().some((m) => /could not be retrieved/i.test(m.title))
    ).toBe(false);
  });
});

describe('Providers store — tier-2 cold-reload re-discovery (Chunk 19)', () => {
  const config = { id: 'p1', label: 'Fake', baseUrl: 'http://localhost/' };

  const handle = (overrides: Record<string, unknown> = {}) => ({
    jobId: 'jr',
    taskId: 't1',
    inputUris: ['/f/a'],
    finishedAt: '2026-07-03T20:00:00Z',
    ...overrides,
  });

  // Register a provider config + preset its instance so getProvider returns the
  // fake (no dynamic import), and give the reloaded scene one server dataset
  // whose provenance is the job's input URI.
  const arrange = (provider: ProcessingProvider) => {
    const store = useProvidersStore();
    store.registerProviderConfig(config);
    store.instances.set('p1', provider);
    datasetState.ids = ['ds1'];
    datasetState.sources = { ds1: { type: 'uri', uri: '/f/a' } };
    return store;
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    datasetState.ids = [];
    datasetState.sources = {};
    autoLoadMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('capability absent → degrades to tier-1 (no re-discovery, no apply)', async () => {
    // makeProvider omits listRecentJobs → the provider advertises no tier-2.
    const provider = makeProvider({ getJob: vi.fn(), getResults: vi.fn() });
    const store = arrange(provider);

    await store.reattachRecentJobs();

    expect(provider.getJob).not.toHaveBeenCalled();
    expect(autoLoadMock).not.toHaveBeenCalled();
    expect(store.submittedContexts.size).toBe(0);
  });

  it('auto-re-attaches a terminal-succeeded re-discovered job (no click)', async () => {
    const provider = makeProvider({
      listRecentJobs: vi.fn().mockResolvedValue([handle()]),
      getJob: vi.fn().mockResolvedValue({ jobId: 'jr', state: 'success' }),
      getResults: vi.fn().mockResolvedValue(resultsBundle(sampleResults)),
    });
    const store = arrange(provider);

    await store.reattachRecentJobs();

    // Re-associated to the reloaded dataset by input-URI provenance, context
    // carries the terminal instant, and the applier ran with the watermark.
    const ctx = store.submittedContexts.get('jr');
    expect(ctx?.activeDatasetId).toBe('ds1');
    expect(ctx?.taskId).toBe('t1');
    expect(ctx?.finishedAt).toBe('2026-07-03T20:00:00Z');
    expect(provider.getResults).toHaveBeenCalledWith('jr');
    expect(autoLoadMock).toHaveBeenCalledTimes(1);
    expect(autoLoadMock).toHaveBeenCalledWith(sampleResults, ctx, undefined);
  });

  it('threads the session watermark into the applier', async () => {
    const provider = makeProvider({
      listRecentJobs: vi.fn().mockResolvedValue([handle()]),
      getJob: vi.fn().mockResolvedValue({ jobId: 'jr', state: 'success' }),
      getResults: vi.fn().mockResolvedValue(resultsBundle(sampleResults)),
    });
    const store = arrange(provider);
    store.setSessionWatermark('2026-07-03T12:00:00Z');

    await store.reattachRecentJobs();

    expect(autoLoadMock).toHaveBeenCalledWith(
      sampleResults,
      expect.anything(),
      '2026-07-03T12:00:00Z'
    );
  });

  it('records results but does not auto-apply when no base re-associates', async () => {
    const provider = makeProvider({
      listRecentJobs: vi
        .fn()
        .mockResolvedValue([handle({ inputUris: ['/f/nowhere'] })]),
      getJob: vi.fn().mockResolvedValue({ jobId: 'jr', state: 'success' }),
      getResults: vi.fn().mockResolvedValue(resultsBundle(sampleResults)),
    });
    const store = arrange(provider);

    await store.reattachRecentJobs();

    // The job is tracked + its results fetched (JobList shows them) but there is
    // no base to attach to, so the applier is not invoked.
    expect(store.submittedContexts.get('jr')?.activeDatasetId).toBeUndefined();
    expect(store.jobResults.get('jr')).toEqual(sampleResults);
    expect(autoLoadMock).not.toHaveBeenCalled();
  });

  it('a re-discovery listing failure is not fatal (logged, degrades)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = makeProvider({
      listRecentJobs: vi.fn().mockRejectedValue(new Error('boom')),
      getJob: vi.fn(),
    });
    const store = arrange(provider);

    await expect(store.reattachRecentJobs()).resolves.toBeUndefined();
    expect(autoLoadMock).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it('does not re-adopt a job already tracked this session', async () => {
    const provider = makeProvider({
      listRecentJobs: vi.fn().mockResolvedValue([handle()]),
      getJob: vi.fn().mockResolvedValue({ jobId: 'jr', state: 'success' }),
      getResults: vi.fn().mockResolvedValue(resultsBundle(sampleResults)),
    });
    const store = arrange(provider);
    // Tier-1 already owns this job id.
    store.recordSubmittedContext({
      jobId: 'jr',
      taskId: 't1',
      providerId: 'p1',
      submittedAt: '2026-07-03T19:00:00Z',
    });

    await store.reattachRecentJobs();

    expect(provider.getJob).not.toHaveBeenCalled();
    expect(autoLoadMock).not.toHaveBeenCalled();
  });

  it('a still-running re-discovered job is tracked for polling, not applied', async () => {
    const provider = makeProvider({
      listRecentJobs: vi.fn().mockResolvedValue([handle({ finishedAt: '' })]),
      getJob: vi.fn().mockResolvedValue({ jobId: 'jr', state: 'running' }),
      getResults: vi.fn().mockResolvedValue(resultsBundle(sampleResults)),
    });
    const store = arrange(provider);

    await store.reattachRecentJobs();

    expect(store.jobs.get('jr')?.state).toBe('running');
    expect(provider.getResults).not.toHaveBeenCalled();
    expect(autoLoadMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Chunk 27 — tier-2 reload economy (watermark short-circuit + `state` on the
  // handle). Reload cost stops scaling with total job history (review §4.4).
  // ---------------------------------------------------------------------------

  // The watermark short-circuit (NO wire change): a TERMINAL handle (non-empty
  // finishedAt) that falls at/before the session watermark can never auto-attach,
  // so it is skipped WHOLE — zero transport, nothing tracked.
  it('pre-watermark terminal handle → ZERO transport calls, nothing tracked', async () => {
    const provider = makeProvider({
      // handle() finishedAt is 2026-07-03T20:00:00Z — BEFORE the watermark below.
      listRecentJobs: vi.fn().mockResolvedValue([handle()]),
      getJob: vi.fn().mockResolvedValue({ jobId: 'jr', state: 'success' }),
      getResults: vi.fn().mockResolvedValue(resultsBundle(sampleResults)),
    });
    const store = arrange(provider);
    store.setSessionWatermark('2026-07-03T22:00:00Z');

    await store.reattachRecentJobs();

    expect(provider.getJob).not.toHaveBeenCalled();
    expect(provider.getResults).not.toHaveBeenCalled();
    expect(autoLoadMock).not.toHaveBeenCalled();
    // Skipped before recordSubmittedContext — the job is not adopted at all.
    expect(store.submittedContexts.has('jr')).toBe(false);
    expect(store.jobs.has('jr')).toBe(false);
  });

  // `state` on the handle: a terminal-NON-SUCCESS handle records its terminal
  // status straight off the handle — no getJob, no getResults (a non-success
  // terminal has no results to apply). Still tracked so JobList renders it.
  it.each(['error', 'cancelled'] as const)(
    'records a terminal-%s handle from its `state` without a getJob (Chunk 27)',
    async (state) => {
      const provider = makeProvider({
        listRecentJobs: vi.fn().mockResolvedValue([handle({ state })]),
        getJob: vi.fn(),
        getResults: vi.fn(),
      });
      const store = arrange(provider);

      await store.reattachRecentJobs();

      expect(provider.getJob).not.toHaveBeenCalled();
      expect(provider.getResults).not.toHaveBeenCalled();
      expect(autoLoadMock).not.toHaveBeenCalled();
      expect(store.jobs.get('jr')?.state).toBe(state);
      expect(store.submittedContexts.get('jr')?.taskId).toBe('t1');
    }
  );

  // The terminal-branch split must NOT collapse: a terminal-SUCCESS handle still
  // fetches (it needs getResults) even when it carries `state` — proceeds exactly
  // as today.
  it('a terminal-SUCCESS handle with `state` still fetches (getJob + getResults)', async () => {
    const provider = makeProvider({
      listRecentJobs: vi.fn().mockResolvedValue([handle({ state: 'success' })]),
      getJob: vi.fn().mockResolvedValue({ jobId: 'jr', state: 'success' }),
      getResults: vi.fn().mockResolvedValue(resultsBundle(sampleResults)),
    });
    const store = arrange(provider);

    await store.reattachRecentJobs();

    expect(provider.getJob).toHaveBeenCalledWith('jr');
    expect(provider.getResults).toHaveBeenCalledWith('jr');
    expect(autoLoadMock).toHaveBeenCalledTimes(1);
  });

  // Regression pin: an ABSENT `state` handle (a pre-upgrade facade) behaves
  // EXACTLY as before — the unchanged getJob → getResults → auto-apply path.
  it('an absent-`state` handle behaves exactly as before (getJob path; regression pin)', async () => {
    const provider = makeProvider({
      listRecentJobs: vi.fn().mockResolvedValue([handle()]),
      getJob: vi.fn().mockResolvedValue({ jobId: 'jr', state: 'success' }),
      getResults: vi.fn().mockResolvedValue(resultsBundle(sampleResults)),
    });
    const store = arrange(provider);

    await store.reattachRecentJobs();

    expect('state' in handle()).toBe(false);
    expect(provider.getJob).toHaveBeenCalledWith('jr');
    expect(provider.getResults).toHaveBeenCalledWith('jr');
    expect(autoLoadMock).toHaveBeenCalledTimes(1);
  });
});
