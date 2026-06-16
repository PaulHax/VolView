// ---------------------------------------------------------------------------
// slicer-cli result → intent translation (decisions.md D3, goal 1).
//
// The slicer-cli wire format tags each result with the closed `role` enum and,
// since item 3.1, additively with a validated `intent` field. Core consumes
// the open, validatable intent vocabulary (processing/intents) instead, so the
// adapter resolves a result to an intent here, at the adapter boundary: it
// prefers a present, valid provider `intent`, and falls back to translating the
// legacy `role` otherwise. The wire format does not change — translation stays
// client-side — which keeps the role/Girder shape from leaking past this seam.
//
// Lives in its own light module (types + intents only — no provider, parser,
// or fetch) so the Analysis chunk can import it without dragging in the lazy
// adapter chunk.
// ---------------------------------------------------------------------------

import type { ProcessingResult } from '@/src/processing/types';
import {
  resultIntentSchema,
  type ResultIntent,
} from '@/src/processing/intents';

// Translate the legacy closed `role` enum to an intent. The fallback used when
// the provider supplies no `intent` (or an invalid one).
const roleToIntent = (result: ProcessingResult): ResultIntent => {
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

export const resultToIntent = (result: ProcessingResult): ResultIntent => {
  // Prefer the provider's intent when present and valid. The candidate carries
  // every field an intent might need; the discriminated union keeps only those
  // its member declares (e.g. `segments` survives only on attach-segment-group)
  // and rejects an unknown/malformed intent, which then falls through to role.
  if (result.intent !== undefined) {
    const parsed = resultIntentSchema.safeParse({
      intent: result.intent,
      url: result.url,
      name: result.name,
      segments: result.segments ?? [],
    });
    if (parsed.success) {
      return parsed.data;
    }
  }
  return roleToIntent(result);
};
