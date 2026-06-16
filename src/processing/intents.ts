// ---------------------------------------------------------------------------
// Result intent vocabulary (decisions.md D3).
//
// A processing result declares a *result intent*: a declarative, versioned
// instruction describing what VolView should do with the produced file. This
// retires the closed `ProcessingResult.role` enum in favor of an open,
// validatable vocabulary that a single client-side applier maps to store
// calls (see actions/processResults.ts).
//
// v1 (decisions.md D3 option (a)) is exactly the legacy roles re-expressed as
// intents. Annotation intents (`add-polygon` / `add-ruler`) are deliberately
// deferred to the backlog.
//
// Pure module: schemas + types only, no store access and no side effects.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type { ProcessingSegmentDescriptor } from '@/src/processing/types';

// Bump when the vocabulary's shape changes so producers and the applier can
// negotiate compatibility.
export const vocabularyVersion = 1;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

// Every intent references the produced result file by URL and display name.
const resultFile = {
  url: z.string(),
  name: z.string(),
};

// Mirrors `ProcessingSegmentDescriptor`; the `satisfies` keeps the runtime
// schema and the core type from drifting apart.
const segmentDescriptor = z.object({
  value: z.number(),
  name: z.string(),
  // RGBA, 0-255.
  color: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  visible: z.boolean().optional(),
}) satisfies z.ZodType<ProcessingSegmentDescriptor>;

// ---------------------------------------------------------------------------
// Intent vocabulary
// ---------------------------------------------------------------------------

export const resultIntentSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('add-base-image'), ...resultFile }),
  z.object({ intent: z.literal('add-layer'), ...resultFile }),
  z.object({
    intent: z.literal('attach-segment-group'),
    ...resultFile,
    segments: z.array(segmentDescriptor),
  }),
  z.object({ intent: z.literal('restore-state'), ...resultFile }),
  z.object({ intent: z.literal('download'), ...resultFile }),
]);

export type ResultIntent = z.infer<typeof resultIntentSchema>;

// The five v1 intent names, as a literal union.
export type ResultIntentName = ResultIntent['intent'];
