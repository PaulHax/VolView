// Slicer CLI adapter — lazy-loaded chunk.
//
// Implements the `ProcessingProvider` contract by speaking HTTP to the
// `volview_processing` facade (or any other slicer-cli-speaking backend that
// supplies a `baseUrl` via provider config).
//
// All Girder/HTTP knowledge lives here. Core VolView never imports this file
// directly — it dynamic-import()s it through the providers store.

import type {
  ProcessingJobRef,
  ProcessingJobStatus,
  ProcessingProvider,
  ProcessingProviderConfig,
  ProcessingResult,
  ProcessingValue,
  SlicerCliTaskSummary,
} from '@/src/processing/types';
import { parseSlicerCli, type SlicerCliDocument } from './parser';
import type { ParsedParam } from './parser';
import { parseJobRef, parseJobStatus, parseResults } from './wire';

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

const join = (base: string, path: string) =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Request failed: ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
};

const fetchText = async (url: string): Promise<string> => {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
};

export class SlicerCliProvider implements ProcessingProvider {
  config: ProcessingProviderConfig;

  constructor(config: ProcessingProviderConfig) {
    this.config = config;
  }

  async listTasks(): Promise<SlicerCliTaskSummary[]> {
    return fetchJson<SlicerCliTaskSummary[]>(
      join(this.config.baseUrl, 'tasks')
    );
  }

  async getTaskXml(taskId: string): Promise<string> {
    return fetchText(
      join(this.config.baseUrl, `tasks/${encodeURIComponent(taskId)}/xml`)
    );
  }

  async getDefaultBindings(): Promise<Record<string, ProcessingValue>> {
    return {};
  }

  async runTask(
    taskId: string,
    values: Record<string, ProcessingValue>
  ): Promise<ProcessingJobRef> {
    const raw = await fetchJson<unknown>(
      join(this.config.baseUrl, `tasks/${encodeURIComponent(taskId)}/run`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      }
    );
    return parseJobRef(raw);
  }

  async getJob(jobId: string): Promise<ProcessingJobStatus> {
    const raw = await fetchJson<unknown>(
      join(this.config.baseUrl, `jobs/${encodeURIComponent(jobId)}`)
    );
    return parseJobStatus(jobId, raw);
  }

  async getResults(jobId: string): Promise<ProcessingResult[]> {
    const raw = await fetchJson<unknown>(
      join(this.config.baseUrl, `jobs/${encodeURIComponent(jobId)}/results`)
    );
    return parseResults(raw);
  }
}

export const createProvider = (
  config: ProcessingProviderConfig
): ProcessingProvider => new SlicerCliProvider(config);
