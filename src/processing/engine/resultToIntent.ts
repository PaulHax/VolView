// ---------------------------------------------------------------------------
// Resolve a wire result to a declarative result intent (contract Seam 2; D3/D4).
//
// The producer (facade) now emits the neutral `intent` vocabulary natively, so
// the client consumes it directly — there is NO `role` switch here anymore (the
// closed `role` enum is retired: contract Seam 2 "never a closed role enum").
// The single applier maps the resolved intent to store calls.
//
// Fail closed (contract Seam 2 "unknown intent -> degrade to download"): a
// result whose `intent` is outside the v1 vocabulary, OR whose known-name
// payload is shape-invalid (e.g. a broken `segments`), degrades to `download`.
// Every result is a file, so the download floor is always safe. The gate is the
// STRICT `knownResultIntentSchema` member — a name-known-but-shape-invalid
// result must not be applied as if it were a valid segment group.
//
// Lives in the engine/core home; core imports it (`actions/processResults`,
// `processing/resultActions`).
// ---------------------------------------------------------------------------

import {
  knownResultIntentSchema,
  type ResultIntent,
} from '@/processing-contract';
import type { ProcessingResult } from '@/src/processing/types';

export const resultToIntent = (result: ProcessingResult): ResultIntent => {
  // Build the candidate intent from the result's own fields. The strict member
  // keeps only what it declares (e.g. `segments`/`source` survive only on
  // `add-segment-group`) and rejects an unknown or malformed shape.
  const candidate = {
    intent: result.intent,
    url: result.url,
    name: result.name,
    ...(result.segments ? { segments: result.segments } : {}),
    ...(result.source ? { source: result.source } : {}),
  };
  const known = knownResultIntentSchema.safeParse(candidate);
  if (known.success) return known.data;
  // Unknown intent name, missing intent, or a known name with an invalid
  // payload: degrade to the always-safe download floor.
  return { intent: 'download', url: result.url, name: result.name };
};
