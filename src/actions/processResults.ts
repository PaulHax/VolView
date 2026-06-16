// Apply the result intents produced by a finished provider job.
//
// Results arrive from the provider as `ProcessingResult[]` (with the slicer-cli
// `role` field); the adapter translates each into a declarative `ResultIntent`
// (see processing/adapters/slicer-cli/resultToIntent) and a single client-side
// applier maps each intent to the store calls that perform it. The intent
// vocabulary — not a store-method name — is the producer-facing contract
// (decisions.md D3/D4).
//
// Per the architecture doc, the default is **not** to auto-load anything that
// could clobber the user's current view. Auto-load is reserved for true
// overlays (`attach-segment-group`); every other intent is requested
// explicitly from a JobList action button (decisions.md D6 MVP stance).
//
// Intent → store call:
//   `attach-segment-group` → convertImageToLabelmap + updateSegment (overlay)
//   `add-layer`            → useLayersStore.addLayer
//   `add-base-image`       → loadUrls (new top-level dataset)
//   `restore-state`        → loadUrls (no dedicated session restore yet)
//   `download`             → no store mutation; surfaced as a link in JobList

import { storeToRefs } from 'pinia';
import type {
  ProcessingResult,
  ProcessingSegmentDescriptor,
  SubmittedJobContext,
} from '@/src/processing/types';
import type { ResultIntent } from '@/src/processing/intents';
import { resultToIntent } from '@/src/processing/adapters/slicer-cli/resultToIntent';
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
  segments: ProcessingSegmentDescriptor[]
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

async function attachSegmentGroup(
  intent: Extract<ResultIntent, { intent: 'attach-segment-group' }>,
  parentSelection: string
) {
  const childSelection = await loadAsImport(intent);
  if (!childSelection) return;
  const segmentGroupStore = useSegmentGroupStore();
  await segmentGroupStore.convertImageToLabelmap(
    childSelection,
    parentSelection
  );
  if (intent.segments.length) {
    applySegmentDescriptors(parentSelection, intent.segments);
  }
}

/**
 * The single result applier: map a declarative intent to the store calls that
 * perform it. `add-layer` / `attach-segment-group` need an originating dataset
 * to attach to; with none they fall back to opening the file as a new dataset
 * (matching the legacy behavior when no active dataset was recorded).
 */
export async function applyIntent(
  intent: ResultIntent,
  context: SubmittedJobContext | undefined
): Promise<void> {
  const parentSelection = context?.activeDatasetId;

  switch (intent.intent) {
    case 'add-base-image':
    case 'restore-state':
      await loadUrls({ urls: [intent.url], names: [intent.name] });
      return;
    case 'download':
      // No store mutation — the file is surfaced as a link in JobList.
      return;
    case 'add-layer': {
      if (!parentSelection) {
        await loadUrls({ urls: [intent.url], names: [intent.name] });
        return;
      }
      const childSelection = await loadAsImport(intent);
      if (!childSelection) return;
      await useLayersStore().addLayer(parentSelection, childSelection);
      return;
    }
    case 'attach-segment-group': {
      if (!parentSelection) {
        await loadUrls({ urls: [intent.url], names: [intent.name] });
        return;
      }
      await attachSegmentGroup(intent, parentSelection);
      return;
    }
    default: {
      const exhaustive: never = intent;
      throw new Error(`Unhandled result intent: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Auto-actions on job completion. Only overlays (`attach-segment-group`)
 * auto-apply, and only when there is an originating dataset to attach to;
 * everything else waits for an explicit JobList action so we never clobber the
 * current view (decisions.md D6).
 */
export async function autoLoadProcessingResults(
  results: ProcessingResult[],
  context: SubmittedJobContext | undefined
): Promise<void> {
  const parentSelection = context?.activeDatasetId;
  if (!parentSelection) return;

  for (const result of results) {
    const intent = resultToIntent(result);
    if (intent.intent !== 'attach-segment-group') continue;
    try {
      await attachSegmentGroup(intent, parentSelection);
    } catch (err) {
      console.error('Failed to auto-load segment group result', result, err);
    }
  }
}
