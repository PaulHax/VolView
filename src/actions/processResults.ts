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

import { storeToRefs } from 'pinia';
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
import { uriToDataSource } from '@/src/io/import/dataSource';
import {
  importDataSources,
  toDataSelection,
} from '@/src/io/import/importDataSources';
import { isVolumeResult } from '@/src/io/import/common';
import { useLayersStore } from '@/src/store/datasets-layers';
import { useSegmentGroupStore } from '@/src/store/segmentGroups';
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

/**
 * Apply provider-supplied segment descriptors to whichever segment group was
 * most recently attached to `parentSelection`. Run synchronously after
 * `convertImageToLabelmap`.
 */
function applySegmentDescriptors(
  parentSelection: string,
  segments: SegmentDescriptor[]
) {
  const segmentGroupStore = useSegmentGroupStore();
  const { orderByParent } = storeToRefs(segmentGroupStore);
  const groupIds = orderByParent.value[parentSelection] ?? [];
  if (groupIds.length === 0) return;
  // The newly-attached group is the most recent entry.
  const segmentGroupID = groupIds[groupIds.length - 1];
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

async function applySegmentGroup(
  intent: SegmentGroupIntent,
  parentSelection: string
) {
  const childSelection = await loadAsImport(intent);
  if (!childSelection) return;
  const segmentGroupStore = useSegmentGroupStore();
  // Additive-only: convertImageToLabelmap creates a NEW group (never writes
  // into an existing one) and threads the `source: {jobId, outputId}` tag
  // through addLabelmap so it round-trips the .volview.zip (Chunk 11 stamps it;
  // Chunk 19 reads it for cold-reload idempotency).
  await segmentGroupStore.convertImageToLabelmap(
    childSelection,
    parentSelection,
    intent.source
  );
  // `segments` (folded labels sidecar) is optional; a seg.nrrd with embedded
  // metadata carries none and the group keeps its own decoded segments.
  if (intent.segments?.length) {
    applySegmentDescriptors(parentSelection, intent.segments);
  }
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
      if (!childSelection) return;
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

/**
 * Auto-actions on job completion. Conservative for v1 (decisions.md D6): only a
 * validated segment group auto-applies — as a NEW group, and only when there is
 * an originating dataset to attach to; every other intent waits for an explicit
 * JobList click so we never clobber the current view. The full auto-preview UX
 * (confirm/reject, visibility toggle) is Chunk 22.
 */
export async function autoLoadProcessingResults(
  results: ProcessingResult[],
  context: SubmittedJobContext | undefined
): Promise<void> {
  const parentSelection = context?.activeDatasetId;
  if (!parentSelection) return;

  for (const result of results) {
    const intent = resultToIntent(result);
    if (intent.intent !== 'add-segment-group') continue;
    try {
      await applyIntent(intent, context);
    } catch (err) {
      console.error('Failed to auto-load segment group result', result, err);
    }
  }
}
