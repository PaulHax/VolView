// ---------------------------------------------------------------------------
// Generic processing engine — HTTP transport (contract Seam 2/3; decision C3).
//
// ONE generic engine speaks to every backend. It knows no backend format and no
// endpoint layout: every transport specific — endpoint templates, where input
// values ride in the request, the poll-vs-inline lifecycle, and the wire result
// format — is read from a single `TransportDescriptor` the engine is handed
// (see `descriptor.ts`). v1 ships exactly ONE descriptor (the neutral-facade
// default); backend #2 (MONAI, facade-less) adds a SECOND descriptor, never an
// engine rewrite. That is the whole point of the C3 seam: the engine is the
// invariant, the descriptor is the variable.
//
// All engine HTTP goes through `$fetch` (src/utils/fetch.ts), the bearer-auth
// aware wrapper that merges the global `Authorization` header. Raw `fetch`
// would bypass that header, so it is never used here.
//
// House rules: functional style; `type`, not `interface`.
// ---------------------------------------------------------------------------

import { $fetch } from '@/src/utils/fetch';
import type {
  ProcessingJobRef,
  ProcessingJobStatus,
  ProcessingResult,
  ProcessingValue,
  SlicerCliTaskSummary,
} from '@/src/processing/types';
import type { TaskSpecEnvelope } from './taskSpec';

// ---------------------------------------------------------------------------
// Descriptor — the single object holding every settled transport axis
// ---------------------------------------------------------------------------

// Poll-vs-inline lifecycle axis. v1 implements only `poll` (the neutral facade
// hands back a job id the store polls); `inline` (a synchronous /infer backend
// that returns a born-terminal job in the run response) is a reserved seam, not
// a built driver — the engine fails closed on it until backend #2 exists.
export type TransportLifecycle = 'poll' | 'inline';

// Result-format axis: how each untrusted wire payload is validated into the
// engine's neutral shapes. The default instance delegates to the existing wire
// validators; a second backend supplies its own without touching the engine.
export type TransportFormat = {
  parseTasks: (raw: unknown) => SlicerCliTaskSummary[];
  parseSpec: (raw: unknown) => TaskSpecEnvelope;
  parseRunResponse: (raw: unknown) => ProcessingJobRef;
  parseStatus: (jobId: string, raw: unknown) => ProcessingJobStatus;
  parseResults: (raw: unknown) => ProcessingResult[];
};

export type TransportDescriptor = {
  // Endpoint templates — where each call goes, given the provider baseUrl.
  endpoints: {
    listTasks: (baseUrl: string) => string;
    taskSpec: (baseUrl: string, taskId: string) => string;
    runTask: (baseUrl: string, taskId: string) => string;
    jobStatus: (baseUrl: string, jobId: string) => string;
    jobResults: (baseUrl: string, jobId: string) => string;
  };
  // Input-placement axis — how the bound input values ride in the run request
  // (the neutral default posts `{ values }` as a JSON body).
  buildRunRequest: (values: Record<string, ProcessingValue>) => RequestInit;
  lifecycle: TransportLifecycle;
  format: TransportFormat;
};

// ---------------------------------------------------------------------------
// $fetch helpers — bearer-aware, never raw fetch
// ---------------------------------------------------------------------------

// The HTTP status rides on the thrown error so the job poller can classify it
// (transient vs permanent vs session-expiry vs resource-gone; store/providers.ts
// `classifyError`). A rejected `$fetch` (offline / DNS) carries no status and is
// treated as transient. Functional style: a plain `Error` with a `status` field,
// not an Error subclass.
export type HttpError = Error & { status: number };

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await $fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(
      `Request failed: ${res.status} ${res.statusText} ${body}`
    ) as HttpError;
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
};

// ---------------------------------------------------------------------------
// The engine — provider transport composed from a baseUrl + a descriptor
// ---------------------------------------------------------------------------

export type EngineTransport = {
  listTasks: () => Promise<SlicerCliTaskSummary[]>;
  getTaskSpec: (taskId: string) => Promise<TaskSpecEnvelope>;
  runTask: (
    taskId: string,
    values: Record<string, ProcessingValue>
  ) => Promise<ProcessingJobRef>;
  getJob: (jobId: string) => Promise<ProcessingJobStatus>;
  getResults: (jobId: string) => Promise<ProcessingResult[]>;
};

export const createEngineTransport = (
  baseUrl: string,
  descriptor: TransportDescriptor
): EngineTransport => {
  const { endpoints, format } = descriptor;
  return {
    listTasks: async () =>
      format.parseTasks(await requestJson(endpoints.listTasks(baseUrl))),

    getTaskSpec: async (taskId) =>
      format.parseSpec(await requestJson(endpoints.taskSpec(baseUrl, taskId))),

    runTask: async (taskId, values) => {
      // Lifecycle axis is read here, not hardcoded. Only `poll` is built in v1;
      // any other lifecycle fails closed rather than silently mis-driving a job.
      if (descriptor.lifecycle !== 'poll') {
        throw new Error(
          `Unsupported transport lifecycle: ${descriptor.lifecycle}`
        );
      }
      const raw = await requestJson(
        endpoints.runTask(baseUrl, taskId),
        descriptor.buildRunRequest(values)
      );
      return format.parseRunResponse(raw);
    },

    getJob: async (jobId) =>
      format.parseStatus(
        jobId,
        await requestJson(endpoints.jobStatus(baseUrl, jobId))
      ),

    getResults: async (jobId) =>
      format.parseResults(
        await requestJson(endpoints.jobResults(baseUrl, jobId))
      ),
  };
};
