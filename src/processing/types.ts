// ---------------------------------------------------------------------------
// Provider contract — VolView core consumes these types only.
//
// All adapter-specific code lives under `processing/adapters/<protocol>/`.
// Core VolView must never import from an adapter package.
// ---------------------------------------------------------------------------

export type ProcessingProtocol = 'slicer-cli';

export type ProcessingProviderConfig = {
  id: string;
  label: string;
  protocol: ProcessingProtocol;
  baseUrl: string;
  auth?: 'same-origin' | 'bearer' | 'tokenUrl';
  context?: ProcessingContext;
};

export type ProcessingProvider = {
  config: ProcessingProviderConfig;

  listTasks: (context: ProcessingContext) => Promise<SlicerCliTaskSummary[]>;
  getTaskXml: (taskId: string) => Promise<string>;
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
};

export type SlicerCliTaskSummary = {
  id: string;
  title: string;
  description?: string;
  dockerImage?: string;
  category?: string[];
};

export type ProcessingContext = {
  activeDatasetId?: string;
  activeSourceRef?: SourceRef;
  loadedSources: LoadedProcessingSource[];
  cropLpsBounds?: LpsBounds;
};

export type LoadedProcessingSource = {
  datasetId: string;
  name: string;
  uri?: string;
  sourceRef?: SourceRef;
};

export type LpsBounds = {
  Sagittal: [number, number];
  Coronal: [number, number];
  Axial: [number, number];
};

// Branded opaque handle. VolView passes it back to the provider verbatim;
// the provider resolves it to backend ids server-side. Core VolView never
// parses or constructs one — only the slicer-cli adapter does.
export type SourceRef = string & { readonly __brand: 'SourceRef' };

export type ProcessingValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | SourceRef
  | ProcessingOutputRequest
  | null;

export type ProcessingOutputRequest = {
  name: string;
  folderRef?: SourceRef;
};

export type ProcessingJobStatus = {
  jobId: string;
  state: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
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
  role?: 'base' | 'layer' | 'segmentGroup' | 'state' | 'download';
  /**
   * Provider-supplied result intent (the five-name v1 vocabulary, see
   * `processing/intents`). Emitted additively alongside `role`; the adapter
   * prefers a present, valid intent and falls back to `role` translation
   * otherwise. Typed loosely because it arrives as untrusted wire JSON and is
   * zod-validated at the adapter boundary.
   */
  intent?: string;
  mimeType?: string;
  size?: number;
  /**
   * Provider-supplied segment descriptors. Only meaningful for
   * `role: 'segmentGroup'` results. When present, VolView applies these
   * names/colors to the created segment group instead of auto-generating.
   */
  segments?: ProcessingSegmentDescriptor[];
};

// VolView remembers which dataset / source was active at submission time so
// result outputs auto-attach to the originating dataset.
export type SubmittedJobContext = {
  jobId: string;
  taskId: string;
  providerId: string;
  submittedAt: string;
  activeDatasetId?: string;
  activeSourceRef?: SourceRef;
};
