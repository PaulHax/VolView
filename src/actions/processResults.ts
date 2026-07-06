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
// Result auto-load (contract Seam 2 results half + D6). Plain image results open
// as new top-level datasets. Segment-group results apply as NORMAL,
// born-persistent groups when the originating parent image still exists.

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
import { useLayersStore } from '@/src/store/datasets-layers';
import { useSegmentGroupStore } from '@/src/store/segmentGroups';
import { useJobResultReviewStore } from '@/src/store/jobResultReview';
import { loadUrls } from './loadUserFiles';

type ResultFile = { url: string; name: string };

type SegmentGroupIntent = Extract<
  KnownResultIntent,
  { intent: 'add-segment-group' }
>;
type BaseImageIntent = Extract<KnownResultIntent, { intent: 'add-base-image' }>;

async function loadAsImport(file: ResultFile) {
  const ds = uriToDataSource(file.url, file.name);
  const importResults = await importDataSources([ds]);
  const loaded = importResults
    .filter((r) => r.type === 'data')
    .filter(isVolumeResult);
  return loaded[0] ? toDataSelection(loaded[0]) : null;
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
 * cold-reload idempotency). Shared by explicit actions and auto-apply.
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

// Returns false when the result file could not be loaded (a null load — 404 /
// corrupt / non-volume), so `applyIntent`'s caller can surface one message for
// this and for a thrown apply failure alike. The auto-load path does not route
// through here, so it stays silent.
async function applySegmentGroup(
  intent: SegmentGroupIntent,
  parentSelection: string
): Promise<boolean> {
  const childSelection = await loadAsImport(intent);
  if (!childSelection) return false;
  await convertAndDescribe(childSelection, parentSelection, intent);
  return true;
}

/**
 * The single result applier: map a declarative intent to the store calls that
 * perform it. `add-layer` / `add-segment-group` need an originating dataset to
 * attach to; with none they fall back to opening the file as a new dataset.
 *
 * Fail closed: an unknown intent name, or a known name whose payload fails the
 * strict schema, applies nothing (the safe `download` floor).
 *
 * Returns `true` when the intent was handled — applied, or an intentional no-op
 * (`download`, the fail-closed floor) — and `false` only when the result file
 * could not be loaded. Explicit callers can turn a `false` return, and any
 * thrown apply error, into a user-facing message; the separate auto-load
 * pipeline does not call this, so it stays silent.
 */
export async function applyIntent(
  intent: ResultIntent,
  context: SubmittedJobContext | undefined
): Promise<boolean> {
  const parentSelection = context?.activeDatasetId;
  // Open the result as a new top-level dataset. Also the fallback when a
  // parent-requiring intent has no originating dataset to attach to.
  const openAsDataset = (file: ResultFile) =>
    loadUrls({ urls: [file.url], names: [file.name] });

  // Gate on the STRICT known-intent member: a name-known-but-shape-invalid
  // result (e.g. broken `segments`) must not be applied as a segment group —
  // it degrades to download exactly like an unknown name.
  const known = knownResultIntentSchema.safeParse(intent);
  if (!known.success) return true; // unknown / invalid -> download floor (no-op, not a failure)
  const resolved = known.data;

  switch (resolved.intent) {
    case 'add-base-image':
    case 'restore-state':
      await openAsDataset(resolved);
      return true;
    case 'download':
      // No store mutation — the file is surfaced as a link in JobList.
      return true;
    case 'add-layer': {
      if (!parentSelection) {
        await openAsDataset(resolved);
        return true;
      }
      const childSelection = await loadAsImport(resolved);
      if (!childSelection) return false;
      await useLayersStore().addLayer(parentSelection, childSelection);
      return true;
    }
    case 'add-segment-group': {
      if (!parentSelection) {
        await openAsDataset(resolved);
        return true;
      }
      return applySegmentGroup(resolved, parentSelection);
    }
    default: {
      // Exhaustive over the five known intents.
      const exhaustive: never = resolved;
      void exhaustive;
      return true;
    }
  }
}

// Auto-applies a labelmap result additively, returning the created group ids.
// It only fails closed when the result cannot be imported or when the existing
// conversion path rejects it.
const autoApplySegmentGroup = async (
  intent: SegmentGroupIntent,
  parentSelection: string
): Promise<string[] | null> => {
  const segmentGroupStore = useSegmentGroupStore();

  // Scene-state idempotency (D5): a result whose `source:{jobId,outputId}` tag is
  // already in the scene (session-restored, or applied earlier this load) is
  // skipped so a reload never duplicates the group.
  if (intent.source) {
    const existing = Object.values(segmentGroupStore.metadataByID).map(
      (meta) => meta.source
    );
    if (sourceInScene(existing, intent.source)) return null;
  }

  const childSelection = await loadAsImport(intent);
  if (!childSelection) return null; // did not decode -> not auto-applied

  return convertAndDescribe(childSelection, parentSelection, intent);
};

async function autoOpenBaseImage(intent: BaseImageIntent): Promise<void> {
  await loadUrls({ urls: [intent.url], names: [intent.name] });
}

/**
 * Auto-actions on job completion. Plain image outputs are opened as new datasets
 * in the Data panel. Labelmap outputs are applied as new segment groups when the
 * originating parent image still exists. Other intents stay in the Jobs list.
 *
 * Born-persistent (D6 in-flight call, 2026-07-04): an auto-applied result is a
 * normal deletable object — NO confirm/reject gate, NO promotion state machine.
 * Preview is the existing visibility toggle; reject is the existing delete UI;
 * the only provisional cue is a live-only "new job result" badge (`markNew`).
 *
 * Tier-2 gating (Chunk 19, D5). The same pipeline serves in-session (tier-1) and
 * cold-reload (tier-2) completions:
 *   - SESSION WATERMARK (primary, per-job) — a job that settled at/before the
 *     restored session's save instant is already a review verdict (present=kept
 *     via the zip, absent=rejected), so it does not re-attach. A tier-1 context
 *     (no `finishedAt`) or no restored session (no `sessionSavedAt`) always
 *     passes = exact MVP parity. Both instants are server-clock.
 *   - SCENE-STATE IDEMPOTENCY (secondary, for segment groups) — a result whose
 *     `source` tag is already in the scene is skipped. A re-discovered labelmap
 *     is therefore born-persistent with NO confirm gate: fresh -> apply once;
 *     already present -> skip.
 */
export async function autoLoadProcessingResults(
  results: ProcessingResult[],
  context: SubmittedJobContext | undefined,
  sessionSavedAt?: string
): Promise<void> {
  // Watermark gate is per-job (all results share the job's terminal instant):
  // behind the watermark → attach none of them.
  if (!passesWatermark(context?.finishedAt, sessionSavedAt)) return;

  const parentSelection = context?.activeDatasetId;
  const review = useJobResultReviewStore();
  for (const result of results) {
    const intent = resultToIntent(result);
    // Fail closed: an unknown/invalid intent degrades to the download floor and
    // never auto-loads (it stays a JobList file).
    const parsed = knownResultIntentSchema.safeParse(intent);
    if (!parsed.success) continue;
    try {
      switch (parsed.data.intent) {
        case 'add-base-image':
          await autoOpenBaseImage(parsed.data);
          break;
        case 'add-segment-group': {
          if (!parentSelection) break;
          const created = await autoApplySegmentGroup(
            parsed.data,
            parentSelection
          );
          // Present each created object born-persistent: a normal group (visible by
          // default like any segment group) flagged with the live-only badge. No
          // confirm/reject step — deletability is the whole safety story.
          created?.forEach((id) => review.markNew(id));
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error('Failed to auto-load processing result', result, err);
    }
  }
}
