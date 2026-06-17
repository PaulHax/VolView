// ---------------------------------------------------------------------------
// slicer-cli wire validation (item 4.3).
//
// The adapter speaks HTTP to an untrusted facade: every job status, job ref,
// and result list arrives as wire JSON. Before this module those payloads were
// `fetchJson<T>` casts straight to typed shapes, so an unknown/missing
// `state` (or a born-terminal ref carrying a garbage status) slipped past the
// type system and made the poller (`store/providers.ts`) loop forever — never
// terminal, never error. This module validates each payload with zod (mirroring
// the rigor `intents.ts` applies to result intents) and converts an
// unparseable status into a *terminal error* status so the lifecycle stops
// instead of spinning.
//
// Layering note: semantic bounds on result segment descriptors (label index,
// RGBA range) intentionally live downstream at the intent boundary
// (`intents.ts`), not here. The wire schema validates *structure* only so a
// single out-of-range descriptor cannot reject a whole result list and drop an
// otherwise-valid base image.
//
// Pure module: zod schemas + parse helpers only, no fetch and no store access.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type {
  ProcessingJobRef,
  ProcessingJobStatus,
  ProcessingResult,
} from '@/src/processing/types';

// ---------------------------------------------------------------------------
// Schemas
//
// `passthrough()` keeps unknown keys so a valid payload round-trips
// byte-identically — the happy path must not change shape.
// ---------------------------------------------------------------------------

const jobState = z.enum([
  'pending',
  'running',
  'success',
  'error',
  'cancelled',
]);

// `satisfies` pins the schema to the core type (same idiom as
// `intents.ts`/`config.ts`) so the two cannot drift. `resultSchema` below
// cannot adopt it — its `.catch()`/`.nullish()` widen the inferred type past
// `ProcessingResult` — which is why only the status schema carries the guard.
const jobStatusSchema = z
  .object({
    // A usable job id is mandatory, same as the ref envelope below — nothing
    // can be tracked or completion-keyed without it.
    jobId: z.string().min(1),
    state: jobState,
    progress: z.number().optional(),
    errorTail: z.string().optional(),
  })
  .passthrough() satisfies z.ZodType<ProcessingJobStatus>;

// Result `role` arrives as an untrusted, additively-extended enum; an
// unrecognized value degrades to `undefined` (the adapter's `resultToIntent`
// then treats it as a base image) rather than rejecting the whole result list.
const resultRole = z
  .enum(['base', 'layer', 'segmentGroup', 'state', 'download'])
  .optional()
  .catch(undefined);

// Structural-only segment descriptor (bounds enforced downstream in
// `intents.ts`): channels and label index are plain numbers here.
const segmentDescriptorSchema = z
  .object({
    value: z.number(),
    name: z.string(),
    color: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    visible: z.boolean().optional(),
  })
  .passthrough();

const resultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    role: resultRole,
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

const resultsSchema = z.array(resultSchema);

// The job ref envelope: a usable job id is mandatory (nothing can be tracked
// without it); the optional initial status is validated separately so a
// malformed born-terminal status becomes a terminal error instead of failing
// the whole ref.
const jobRefEnvelopeSchema = z.object({
  jobId: z.string().min(1),
  status: z.unknown().optional(),
});

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

// Validate a wire result list. There is no poll to redirect here, so a
// malformed payload throws; the store's completion path already catches it,
// logs, and notifies subscribers with no results.
export const parseResults = (raw: unknown): ProcessingResult[] => {
  const parsed = resultsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Malformed job results from provider: ${formatIssues(parsed.error)}`
    );
  }
  return parsed.data;
};
