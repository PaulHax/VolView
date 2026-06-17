// ---------------------------------------------------------------------------
// Result action policy — which load actions (Open / Add as layer / Add as
// segment group) a processing result supports in the Analysis job list.
//
// The policy keys on the result's *resolved intent* (`resultToIntent` prefers
// the validated `intent` field and falls back to translating the legacy `role`)
// rather than the raw wire `role`. This is what lets the UI honor the
// `download` intent the facade emits for non-image outputs: the facade omits
// `role` for everything but labelmaps, so role-only gating could never tell a
// download-only file apart from a base image and wrongly offered "Open" on it.
//
// Pure module (no Vue, no store, no fetch) so the gating decisions are unit
// testable on their own — the JobList SFC just renders these predicates.
// ---------------------------------------------------------------------------

import type { ResultIntent } from '@/src/processing/intents';
import { resultToIntent } from '@/src/processing/adapters/slicer-cli/resultToIntent';
import type { ProcessingResult } from '@/src/processing/types';

const IMAGE_LIKE_MIMETYPES = [
  'application/dicom',
  'application/vnd.unknown.nifti-1',
  'application/vnd.unknown.metaimage',
  'application/vnd.unknown.nrrd',
];

// The result's natural (default) intent — what the producer says VolView should
// do with the file. The slicer-cli `role` field is the untranslated wire shape;
// resolving through `resultToIntent` keeps this policy off the wire vocabulary.
export function naturalIntent(
  result: ProcessingResult
): ResultIntent['intent'] {
  return resultToIntent(result).intent;
}

export function looksLikeImage(result: ProcessingResult): boolean {
  if (result.mimeType && IMAGE_LIKE_MIMETYPES.includes(result.mimeType)) {
    return true;
  }
  const lower = result.name.toLowerCase();
  return (
    lower.endsWith('.nii') ||
    lower.endsWith('.nii.gz') ||
    lower.endsWith('.mha') ||
    lower.endsWith('.mhd') ||
    lower.endsWith('.nrrd') ||
    lower.endsWith('.dcm')
  );
}

// "Open" loads the result as a new base image; only download-only outputs
// (no in-app representation) are excluded.
export function canOpen(result: ProcessingResult): boolean {
  return naturalIntent(result) !== 'download';
}

export function canBeLayer(result: ProcessingResult): boolean {
  const intent = naturalIntent(result);
  if (intent === 'restore-state' || intent === 'download') return false;
  if (intent === 'add-layer') return true;
  if (intent === 'attach-segment-group') return false;
  // add-base-image: offer the layer action when the file is an image.
  return looksLikeImage(result);
}

export function canBeSegmentGroup(result: ProcessingResult): boolean {
  const intent = naturalIntent(result);
  if (intent === 'attach-segment-group') return true;
  if (intent === 'add-layer') return false;
  if (intent === 'restore-state' || intent === 'download') return false;
  // add-base-image: an image result can seed a segment group.
  return looksLikeImage(result);
}
