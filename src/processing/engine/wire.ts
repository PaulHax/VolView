// ---------------------------------------------------------------------------
// Engine wire validation (contract Seam 2/3).
//
// The engine speaks HTTP to an untrusted facade: every job status, job ref, and
// result list arrives as wire JSON. Before this module those payloads were
// `fetchJson<T>` casts straight to typed shapes, so an unknown/missing `state`
// (or a born-terminal ref carrying a garbage status) slipped past the type
// system and made the poller (`store/providers.ts`) loop forever — never
// terminal, never error. This module validates each payload with zod and
// converts an unparseable status into a *terminal error* status so the lifecycle
// stops instead of spinning.
//
// These are the neutral result-format validators the default transport
// descriptor delegates to — not backend-specific parsing. A second backend
// supplies its own `TransportFormat` without touching this module.
//
// Layering note: semantic bounds on result segment descriptors (label index,
// RGBA range) intentionally live downstream at the intent boundary
// (`resultToIntent`), not here. The wire schema validates *structure* only so a
// single out-of-range descriptor cannot reject a whole result list and drop an
// otherwise-valid base image.
//
// Pure module: zod schemas + parse helpers only, no fetch and no store access.
//
// House rules: functional style; `type`, not `interface`.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import {
  neutralJobHandleSchema,
  neutralJobStatusSchema,
  segmentDescriptorSchema as contractSegmentDescriptorSchema,
  type NeutralJobHandle,
} from '@/processing-contract';
import type {
  ProcessingJobRef,
  ProcessingJobStatus,
  JobResultsBundle,
} from '@/src/processing/types';

// ---------------------------------------------------------------------------
// Schemas
//
// These are DERIVED from the contract's canonical objects (the ONE normative
// definition, `processing-contract/wire.ts`) — extended/loosened rather than
// re-declared — so the client's wire layer cannot drift from the contract
// (dedupe, review §5.4). `passthrough()` keeps unknown keys so a valid payload
// round-trips byte-identically — the happy path must not change shape.
// ---------------------------------------------------------------------------

// Derived from the contract's `neutralJobStatusSchema`: the engine tightens only
// `jobId` (a usable id is mandatory at the trust boundary — nothing can be tracked
// or completion-keyed without it; the contract leaves it a plain producer-side
// string), inheriting `state`/`progress`/`errorTail` unchanged. `satisfies` pins
// the schema to the core type (same idiom as `config.ts`) so the two cannot drift.
// `resultSchema` below cannot adopt it — its `.nullish()`/`.transform()` widen the
// inferred type past `ProcessingResult` — which is why only the status schema
// carries the guard.
const jobStatusSchema = neutralJobStatusSchema
  .extend({
    jobId: z.string().min(1),
  })
  .passthrough() satisfies z.ZodType<ProcessingJobStatus>;

// Derived from the contract's `segmentDescriptorSchema`, keeping `name`/`visible`
// but LOOSENING the semantic bounds: the contract enforces `value >= 1` and RGBA
// `0-255`, whereas the engine wire layer validates STRUCTURE only (plain numbers),
// deferring those bounds downstream to `resultToIntent` so a single out-of-range
// descriptor cannot reject a whole result list and drop an otherwise-valid image.
const segmentDescriptorSchema = contractSegmentDescriptorSchema
  .extend({
    value: z.number(),
    color: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  })
  .passthrough();

const resultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    intent: z.string().optional(),
    // The facade emits these straight from `fileDoc.get(...)`, which is JSON
    // `null` when the file doc lacks the key (e.g. an asset-store import with no
    // mimeType). Plain `.optional()` rejects `null` and would throw the whole
    // result list away (fireCompletion drops every result on a parse failure),
    // so a single null mimeType could silently load nothing. Accept null and
    // normalize it to absent so the output still matches `ProcessingResult`.
    mimeType: z
      .string()
      .nullish()
      .transform((v) => v ?? undefined),
    size: z
      .number()
      .nullish()
      .transform((v) => v ?? undefined),
    segments: z.array(segmentDescriptorSchema).optional(),
  })
  .passthrough();

// The result-read envelope (contract Seam 3 `jobResultsSchema`, Chunk 28):
// `intents` are the facade's result items (each enriched with the id/name/url the
// JobList needs), `missing` counts recorded outputs the facade could not resolve.
// `missing` is optional (an omitting facade is backward-compatible; normalized to
// 0 below). The prior bare-list acceptance is RETIRED — the facade always ships
// the envelope and both repos are local, so no compatibility window is required.
const jobResultsEnvelopeSchema = z.object({
  intents: z.array(resultSchema),
  missing: z.number().int().nonnegative().optional(),
});

// The job ref envelope: a usable job id is mandatory (nothing can be tracked
// without it); the optional initial status is validated separately so a
// malformed born-terminal status becomes a terminal error instead of failing
// the whole ref.
const jobRefEnvelopeSchema = z.object({
  jobId: z.string().min(1),
  status: z.unknown().optional(),
});

// The staging response (contract Seam 1, client-created labelmap inputs): the
// facade mints `{ uris }` for the bytes the client POSTed. At least one URI is
// mandatory — the client CONSTRUCTS no URI, so an empty/malformed response must
// fail closed rather than mint a labelmap value with no provenance.
const stageResponseSchema = z.object({
  uris: z.array(z.string()).min(1),
});

// Tier-2 cold-reload re-discovery (contract Seam 3; Chunk 19): the facade's
// `listRecentJobs` returns `NeutralJobHandle[]`, validated with the SAME
// canonical schema the golden fixture pins. The client never sees the Girder
// route, the JobStatus enum, or a file id — just the neutral handle.
const jobHandlesSchema = z.array(neutralJobHandleSchema);

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

const formatIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');

// Validate a wire job status. A valid payload round-trips unchanged; an invalid
// one becomes a *terminal* error status (keyed to the requested `jobId`) so the
// poller stops instead of looping forever on an unknown state.
export const parseJobStatus = (
  jobId: string,
  raw: unknown
): ProcessingJobStatus => {
  const parsed = jobStatusSchema.safeParse(raw);
  // Pin the status to the *requested* jobId on both branches. The store keys
  // its job map and submitted-context lookup off `status.jobId`, so a provider
  // that echoed a different id would record the job under the wrong key (UI
  // never sees the terminal state, result auto-attach context is lost). The
  // error branch already does this; the success branch must match.
  if (parsed.success) return { ...parsed.data, jobId };
  return {
    jobId,
    state: 'error',
    errorTail: `Malformed job status from provider: ${formatIssues(parsed.error)}`,
  };
};

// Validate a wire job ref. The job id must parse (otherwise nothing can be
// tracked — throw). A present-but-malformed initial status is routed through
// `parseJobStatus`, so a garbage born-terminal status surfaces as a terminal
// error rather than an infinite poll.
export const parseJobRef = (raw: unknown): ProcessingJobRef => {
  const parsed = jobRefEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Malformed job ref from provider: ${formatIssues(parsed.error)}`
    );
  }
  const { jobId, status } = parsed.data;
  return status === undefined
    ? { jobId }
    : { jobId, status: parseJobStatus(jobId, status) };
};

// Validate a wire result-read envelope into the neutral `{results, missing}`
// bundle (contract Seam 3, Chunk 28). There is no poll to redirect here, so a
// malformed payload throws; the store's completion path already catches it,
// logs, and notifies subscribers with no results. An absent `missing` normalizes
// to 0 (a facade that omits the count stays backward-compatible).
export const parseResults = (raw: unknown): JobResultsBundle => {
  const parsed = jobResultsEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Malformed job results from provider: ${formatIssues(parsed.error)}`
    );
  }
  return { results: parsed.data.intents, missing: parsed.data.missing ?? 0 };
};

// Validate a staging response into the facade-minted URIs. A malformed/empty
// response throws so the caller never mints a `{ type:"labelmap", uris }` value
// with no provenance (contract Seam 1 "the client constructs no URI").
export const parseStageResponse = (raw: unknown): string[] => {
  const parsed = stageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Malformed staging response from provider: ${formatIssues(parsed.error)}`
    );
  }
  return parsed.data.uris;
};

// Validate a wire `NeutralJobHandle[]` (contract Seam 3 tier-2; Chunk 19). A
// malformed listing throws so re-discovery fails loud rather than re-attaching
// against a garbage handle; the store treats any listing failure as "no tier-2"
// and degrades to tier-1 (a re-discovery failure is never fatal to the session).
export const parseJobHandles = (raw: unknown): NeutralJobHandle[] => {
  const parsed = jobHandlesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Malformed job handles from provider: ${formatIssues(parsed.error)}`
    );
  }
  return parsed.data;
};
