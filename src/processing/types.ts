// ---------------------------------------------------------------------------
// Provider contract — VolView core consumes these types only.
//
// One generic engine speaks to every backend: there is no per-backend adapter
// and no XML parser in the client (contract "one generic client engine, zero
// per-backend client code"). The provider is composed by `engine/provider.ts`
// from the generic transport + the default descriptor.
// ---------------------------------------------------------------------------

// Type-only import (erased at runtime — no import cycle with the engine).
import type { TaskSpecEnvelope } from '@/src/processing/engine/taskSpec';
// The neutral Seam-1 input value the client mints from provenance at submit
// (contract "Seam 1 — inputs"; Chunk 8). `{ type, format?, uris }`.
import type { InputValue, ResultSource } from '@/processing-contract';

export type ProcessingProviderConfig = {
  id: string;
  label: string;
  baseUrl: string;
  context?: ProcessingContext;
};

export type ProcessingProvider = {
  config: ProcessingProviderConfig;

  listTasks: (context: ProcessingContext) => Promise<TaskSummary[]>;
  // Server-emitted, zod-validated task description (contract Seam 2). The engine
  // renders the parameter form from this — it parses no XML at runtime.
  getTaskSpec: (taskId: string) => Promise<TaskSpecEnvelope>;
  getDefaultBindings: (
    taskId: string,
    context: ProcessingContext
  ) => Promise<Record<string, ProcessingValue>>;
  runTask: (
    taskId: string,
    values: Record<string, ProcessingValue>,
    context: ProcessingContext
  ) => Promise<ProcessingJobRef>;
  getJob: (jobId: string) => Promise<ProcessingJobStatus>;
  getResults: (jobId: string) => Promise<ProcessingResult[]>;
  // Best-effort cancel of a tracked job (contract "Seam 3 — job lifecycle"; D5).
  // One neutral engine call: the caller holds no Girder route/id/JobStatus
  // knowledge. Returns the job's projected status after the attempt, but the
  // store's poller — not this return — is what converges the UI on whatever
  // terminal state the backend ultimately reports (a job may finish before the
  // cancel lands, so `cancelled` is never fabricated). Fails closed when the
  // backend advertises no cancel endpoint.
  cancelJob: (jobId: string) => Promise<ProcessingJobStatus>;
  // Stage client-held bytes (a serialized segment group) as a transient input,
  // returning the facade-minted URIs the client round-trips as a
  // `{ type: "labelmap", uris }` value (contract "Seam 1 — inputs"; Chunk 15).
  // Fails closed when the backend advertises no staging endpoint.
  stageInput: (body: Blob, name?: string) => Promise<string[]>;
};

// Advisory display metadata for the task picker (id/title + optional hints).
// The facade emits it; the engine passes it through without a schema.
export type TaskSummary = {
  id: string;
  title: string;
  description?: string;
  dockerImage?: string;
  category?: string[];
};

export type ProcessingContext = {
  activeDatasetId?: string;
  cropLpsBounds?: LpsBounds;
};

export type LpsBounds = {
  Sagittal: [number, number];
  Coronal: [number, number];
  Axial: [number, number];
};

export type ProcessingValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  // Seam-1 input value minted from the bound volume's own DataSource provenance
  // (contract "Seam 1 — inputs"; Chunk 8) — the value a `sourceRef` param carries.
  | InputValue
  | null;

/** Job lifecycle states (closed vocabulary; shared with the wire schema). */
export const JOB_STATES = [
  'pending',
  'running',
  'success',
  'error',
  'cancelled',
] as const;

export type ProcessingJobStatus = {
  jobId: string;
  state: (typeof JOB_STATES)[number];
  progress?: number;
  errorTail?: string;
};

export type ProcessingJobRef = {
  jobId: string;
  /**
   * Optional initial status. The async lifecycle has a synchronous fast-path:
   * a provider's `runTask` may return a job that is already terminal ("born
   * terminal" — e.g. a synchronous `/infer` backend, decisions.md D5). When the
   * status is terminal the store routes it through the same completion path as a
   * polled job (auto-apply hook, JobList rendering) but never registers a
   * poller. When absent the job is treated as `pending` and polled — polling
   * stays the driver for non-terminal jobs, unchanged.
   */
  status?: ProcessingJobStatus;
};

export type ProcessingSegmentDescriptor = {
  value: number;
  name: string;
  /** RGBA, 0-255. */
  color: [number, number, number, number];
  visible?: boolean;
};

export type ProcessingResult = {
  id: string;
  name: string;
  url: string;
  /**
   * Provider-supplied result intent — the neutral v1 vocabulary the single
   * applier applies (contract Seam 2; `processing-contract/wire.ts`). Typed
   * loosely because it arrives as untrusted wire JSON; `resultToIntent`
   * resolves it against the canonical schema and degrades an unknown/invalid
   * one to `download`.
   */
  intent?: string;
  mimeType?: string;
  size?: number;
  /**
   * Provider-supplied segment descriptors. Only meaningful for an
   * `add-segment-group` intent. When present, VolView applies these
   * names/colors to the created segment group instead of auto-generating.
   */
  segments?: ProcessingSegmentDescriptor[];
  /**
   * Provenance tag the facade stamps on an `add-segment-group` result
   * (`{ jobId, outputId }`). The applier threads it onto the created segment
   * group so it round-trips the `.volview.zip` (tier-2 idempotency key, D5 /
   * Chunk 19). Structurally the `source?` field on `SegmentGroupMetadata`.
   */
  source?: ResultSource;
};

// VolView remembers which dataset / source was active at submission time so
// result outputs auto-attach to the originating dataset.
export type SubmittedJobContext = {
  jobId: string;
  taskId: string;
  providerId: string;
  submittedAt: string;
  activeDatasetId?: string;
};
