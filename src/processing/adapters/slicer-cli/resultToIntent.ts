// ---------------------------------------------------------------------------
// slicer-cli result → intent translation (decisions.md D3, goal 1).
//
// The slicer-cli wire format tags each result with the closed `role` enum.
// Core consumes the open, validatable intent vocabulary (processing/intents)
// instead, so the adapter translates role → intent here, at the adapter
// boundary. The wire format does not change — translation is client-side —
// which keeps the role/Girder shape from leaking past this seam.
//
// Lives in its own light module (types + intents only — no provider, parser,
// or fetch) so the Analysis chunk can import it without dragging in the lazy
// adapter chunk.
// ---------------------------------------------------------------------------

import type { ProcessingResult } from '@/src/processing/types';
import type { ResultIntent } from '@/src/processing/intents';

export const resultToIntent = (result: ProcessingResult): ResultIntent => {
  const file = { url: result.url, name: result.name };
  switch (result.role) {
    case 'segmentGroup':
      return {
        intent: 'attach-segment-group',
        ...file,
        segments: result.segments ?? [],
      };
    case 'layer':
      return { intent: 'add-layer', ...file };
    case 'state':
      return { intent: 'restore-state', ...file };
    case 'download':
      return { intent: 'download', ...file };
    case 'base':
    default:
      // `base` and unset both open the result as a new base image.
      return { intent: 'add-base-image', ...file };
  }
};
