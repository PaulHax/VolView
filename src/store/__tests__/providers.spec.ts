import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import { useProvidersStore } from '@/src/store/providers';
import type {
  ProcessingJobRef,
  ProcessingJobStatus,
  ProcessingProvider,
  ProcessingResult,
} from '@/src/processing/types';

// Mirrors the private constant in the store under test.
const POLL_INTERVAL_MS = 2000;

// Minimal fake provider — only the methods the lifecycle exercises are real.
const makeProvider = (
  overrides: Partial<ProcessingProvider>
): ProcessingProvider => ({
  config: {
    id: 'p1',
    label: 'Fake',
    protocol: 'slicer-cli',
    baseUrl: 'http://localhost/',
  },
  listTasks: vi.fn().mockResolvedValue([]),
  getTaskXml: vi.fn().mockResolvedValue(''),
  getDefaultBindings: vi.fn().mockResolvedValue({}),
  runTask: vi.fn(),
  getJob: vi.fn(),
  getResults: vi.fn().mockResolvedValue([]),
  ...overrides,
});

const sampleResults: ProcessingResult[] = [
  { id: 'r1', name: 'out.nrrd', url: 'http://localhost/out.nrrd' },
];

describe('Providers store — job lifecycle (D5 async-with-sync-fast-path)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
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
      status,
      sampleResults,
      expect.objectContaining({ jobId: 'job-sync', taskId: 'task-1' })
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
      { jobId: 'job-async', state: 'success' },
      sampleResults,
      expect.objectContaining({ jobId: 'job-async' })
    );

    // Poller stopped after terminal — no further getJob calls.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(getJob).toHaveBeenCalledTimes(2);
  });
});
