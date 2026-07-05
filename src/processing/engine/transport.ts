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
import type { NeutralJobHandle } from '@/processing-contract';
import type {
  ProcessingJobRef,
  ProcessingJobStatus,
  JobResultsBundle,
  ProcessingValue,
  TaskSummary,
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
  parseTasks: (raw: unknown) => TaskSummary[];
  parseSpec: (raw: unknown) => TaskSpecEnvelope;
  parseRunResponse: (raw: unknown) => ProcessingJobRef;
  parseStatus: (jobId: string, raw: unknown) => ProcessingJobStatus;
  // The result-read envelope (contract Seam 3 `{intents, missing}`, Chunk 28):
  // parses into the neutral `{results, missing}` bundle the store threads through
  // to surface a partial-loss warning.
  parseResults: (raw: unknown) => JobResultsBundle;
  // Optional: validate a staging response into the facade-minted URIs. Paired
  // with the optional `stage` endpoint below (see `stageInput`).
  parseStageResponse?: (raw: unknown) => string[];
  // Optional: validate a tier-2 `listRecentJobs` response into NeutralJobHandle[]
  // (contract Seam 3; Chunk 19). Paired with the optional `listRecentJobs`
  // endpoint below — a backend with no durable job enumeration (MONAI `/infer`)
  // supplies neither, and the engine degrades to tier-1.
  parseJobHandles?: (raw: unknown) => NeutralJobHandle[];
};

export type TransportDescriptor = {
  // Endpoint templates — where each call goes, given the provider baseUrl.
  endpoints: {
    listTasks: (baseUrl: string) => string;
    taskSpec: (baseUrl: string, taskId: string) => string;
    runTask: (baseUrl: string, taskId: string) => string;
    jobStatus: (baseUrl: string, jobId: string) => string;
    jobResults: (baseUrl: string, jobId: string) => string;
    // Optional cancel endpoint (contract Seam 3, best-effort job cancel; D5).
    // Present on the neutral facade; a facade-less backend (#2) with no
    // cancellation surface may omit it, and `cancelJob` then fails closed rather
    // than inventing a route. Kept a transport specific so the engine never
    // hardcodes the cancel path.
    cancel?: (baseUrl: string, jobId: string) => string;
    // Optional staging endpoint (contract Seam 1, client-created labelmap
    // inputs): POST client-held bytes, receive facade-minted URIs. Present on
    // the neutral facade; a facade-less backend (MONAI, #2) may omit it, and
    // `stageInput` then fails closed rather than inventing a route.
    stage?: (baseUrl: string) => string;
    // Optional tier-2 re-discovery endpoint (contract Seam 3; Chunk 19, D5):
    // GET the launch-context's recent jobs as NeutralJobHandle[]. This IS the
    // capability flag — durable job enumeration is a real backend capability
    // (Girder yes; MONAI `/infer` ephemeral, no). Present on the neutral facade;
    // absent elsewhere, and the store degrades to tier-1 (in-session replay).
    // Context-scoped (folder-scoped baseUrl), unlike the folder-free job routes.
    listRecentJobs?: (baseUrl: string) => string;
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
  listTasks: () => Promise<TaskSummary[]>;
  getTaskSpec: (taskId: string) => Promise<TaskSpecEnvelope>;
  runTask: (
    taskId: string,
    values: Record<string, ProcessingValue>
  ) => Promise<ProcessingJobRef>;
  getJob: (jobId: string) => Promise<ProcessingJobStatus>;
  getResults: (jobId: string) => Promise<JobResultsBundle>;
  // Best-effort cancel (contract Seam 3; D5). POSTs to the descriptor's cancel
  // endpoint and validates the projected status back through the same neutral
  // status parser as polling. Fails closed if the descriptor advertises no
  // cancel endpoint.
  cancelJob: (jobId: string) => Promise<ProcessingJobStatus>;
  // Stage client-held bytes as a transient input, returning the facade-minted
  // URIs (contract Seam 1). Fails closed if the descriptor advertises no
  // staging endpoint. The bytes ride as the request body (a `Blob`, so the
  // browser sets Content-Length); the optional `name` is recorded for the
  // staged file.
  stageInput: (body: Blob, name?: string) => Promise<string[]>;
  // Tier-2 cold-reload re-discovery (contract Seam 3; Chunk 19). Present ONLY
  // when the descriptor advertises the capability (endpoint + parser) — its
  // presence IS the capability flag the store reads to decide tier-2-vs-tier-1.
  // A backend without durable enumeration omits it entirely (not a throwing
  // stub), so the store degrades cleanly rather than catching an exception.
  listRecentJobs?: () => Promise<NeutralJobHandle[]>;
};

export const createEngineTransport = (
  baseUrl: string,
  descriptor: TransportDescriptor
): EngineTransport => {
  const { endpoints, format } = descriptor;
  // Tier-2 is capability-gated: the method exists ONLY when the descriptor
  // advertises both the endpoint and the parser (Chunk 19, D5). The store reads
  // its presence to choose tier-2 vs tier-1 — no throwing stub to catch.
  const listRecentJobsEndpoint = endpoints.listRecentJobs;
  const parseJobHandles = format.parseJobHandles;
  const listRecentJobs =
    listRecentJobsEndpoint && parseJobHandles
      ? async () =>
          parseJobHandles(await requestJson(listRecentJobsEndpoint(baseUrl)))
      : undefined;
  return {
    ...(listRecentJobs ? { listRecentJobs } : {}),
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

    cancelJob: async (jobId) => {
      // Fail closed: cancel is a descriptor capability, not a hardcoded route.
      // A descriptor with no `cancel` endpoint (a backend with no cancellation
      // surface) is refused rather than sent to a guessed URL. The response is
      // the neutral projected status — validated by the SAME parser as polling,
      // so a best-effort backend that already finished honestly reports its real
      // terminal state (never a fabricated `cancelled`).
      const { cancel } = endpoints;
      if (!cancel) {
        throw new Error('This provider does not support cancelling jobs');
      }
      return format.parseStatus(
        jobId,
        await requestJson(cancel(baseUrl, jobId), { method: 'POST' })
      );
    },

    stageInput: async (body, name) => {
      // Fail closed: staging is a descriptor capability, not a hardcoded route.
      // A descriptor with no `stage` endpoint (or no response parser) does not
      // support client-created inputs — refuse rather than guess a URL.
      const { stage } = endpoints;
      if (!stage || !format.parseStageResponse) {
        throw new Error(
          'This provider does not support staging client-created inputs'
        );
      }
      const base = stage(baseUrl);
      const url = name ? `${base}?name=${encodeURIComponent(name)}` : base;
      const raw = await requestJson<unknown>(url, { method: 'POST', body });
      return format.parseStageResponse(raw);
    },
  };
};
