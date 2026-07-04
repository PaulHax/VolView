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
  datasetState: { ids: [] as string[] },
}));
vi.mock('@/src/store/datasets', () => ({
  useDatasetStore: () => ({ idsAsSelections: datasetState.ids }),
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
  getResults: vi.fn().mockResolvedValue([]),
  ...overrides,
});

const sampleResults: ProcessingResult[] = [
  { id: 'r1', name: 'out.nrrd', url: 'http://localhost/out.nrrd' },
];

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
    const getResults = vi.fn().mockResolvedValue(sampleResults);
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
    const getResults = vi.fn().mockResolvedValue(sampleResults);
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
    const getResults = vi.fn().mockResolvedValue(sampleResults);
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
    const getResults = vi.fn().mockResolvedValue(sampleResults);
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
    expect(getResults).not.toHaveBeenCalled();

    // No poller registered — getJob never called even after intervals elapse.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(getJob).not.toHaveBeenCalled();
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
    const getResults = vi.fn().mockResolvedValue(sampleResults);
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
    const getResults = vi.fn().mockResolvedValue(sampleResults);
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
    const getResults = vi.fn().mockResolvedValue(sampleResults);
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
});
