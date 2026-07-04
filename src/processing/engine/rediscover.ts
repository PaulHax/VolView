// ---------------------------------------------------------------------------
// Tier-2 cold-reload re-discovery — pure decision helpers (contract Seam 3;
// Chunk 19; decisions.md D5).
//
// A reloaded page re-finds its jobs (`listRecentJobs` → NeutralJobHandle[]) and
// auto-re-attaches each terminal result with NO click, reusing the same
// poll → results → intents machinery. Three pure decisions drive that, factored
// out here so they are exhaustively unit-testable without a store or the network:
//
//   1. RE-ASSOCIATION (Seam 1) — which reloaded dataset is a job's base? Matched
//      by the handle's INPUT OPAQUE URIs against the reloaded datasets' own
//      provenance URIs, UNIFORM for every format (a DICOM series and an NRRD
//      alike — no `StudyUID` special case). `source` is NOT the association key.
//   2. SESSION WATERMARK (primary reject-durability + accretion bound) — apply a
//      result IFF `finishedAt > sessionSavedAt`; no restored session → no
//      watermark → attach all (exact MVP parity). Both instants are SERVER clock
//      (no client clock in the comparison). Conservative-failure direction is to
//      ATTACH (resurrect), never silently drop.
//   3. SCENE-STATE IDEMPOTENCY (secondary guard) — apply IFF no segment group
//      with that `source: {jobId, outputId}` tag is already in the scene. Correct
//      where a client seen-set fails (fresh scene → apply; session-restored group
//      already present → skip) and where no watermark travels (a hand-loaded
//      `.volview.zip`).
//
// House rules: functional style; `type`, not `interface`.
// ---------------------------------------------------------------------------

import type { ResultSource } from '@/processing-contract';

// A reloaded dataset offered as a re-attach base: its id + its verbatim
// provenance URIs (from `collectProvenanceUris`, Seam 1).
export type ReattachCandidate = { id: string; uris: string[] };

// Re-associate a job (by its handle's input opaque URIs) to a reloaded dataset.
// A candidate matches when its provenance URIs are a NON-EMPTY subset of the
// job's input URIs (i.e. the dataset was one of the job's inputs); among matches
// the most specific (most URIs matched) wins, so a DICOM base of N slices is
// preferred over an incidental single-file overlap. Uniform for every format —
// there is no branch on DICOM-vs-NRRD. Returns the base dataset id, or
// `undefined` when nothing in the reloaded scene was a job input.
export const reassociateBase = (
  inputUris: readonly string[],
  candidates: readonly ReattachCandidate[]
): string | undefined => {
  const wanted = new Set(inputUris);
  let best: ReattachCandidate | undefined;
  for (const candidate of candidates) {
    if (candidate.uris.length === 0) continue;
    if (!candidate.uris.every((uri) => wanted.has(uri))) continue;
    if (!best || candidate.uris.length > best.uris.length) best = candidate;
  }
  return best?.id;
};

// The session watermark gate (D5). Apply a re-discovered result IFF its job's
// terminal instant is strictly after the restored session's save instant. No
// watermark (no restored session, or a tier-1 context that carries no
// `finishedAt`) → attach. Unparseable instants → attach (the conservative
// direction is resurrection, never silent loss). Both instants are server-clock
// ISO strings compared as UTC instants — no client clock enters the comparison.
export const passesWatermark = (
  finishedAt: string | undefined,
  sessionSavedAt: string | undefined
): boolean => {
  if (!sessionSavedAt) return true; // no restored session → attach all (parity)
  if (!finishedAt) return true; // no terminal instant to compare → never drop
  const finished = Date.parse(finishedAt);
  const saved = Date.parse(sessionSavedAt);
  if (Number.isNaN(finished) || Number.isNaN(saved)) return true;
  return finished > saved;
};

// Whether the scene already holds a segment group produced by this exact
// `{jobId, outputId}` (the Chunk-5 `source` tag round-trips the `.volview.zip`).
// The secondary double-apply guard: a session-restored group carries its source,
// so a re-attach of the same result is skipped; a fresh scene carries none, so it
// applies exactly once. `existing` is every in-scene group's `source` (undefined
// for hand-painted groups, which never match).
export const sourceInScene = (
  existing: ReadonlyArray<ResultSource | undefined>,
  target: ResultSource
): boolean =>
  existing.some(
    (source) =>
      source != null &&
      source.jobId === target.jobId &&
      source.outputId === target.outputId
  );
