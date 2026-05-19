// Dispatch a `ProcessingResult[]` returned by a finished provider job.
//
// Per the architecture doc, the default is **not** to auto-load anything that
// could clobber the user's current view. Auto-load is reserved for true
// overlays (segment groups). Everything else is surfaced as an action button
// in JobList so the user can choose to open/attach/download.
//
// Result roles:
//   `segmentGroup` → auto-load + attach as labelmap onto the originating
//                   dataset. Overlays are non-disruptive.
//   `layer`        → wait for user click → load + addLayer.
//   `base` / unset → wait for user click → loadUrls as new dataset.
//   `download`     → wait for user click → just a link.
//   `state`        → user-initiated session-state restore.

import { storeToRefs } from 'pinia';
import type {
  ProcessingResult,
  ProcessingSegmentDescriptor,
  SubmittedJobContext,
} from '@/src/processing/types';
import { uriToDataSource } from '@/src/io/import/dataSource';
import {
  importDataSources,
  toDataSelection,
} from '@/src/io/import/importDataSources';
import { isVolumeResult } from '@/src/io/import/common';
import { useLayersStore } from '@/src/store/datasets-layers';
import { useSegmentGroupStore } from '@/src/store/segmentGroups';
import { loadUrls } from './loadUserFiles';

async function loadAsImport(result: ProcessingResult) {
  const ds = uriToDataSource(result.url, result.name);
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

/** Auto-actions on job completion. Only overlays. */
export async function autoLoadProcessingResults(
  results: ProcessingResult[],
  context: SubmittedJobContext | undefined
): Promise<void> {
  const parentSelection = context?.activeDatasetId;
  const segmentGroupStore = useSegmentGroupStore();

  for (const result of results) {
    if (result.role === 'segmentGroup' && parentSelection) {
      try {
        const childSelection = await loadAsImport(result);
        if (childSelection) {
          await segmentGroupStore.convertImageToLabelmap(
            childSelection,
            parentSelection
          );
          if (result.segments?.length) {
            applySegmentDescriptors(parentSelection, result.segments);
          }
        }
      } catch (err) {
        console.error('Failed to auto-load segment group result', result, err);
      }
    }
  }
}

/** User-initiated load (called from JobList action buttons). */
export async function loadResultAction(
  result: ProcessingResult,
  context: SubmittedJobContext | undefined,
  action: 'open' | 'layer' | 'segmentGroup'
): Promise<void> {
  const layersStore = useLayersStore();
  const segmentGroupStore = useSegmentGroupStore();
  const parentSelection = context?.activeDatasetId;

  if (action === 'open') {
    await loadUrls({ urls: [result.url], names: [result.name] });
    return;
  }
  if (!parentSelection) {
    // No parent → fall back to opening as a new dataset.
    await loadUrls({ urls: [result.url], names: [result.name] });
    return;
  }
  const childSelection = await loadAsImport(result);
  if (!childSelection) return;
  if (action === 'layer') {
    await layersStore.addLayer(parentSelection, childSelection);
  } else if (action === 'segmentGroup') {
    await segmentGroupStore.convertImageToLabelmap(
      childSelection,
      parentSelection
    );
    if (result.segments?.length) {
      applySegmentDescriptors(parentSelection, result.segments);
    }
  }
}
