// ---------------------------------------------------------------------------
// D4 parity mechanism (single source): generate a JSON Schema from the zod
// source so the Python/facade side validates the SAME golden fixtures against
// the SAME normative definition — one schema, two validators — instead of a
// hand-maintained second copy.
//
// NOTE (deferred-trap boundary): this is the INTERNAL zod->JSON-Schema for
// fixture parity, NOT the deferred third-party-facing JSON-Schema *view* of the
// task spec (WORKORDER Deferred #9). The generated files here exist only so the
// facade tests can validate the shared fixtures.
//
// zod's cross-field refinements (min<=max, default-in-range, enum default) are
// NOT representable in JSON Schema; `unrepresentable: 'any'` drops them from the
// generated structural schema. Those constraints stay the zod side's extra
// rigor (exercised by the negative constraint-violation fixture in vitest).
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { taskSpecSchema } from './task-spec';
import {
  inputValueSchema,
  neutralJobStatusSchema,
  resultIntentSchema,
  neutralJobHandleSchema,
  jobResultsSchema,
  jobResultsErrorSchema,
} from './wire';

const schemas = {
  'task-spec': taskSpecSchema,
  'input-value': inputValueSchema,
  'neutral-job-status': neutralJobStatusSchema,
  'result-intent': resultIntentSchema,
  'neutral-job-handle': neutralJobHandleSchema,
  'job-results': jobResultsSchema,
  'job-results-error': jobResultsErrorSchema,
} as const;

export type GeneratedSchemaName = keyof typeof schemas;

export const generateJsonSchemas = (): Record<GeneratedSchemaName, unknown> =>
  Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { unrepresentable: 'any' }),
    ])
  ) as Record<GeneratedSchemaName, unknown>;

export const GENERATED_SCHEMA_NAMES = Object.keys(
  schemas
) as GeneratedSchemaName[];
