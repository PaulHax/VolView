// ---------------------------------------------------------------------------
// Neutral wire shapes shared across the three seams (contract Seams 1 & 3, and
// the Seam-2 result-intent vocabulary). Same neutral shapes everywhere: never a
// backend file id, a route, or a Girder `JobStatus` enum.
//
// Two DIFFERENT fail-closed behaviors live here, on purpose:
//   * an unknown task-spec field kind is REJECTED (task-spec.ts, negative
//     fixture) — the client must not silently render a param it can't type;
//   * an unknown result INTENT is ACCEPTED (passthrough) so the applier can
//     degrade it to `download` — every result is a file, so the floor is safe.
//
// House rules: functional style; `type`, not `interface`.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { typeTagSchema } from './task-spec';

// Bump when the intent vocabulary's shape changes so producers and the applier
// can negotiate compatibility.
export const INTENT_VOCABULARY_VERSION = 1;

// ---------------------------------------------------------------------------
// Seam 1 — input value: what the client sends at submit
// ---------------------------------------------------------------------------

// The bound input's value: verbatim provenance URIs plus a SEMANTIC type tag.
// `type`/`format` are an open vocabulary (no closed server enum, D10). `uris`
// are the client's own opaque provenance URIs in sorted slice order (advisory).
export const inputValueSchema = z.object({
  type: typeTagSchema,
  format: z.string().optional(),
  uris: z.array(z.string()),
});

export type InputValue = z.infer<typeof inputValueSchema>;

// ---------------------------------------------------------------------------
// Seam 3 — neutral job status
// ---------------------------------------------------------------------------

// Exactly these five states, named to match what the facade projects and the
// client store consumes at runtime (`pending | running | success | error |
// cancelled`): girder's native job status maps onto these with no translation
// layer, so the producer and the consumer already agree and this canonical
// schema is reconciled TO them (Chunk 12 -> Chunk 23, driver 2026-07-04 — the
// smallest-blast-radius rename; see DECISIONS-LOG). `cancelled` is present day
// one so v1 cancel needs no wire change; the terminal states (`success | error |
// cancelled`) also carry the born-terminal sync fast-path at zero cost (D5).
export const JOB_STATES = [
  'pending',
  'running',
  'success',
  'error',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const jobStateSchema = z.enum(JOB_STATES);

export const neutralJobStatusSchema = z.object({
  jobId: z.string(),
  state: jobStateSchema,
  progress: z.number().optional(),
  errorTail: z.string().optional(),
});

export type NeutralJobStatus = z.infer<typeof neutralJobStatusSchema>;

// ---------------------------------------------------------------------------
// Seam 2 — result-intent vocabulary
// ---------------------------------------------------------------------------

// The exactly-five v1 intents (D3, option (a); `add-segment-group` was
// `attach-segment-group` until 2026-07-03). Annotation intents stay backlog.
export const RESULT_INTENTS = [
  'add-base-image',
  'add-layer',
  'add-segment-group',
  'restore-state',
  'download',
] as const;
export type ResultIntentName = (typeof RESULT_INTENTS)[number];

export const isKnownIntent = (intent: string): intent is ResultIntentName =>
  (RESULT_INTENTS as readonly string[]).includes(intent);

// Provenance tag stamped on an applied segment group: the tier-2 scene-state
// idempotency key (Chunk 19). Structurally identical to the `source?` field on
// `SegmentGroupMetadata` so it round-trips the `.volview.zip`.
export const resultSourceSchema = z.object({
  jobId: z.string(),
  outputId: z.string(),
});
export type ResultSource = z.infer<typeof resultSourceSchema>;

// A single RGBA channel: an integer in [0, 255].
const colorChannel = z.number().int().min(0).max(255);

// A segment descriptor: `value` is a label index >= 1 (0 is reserved
// background), `color` is RGBA 0-255.
export const segmentDescriptorSchema = z.object({
  value: z.number().int().min(1),
  name: z.string(),
  color: z.tuple([colorChannel, colorChannel, colorChannel, colorChannel]),
  visible: z.boolean().optional(),
});
export type SegmentDescriptor = z.infer<typeof segmentDescriptorSchema>;

// Every intent references the produced result file by URL and display name.
const resultFile = {
  url: z.string(),
  name: z.string(),
};

const addBaseImage = z.object({
  intent: z.literal('add-base-image'),
  ...resultFile,
});

const addLayer = z.object({
  intent: z.literal('add-layer'),
  ...resultFile,
});

// `add-segment-group` carries OPTIONAL `segments` (the bare-labelmap +
// labels-sidecar case; a `seg.nrrd` with embedded metadata carries none — the
// client uses `segments` when present, else the file's own metadata) and an
// optional `source` provenance tag (the tier-2 idempotency key).
const addSegmentGroup = z.object({
  intent: z.literal('add-segment-group'),
  ...resultFile,
  segments: z.array(segmentDescriptorSchema).optional(),
  source: resultSourceSchema.optional(),
});

const restoreState = z.object({
  intent: z.literal('restore-state'),
  ...resultFile,
});

const download = z.object({
  intent: z.literal('download'),
  ...resultFile,
});

// The STRICT half of the vocabulary: exactly the five v1 intents, each with its
// declared shape. Exported so the single applier can gate on which union member
// strictly matched — a name-known-but-shape-invalid result (e.g. a broken
// `segments`) fails here and must degrade to `download` exactly like an unknown
// name, rather than being applied as if it were a valid segment group.
export const knownResultIntentSchema = z.discriminatedUnion('intent', [
  addBaseImage,
  addLayer,
  addSegmentGroup,
  restoreState,
  download,
]);

export type KnownResultIntent = z.infer<typeof knownResultIntentSchema>;

// The fail-OPEN branch: an intent name outside the v1 vocabulary still parses
// (as long as it references a file), so the applier degrades it to `download`
// rather than the whole result being rejected. `.catchall` keeps any extra
// producer fields for the applier to inspect.
const unknownIntent = z
  .object({
    intent: z.string(),
    ...resultFile,
  })
  .catchall(z.unknown());

export const resultIntentSchema = z.union([
  knownResultIntentSchema,
  unknownIntent,
]);

export type ResultIntent = z.infer<typeof resultIntentSchema>;

// ---------------------------------------------------------------------------
// Seam 3 — tier-2 durability
// ---------------------------------------------------------------------------

// A re-discovered job from a previous page life (`listRecentJobs`, Chunk 19).
// The `inputUris` re-associate results to the reloaded scene by matching the
// client's own provenance (Seam 1), never a backend id; `finishedAt` is the
// neutral terminal instant (server clock, ISO 8601) — the session-watermark
// comparand (`finishedAt > sessionSavedAt`, D5).
export const neutralJobHandleSchema = z.object({
  jobId: z.string(),
  taskId: z.string(),
  inputUris: z.array(z.string()),
  finishedAt: z.string(),
  // OPTIONAL neutral projected state (Chunk 27, tier-2 reload economy). When the
  // facade stamps it, the client re-discovering a TERMINAL-NON-SUCCESS handle
  // (`error`/`cancelled`) records the terminal status straight off the handle,
  // skipping the `getJob` round-trip (a non-success terminal has no results to
  // apply anyway — result reads gate on terminal success). Genuinely additive:
  // ABSENT `state` is a pre-upgrade facade, and the client falls back to its
  // unchanged `getJob`-based path — so both sides stay compatible. Neutral
  // (`jobStateSchema`), never a backend `JobStatus` enum.
  state: jobStateSchema.optional(),
});

export type NeutralJobHandle = z.infer<typeof neutralJobHandleSchema>;

// ---------------------------------------------------------------------------
// Seam 3 — result-read payloads
// ---------------------------------------------------------------------------

// A successful results read: the resolved intents plus a count of outputs the
// facade could not resolve (deleted files, etc.). `missing` is reported rather
// than silently dropped, so "succeeded with no outputs" stays distinguishable
// from "outputs deleted" (D5).
export const jobResultsSchema = z.object({
  intents: z.array(resultIntentSchema),
  missing: z.number().int().nonnegative().optional(),
});
export type JobResults = z.infer<typeof jobResultsSchema>;

// The explicit error the facade returns for a non-succeeded job, so the client
// never mistakes a failed/running read for empty results (D5).
export const jobResultsErrorSchema = z.object({
  error: z.string(),
  state: jobStateSchema.optional(),
});
export type JobResultsError = z.infer<typeof jobResultsErrorSchema>;
