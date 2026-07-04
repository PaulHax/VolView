// Slicer CLI adapter — lazy-loaded chunk.
//
// Implements the `ProcessingProvider` contract by speaking HTTP to the
// `volview_processing` facade (or any other slicer-cli-speaking backend that
// supplies a `baseUrl` via provider config).
//
// All Girder/HTTP knowledge lives here. Core VolView never imports this file
// directly — it dynamic-import()s it through the providers store.

import type {
  ProcessingProvider,
  ProcessingProviderConfig,
  ProcessingValue,
} from '@/src/processing/types';
import { $fetch } from '@/src/utils/fetch';
import { createEngineTransport } from '@/src/processing/engine/transport';
import { defaultDescriptor } from '@/src/processing/engine/descriptor';
import { parseSlicerCli, type SlicerCliDocument } from './parser';
import type { ParsedParam } from './parser';

// ---------------------------------------------------------------------------
// Schema-driven form helpers (consumed by TaskForm.vue, not core VolView).
// ---------------------------------------------------------------------------

export type SlicerCliValidationIssue = {
  parameter: string;
  message: string;
};

export const parseXml = (xml: string): SlicerCliDocument => parseSlicerCli(xml);

export const getInitialValues = (
  doc: SlicerCliDocument,
  defaults: Record<string, ProcessingValue> = {}
): Record<string, ProcessingValue> => {
  const initial: Record<string, ProcessingValue> = {};
  doc.parameters.forEach((p) => {
    // Output filenames are auto-generated server-side — skip here.
    if (p.type === 'new-file') return;
    if (p.id in defaults) {
      initial[p.id] = defaults[p.id];
      return;
    }
    if (p.value !== undefined) {
      initial[p.id] = p.value as ProcessingValue;
    } else if (p.type === 'boolean') {
      initial[p.id] = false;
    } else if (p.type === 'string-enumeration' && p.values?.length) {
      initial[p.id] = String(p.values[0]);
    } else {
      initial[p.id] = null;
    }
  });
  return initial;
};

const isEmpty = (v: ProcessingValue): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && v.length === 0) ||
  (Array.isArray(v) && v.length === 0);

export const validate = (
  doc: SlicerCliDocument,
  values: Record<string, ProcessingValue>
): SlicerCliValidationIssue[] => {
  const issues: SlicerCliValidationIssue[] = [];
  doc.parameters.forEach((p: ParsedParam) => {
    // Output filenames are auto-generated server-side — never validate here.
    if (p.type === 'new-file') return;
    const v = values[p.id];
    if (p.required && isEmpty(v)) {
      issues.push({
        parameter: p.id,
        message: `${p.title || p.id} is required`,
      });
    }
    if (p.type === 'region') {
      // Region is out of scope for MVP — disallow submission until set.
      issues.push({
        parameter: p.id,
        message: 'Region inputs are not yet supported',
      });
    }
    if (typeof v === 'number') {
      if (p.min !== undefined && typeof p.min === 'number' && v < p.min) {
        issues.push({
          parameter: p.id,
          message: `${p.title || p.id} must be ≥ ${p.min}`,
        });
      }
      if (p.max !== undefined && typeof p.max === 'number' && v > p.max) {
        issues.push({
          parameter: p.id,
          message: `${p.title || p.id} must be ≤ ${p.max}`,
        });
      }
    }
  });
  return issues;
};

export type { SlicerCliDocument };

// ---------------------------------------------------------------------------
// Provider — composed from the generic engine transport.
//
// Every live HTTP path (tasks / spec / run / status / results) is driven by the
// generic engine reading the neutral-facade default descriptor, over the
// bearer-aware `$fetch`. This adapter no longer holds any transport of its own;
// it only supplies the retired `getTaskXml` (kept until the Chunk 13 deletion
// sweep) and the no-op `getDefaultBindings`.
// ---------------------------------------------------------------------------

const join = (base: string, path: string) =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

// Retired path — routed through `$fetch` (never raw `fetch`) so no bypass of
// the bearer header survives. The `tasks/{id}/xml` endpoint is deleted with the
// XML path in Chunk 13, so it is not promoted into the descriptor.
const fetchText = async (url: string): Promise<string> => {
  const res = await $fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
};

export const createProvider = (
  config: ProcessingProviderConfig
): ProcessingProvider => {
  const transport = createEngineTransport(config.baseUrl, defaultDescriptor);
  return {
    config,
    listTasks: () => transport.listTasks(),
    getTaskSpec: (taskId) => transport.getTaskSpec(taskId),
    getTaskXml: (taskId) =>
      fetchText(
        join(config.baseUrl, `tasks/${encodeURIComponent(taskId)}/xml`)
      ),
    getDefaultBindings: async () => ({}),
    runTask: (taskId, values) => transport.runTask(taskId, values),
    getJob: (jobId) => transport.getJob(jobId),
    getResults: (jobId) => transport.getResults(jobId),
  };
};
