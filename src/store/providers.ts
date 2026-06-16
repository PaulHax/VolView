// Processing providers store.
//
// Holds provider *configs* (registered on app boot from the manifest config
// JSON) and *instances* (created lazily on first `getProvider` call —
// dynamic-imports the adapter chunk).
//
// Also tracks submitted jobs and `SubmittedJobContext` records so result
// auto-attach can find the originating dataset client-side.

import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';

import type {
  ProcessingJobStatus,
  ProcessingProvider,
  ProcessingProviderConfig,
  ProcessingResult,
  ProcessingValue,
  SubmittedJobContext,
} from '@/src/processing/types';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATES = new Set<ProcessingJobStatus['state']>([
  'success',
  'error',
  'cancelled',
]);

const loadAdapter = async (
  config: ProcessingProviderConfig
): Promise<ProcessingProvider> => {
  // Dynamic import — Vite emits a separate chunk that's only fetched when
  // some surface (typically the Analysis tab) actually invokes this code path.
  switch (config.protocol) {
    case 'slicer-cli': {
      const mod = await import('@/src/processing/adapters/slicer-cli');
      return mod.createProvider(config);
    }
    default: {
      const exhaustive: never = config.protocol;
      throw new Error(`Unsupported processing protocol: ${exhaustive}`);
    }
  }
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
  const pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  // Subscribers fired when a job reaches a terminal state with its results.
  // Used by AnalysisModule to load result files into VolView (Phase 5).
  const completionListeners = new Set<
    (
      status: ProcessingJobStatus,
      results: ProcessingResult[],
      context?: SubmittedJobContext
    ) => void
  >();

  // Reactive counter so components can `v-if="providers.providerCount > 0"`.
  const providerCount = ref(0);

  function registerProviderConfig(config: ProcessingProviderConfig) {
    configs.set(config.id, config);
    providerCount.value = configs.size;
  }

  function clearProviders() {
    configs.clear();
    instances.clear();
    loading.clear();
    providerCount.value = 0;
  }

  async function getProvider(id: string): Promise<ProcessingProvider> {
    const existing = instances.get(id);
    if (existing) return existing;
    const inflight = loading.get(id);
    if (inflight) return inflight;
    const config = configs.get(id);
    if (!config) throw new Error(`Unknown provider id: ${id}`);
    const promise = loadAdapter(config).then((provider) => {
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

  function onJobComplete(
    cb: (
      status: ProcessingJobStatus,
      results: ProcessingResult[],
      context?: SubmittedJobContext
    ) => void
  ): () => void {
    completionListeners.add(cb);
    return () => completionListeners.delete(cb);
  }

  function stopPolling(jobId: string) {
    const timer = pollTimers.get(jobId);
    if (timer) clearInterval(timer);
    pollTimers.delete(jobId);
  }

  // Shared terminal-completion path. Fetches results for a successful job,
  // then notifies subscribers. Reached from both the poller and the
  // born-terminal fast-path in `submitJob`, so a synchronous job lands results
  // identically to a polled one. Assumes `status.state` is already terminal.
  async function fireCompletion(
    provider: ProcessingProvider,
    status: ProcessingJobStatus
  ) {
    const { jobId } = status;
    if (status.state === 'success') {
      try {
        const results = await provider.getResults(jobId);
        jobResults.set(jobId, results);
        const ctx = submittedContexts.get(jobId);
        completionListeners.forEach((cb) => cb(status, results, ctx));
      } catch (err) {
        console.error('Failed to fetch job results', jobId, err);
        completionListeners.forEach((cb) =>
          cb(status, [], submittedContexts.get(jobId))
        );
      }
    } else {
      completionListeners.forEach((cb) =>
        cb(status, [], submittedContexts.get(jobId))
      );
    }
  }

  async function pollOnce(provider: ProcessingProvider, jobId: string) {
    try {
      const status = await provider.getJob(jobId);
      recordJob(status);
      if (TERMINAL_STATES.has(status.state)) {
        stopPolling(jobId);
        await fireCompletion(provider, status);
      }
    } catch (err) {
      // Network blip — keep polling unless we've already stopped.

      console.warn('Job poll failed', jobId, err);
    }
  }

  async function submitJob(
    providerId: string,
    taskId: string,
    values: Record<string, ProcessingValue>,
    submittedContext: Omit<
      SubmittedJobContext,
      'jobId' | 'submittedAt' | 'taskId' | 'providerId'
    >
  ): Promise<string> {
    const provider = await getProvider(providerId);
    const config = configs.get(providerId);
    const ctx = config?.context ?? { loadedSources: [] };
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
    // job that is already terminal. Record its real state and route it through
    // the same completion path as a polled job, but never register a poller.
    // Polling stays the driver only for jobs that are not yet terminal.
    const initialStatus: ProcessingJobStatus = jobRef.status
      ? { ...jobRef.status, jobId }
      : { jobId, state: 'pending' };
    recordJob(initialStatus);
    if (TERMINAL_STATES.has(initialStatus.state)) {
      await fireCompletion(provider, initialStatus);
      return jobId;
    }

    pollOnce(provider, jobId);
    const timer = setInterval(
      () => pollOnce(provider, jobId),
      POLL_INTERVAL_MS
    );
    pollTimers.set(jobId, timer);
    return jobId;
  }

  return {
    configs,
    instances,
    jobs,
    jobResults,
    submittedContexts,
    providerCount,

    registerProviderConfig,
    clearProviders,
    getProvider,
    recordJob,
    recordSubmittedContext,
    submitJob,
    onJobComplete,
    stopPolling,
  };
});
