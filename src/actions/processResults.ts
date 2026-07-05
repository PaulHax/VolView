// Apply the declarative result intents produced by a finished provider job.
//
// Results cross the wire as a declarative `ResultIntent` the server emits
// (contract Seam 2; decisions.md D3/D4) — never a store-method name, never a
// closed `role` enum. A single client-side applier maps each intent to the
// store calls that perform it. The producer names no client method; the intent
// vocabulary is the whole contract.
//
// Additive-only (D4): every intent creates NEW objects — it never mutates or
// overwrites a user-editable one. `add-segment-group` adds a new segment group
// (through the same state-file restore path VolView session-restore uses:
// `convertImageToLabelmap` -> `addLabelmap`), `add-layer`/`add-base-image` add
// new datasets/layers.
//
// Fail closed (contract Seam 2): an unknown intent name — or a known name whose
// payload is shape-invalid — degrades to `download` (no store mutation); every
// result is a file, so the download floor is always safe.
//
// Intent -> store call:
//   `add-base-image`     -> loadUrls (new top-level dataset)
//   `add-layer`          -> useLayersStore.addLayer (new layer)
//   `add-segment-group`  -> convertImageToLabelmap (new segment group) + descriptors
//   `restore-state`      -> loadUrls (no dedicated session restore yet)
//   `download`           -> no store mutation; surfaced as a link in JobList
//   <unknown/invalid>    -> download floor
//
// Result REVIEW (Chunk 22; contract Seam 2 results half + D6). A validated
// segment-group result AUTO-SHOWS: it applies as a NORMAL, born-persistent group
// (no confirm/reject state machine) governed by the existing visibility/delete
// UI, and is flagged with a cosmetic live-only "new job result" badge. Auto-show
// is gated by a corroboration guard (decode / non-empty / segments resolve /
// overlaps the parent); a result that fails the guard is NOT auto-shown and stays
// available via the explicit JobList path as a downloadable/loadable file. The
// auto-show pipeline is intent-kind-agnostic (a per-kind reviewer table), so the
// deferred vector intents inherit the identical review behavior when they land.

import vtkBoundingBox from '@kitware/vtk.js/Common/DataModel/BoundingBox';
import {
  knownResultIntentSchema,
  type ResultIntent,
  type KnownResultIntent,
  type SegmentDescriptor,
} from '@/processing-contract';
import type {
  ProcessingResult,
  SubmittedJobContext,
} from '@/src/processing/types';
import { resultToIntent } from '@/src/processing/engine';
import {
  passesWatermark,
  sourceInScene,
} from '@/src/processing/engine/rediscover';
import { uriToDataSource } from '@/src/io/import/dataSource';
import {
  importDataSources,
  toDataSelection,
} from '@/src/io/import/importDataSources';
import { isVolumeResult } from '@/src/io/import/common';
import { getImage } from '@/src/utils/dataSelection';
import { useLayersStore } from '@/src/store/datasets-layers';
import { useSegmentGroupStore } from '@/src/store/segmentGroups';
import { useMessageStore } from '@/src/store/messages';
import { useJobResultReviewStore } from '@/src/store/jobResultReview';
import { loadUrls } from './loadUserFiles';

type ResultFile = { url: string; name: string };

type SegmentGroupIntent = Extract<
  KnownResultIntent,
  { intent: 'add-segment-group' }
>;

async function loadAsImport(file: ResultFile) {
  const ds = uriToDataSource(file.url, file.name);
  const importResults = await importDataSources([ds]);
  const loaded = importResults
    .filter((r) => r.type === 'data')
    .filter(isVolumeResult);
  return loaded[0] ? toDataSelection(loaded[0]) : null;
}

// Surface a failed result load on the explicit JobList path (a user CLICK that
// no-ops must say why). `loadAsImport` returns null — never throws — on a 404 /
// corrupt / non-volume file, so JobList's catch never fires; the auto-show path
// stays silent by design.
function reportResultLoadFailed(name: string, kind: string) {
  useMessageStore().addError(`Could not add "${name}" as a ${kind}`, {
    details:
      'The result file could not be loaded — it may be missing, corrupt, or not a volume image.',
  });
}

/**
 * Apply provider-supplied segment descriptors to a specific created group. Run
 * synchronously after `convertImageToLabelmap` resolves (which now awaits its
 * per-component adds, so the id is live).
 */
function applySegmentDescriptors(
  segmentGroupID: string,
  segments: SegmentDescriptor[]
) {
  const segmentGroupStore = useSegmentGroupStore();
  segments.forEach((seg) => {
    try {
      segmentGroupStore.updateSegment(segmentGroupID, seg.value, {
        name: seg.name,
        color: seg.color,
        ...(seg.visible == null ? {} : { visible: seg.visible }),
      });
    } catch (err) {
      // Auto-decoded segment list may not include every value in the
      // labelmap; ignore mismatches.

      console.warn('Failed to apply segment descriptor', seg, err);
    }
  });
}

/**
 * Create a NEW segment group from a loaded child image through the state-file
 * restore path (`convertImageToLabelmap` -> `addLabelmap`) and apply any
 * provider descriptors to the created group(s). Returns the created group id(s).
 *
 * Additive-only: `convertImageToLabelmap` never writes into an existing group,
 * and it threads the `source: {jobId, outputId}` tag through `addLabelmap` so the
 * group round-trips the `.volview.zip` (Chunk 11 stamps it; Chunk 19 reads it for
 * cold-reload idempotency). Shared by the explicit JobList action and auto-show.
 */
async function convertAndDescribe(
  childSelection: string,
  parentSelection: string,
  intent: SegmentGroupIntent
): Promise<string[]> {
  const segmentGroupStore = useSegmentGroupStore();
  const ids = await segmentGroupStore.convertImageToLabelmap(
    childSelection,
    parentSelection,
    intent.source
  );
  // `segments` (folded labels sidecar) is optional; a seg.nrrd with embedded
  // metadata carries none and the group keeps its own decoded segments.
  if (intent.segments?.length) {
    ids.forEach((id) => applySegmentDescriptors(id, intent.segments!));
  }
  return ids;
}

async function applySegmentGroup(
  intent: SegmentGroupIntent,
  parentSelection: string
) {
  const childSelection = await loadAsImport(intent);
  if (!childSelection) {
    reportResultLoadFailed(intent.name, 'segment group');
    return;
  }
  await convertAndDescribe(childSelection, parentSelection, intent);
}

/**
 * The single result applier: map a declarative intent to the store calls that
 * perform it. `add-layer` / `add-segment-group` need an originating dataset to
 * attach to; with none they fall back to opening the file as a new dataset.
 *
 * Fail closed: an unknown intent name, or a known name whose payload fails the
 * strict schema, applies nothing (the safe `download` floor).
 */
export async function applyIntent(
  intent: ResultIntent,
  context: SubmittedJobContext | undefined
): Promise<void> {
  const parentSelection = context?.activeDatasetId;
  // Open the result as a new top-level dataset. Also the fallback when a
  // parent-requiring intent has no originating dataset to attach to.
  const openAsDataset = (file: ResultFile) =>
    loadUrls({ urls: [file.url], names: [file.name] });

  // Gate on the STRICT known-intent member: a name-known-but-shape-invalid
  // result (e.g. broken `segments`) must not be applied as a segment group —
  // it degrades to download exactly like an unknown name.
  const known = knownResultIntentSchema.safeParse(intent);
  if (!known.success) return; // unknown / invalid -> download floor (no-op)
  const resolved = known.data;

  switch (resolved.intent) {
    case 'add-base-image':
    case 'restore-state':
      await openAsDataset(resolved);
      return;
    case 'download':
      // No store mutation — the file is surfaced as a link in JobList.
      return;
    case 'add-layer': {
      if (!parentSelection) {
        await openAsDataset(resolved);
        return;
      }
      const childSelection = await loadAsImport(resolved);
      if (!childSelection) {
        reportResultLoadFailed(resolved.name, 'layer');
        return;
      }
      await useLayersStore().addLayer(parentSelection, childSelection);
      return;
    }
    case 'add-segment-group': {
      if (!parentSelection) {
        await openAsDataset(resolved);
        return;
      }
      await applySegmentGroup(resolved, parentSelection);
      return;
    }
    default: {
      // Exhaustive over the five known intents.
      const exhaustive: never = resolved;
      void exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-show review pipeline (Chunk 22; contract Seam 2 results half + D6)
//
// A shared, intent-kind-agnostic pipeline: for each result the loop resolves the
// intent, dispatches to a per-kind REVIEWER that CORROBORATES then APPLIES the
// result additively (returning the created object id(s), or null when it is not
// auto-shown), and then PRESENTS the created objects (born-persistent: a normal
// deletable object made visible + a cosmetic live-only badge). Only
// `add-segment-group` has a reviewer in v1; the deferred vector intents
// (add-polygon / add-ruler / add-rectangle) register a reviewer of the SAME shape
// and inherit the identical behavior — no labelmap-specific branching leaks into
// the loop.
// ---------------------------------------------------------------------------

/**
 * Corroboration guard for a loaded result labelmap before AUTO-SHOW (fail closed;
 * contract Seam 2 "a validated result auto-applies"; decisions.md D6). A result
 * that fails here is NOT auto-shown — it stays available via the explicit JobList
 * path as a downloadable/loadable file. Checks:
 *   - decodes — the file imported to a volume whose scalars we can read;
 *   - non-empty / segments resolve — at least one labelled voxel (max scalar
 *     >= 1); an all-background labelmap yields no segment and is not shown;
 *   - overlaps — the labelmap intersects the parent in physical space,
 *     pre-empting `convertImageToLabelmap`'s own non-intersecting-bounds throw.
 */
function corroborateLabelmap(
  childSelection: string,
  parentSelection: string
): boolean {
  const childImage = getImage(childSelection);
  const parentImage = getImage(parentSelection);
  if (!childImage || !parentImage) return false; // did not decode
  const scalars = childImage.getPointData().getScalars();
  if (!scalars) return false;
  const [, max] = scalars.getRange();
  if (!(max >= 1)) return false; // empty labelmap: no segment resolves
  return vtkBoundingBox.intersects(
    parentImage.getBounds(),
    childImage.getBounds()
  );
}

// A per-intent-kind auto-show reviewer: corroborate the result, then apply it
// additively, returning the created object id(s) — or null when it is not
// auto-shown (deduped, undecodable, or failed corroboration). Vector intents add
// a reviewer of this shape to inherit the shared present/watermark handling.
type AutoShowReviewer = (
  intent: KnownResultIntent,
  parentSelection: string
) => Promise<string[] | null>;

const reviewSegmentGroup: AutoShowReviewer = async (
  intent,
  parentSelection
) => {
  // Reviewer only runs for the add-segment-group member (see `reviewerFor`).
  const segIntent = intent as SegmentGroupIntent;
  const segmentGroupStore = useSegmentGroupStore();

  // Scene-state idempotency (D5): a result whose `source:{jobId,outputId}` tag is
  // already in the scene (session-restored, or applied earlier this load) is
  // skipped so a reload never duplicates the group.
  if (segIntent.source) {
    const existing = Object.values(segmentGroupStore.metadataByID).map(
      (meta) => meta.source
    );
    if (sourceInScene(existing, segIntent.source)) return null;
  }

  const childSelection = await loadAsImport(segIntent);
  if (!childSelection) return null; // did not decode -> not auto-shown
  if (!corroborateLabelmap(childSelection, parentSelection)) return null;

  return convertAndDescribe(childSelection, parentSelection, segIntent);
};

// The reviewer table. Adding a kind here is the whole cost of making a new intent
// auto-show with the identical corroborate -> apply -> present behavior.
function reviewerFor(intent: KnownResultIntent): AutoShowReviewer | null {
  switch (intent.intent) {
    case 'add-segment-group':
      return reviewSegmentGroup;
    // Deferred (WORKORDER #5): add-polygon / add-ruler / add-rectangle register
    // their reviewers here and inherit the shared pipeline unchanged.
    default:
      // Not auto-shown in v1 — base image / layer / restore-state / download wait
      // for an explicit JobList action so we never clobber the current view.
      return null;
  }
}

/**
 * Auto-actions on job completion. Conservative for v1 (decisions.md D6): only a
 * corroborated segment group auto-shows — as a NEW, born-persistent group, and
 * only when there is an originating dataset to attach to; every other intent
 * waits for an explicit JobList click.
 *
 * Born-persistent (D6 in-flight call, 2026-07-04): an auto-shown result is a
 * normal deletable object — NO confirm/reject gate, NO promotion state machine.
 * Preview is the existing visibility toggle; reject is the existing delete UI;
 * the only provisional cue is a live-only "new job result" badge (`markNew`).
 *
 * Tier-2 gating (Chunk 19, D5). The SAME pipeline serves in-session (tier-1) and
 * cold-reload (tier-2) completions:
 *   - SESSION WATERMARK (primary, per-job) — a job that settled at/before the
 *     restored session's save instant is already a review verdict (present=kept
 *     via the zip, absent=rejected), so it does not re-attach. A tier-1 context
 *     (no `finishedAt`) or no restored session (no `sessionSavedAt`) always
 *     passes = exact MVP parity. Both instants are server-clock.
 *   - SCENE-STATE IDEMPOTENCY (secondary, in the reviewer) — a result whose
 *     `source` tag is already in the scene is skipped. A re-discovered result is
 *     therefore born-persistent with NO confirm gate: fresh -> apply once;
 *     already present -> skip.
 */
export async function autoLoadProcessingResults(
  results: ProcessingResult[],
  context: SubmittedJobContext | undefined,
  sessionSavedAt?: string
): Promise<void> {
  const parentSelection = context?.activeDatasetId;
  if (!parentSelection) return;

  // Watermark gate is per-job (all results share the job's terminal instant):
  // behind the watermark → attach none of them.
  if (!passesWatermark(context?.finishedAt, sessionSavedAt)) return;

  const review = useJobResultReviewStore();
  for (const result of results) {
    const intent = resultToIntent(result);
    // Fail closed: an unknown/invalid intent degrades to the download floor and
    // never auto-shows (it stays a JobList file).
    const parsed = knownResultIntentSchema.safeParse(intent);
    if (!parsed.success) continue;
    const reviewer = reviewerFor(parsed.data);
    if (!reviewer) continue;
    try {
      const created = await reviewer(parsed.data, parentSelection);
      // Present each created object born-persistent: a normal group (visible by
      // default like any segment group) flagged with the live-only badge. No
      // confirm/reject step — deletability is the whole safety story.
      created?.forEach((id) => review.markNew(id));
    } catch (err) {
      console.error('Failed to auto-load segment group result', result, err);
    }
  }
}
