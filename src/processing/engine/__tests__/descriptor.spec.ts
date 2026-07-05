import { describe, it, expect, vi } from 'vitest';

import { defaultDescriptor } from '../descriptor';
import type { TaskSummary } from '@/src/processing/types';

// The neutral-facade default descriptor is the ONE place that knows the facade's
// URL layout. These pin the job-addressed / folder-free split (D5, Chunk 18):
// the launch-context endpoints are handed the folder-scoped baseUrl, the three
// job endpoints are handed the explicit folder-free jobsBaseUrl (the transport
// supplies it — Chunk 33 replaced the former `jobsRoot` route-root regex with a
// second base URL; review §4.6/§6.4). Every template now simply joins.

const FOLDER_BASE = '/api/v1/folder/abc123/volview_processing';
const JOBS_BASE = '/api/v1/volview_processing';
const { endpoints } = defaultDescriptor;

describe('default descriptor endpoint templates', () => {
  it('keeps launch-context endpoints on the folder-scoped baseUrl', () => {
    // tasks / spec / run / stage genuinely operate per-folder — unchanged.
    expect(endpoints.listTasks(FOLDER_BASE)).toBe(`${FOLDER_BASE}/tasks`);
    expect(endpoints.taskSpec(FOLDER_BASE, 't1')).toBe(
      `${FOLDER_BASE}/tasks/t1/spec`
    );
    expect(endpoints.runTask(FOLDER_BASE, 't1')).toBe(
      `${FOLDER_BASE}/tasks/t1/run`
    );
    expect(endpoints.stage?.(FOLDER_BASE)).toBe(`${FOLDER_BASE}/stage`);
    // Tier-2 re-discovery is context-scoped (Chunk 19): it keeps the
    // folder-scoped baseUrl, unlike the job-addressed routes below.
    expect(endpoints.listRecentJobs?.(FOLDER_BASE)).toBe(`${FOLDER_BASE}/jobs`);
  });

  it('advertises the tier-2 re-discovery capability (endpoint + parser)', () => {
    // The neutral facade DOES support durable enumeration, so both halves of the
    // capability are present — a provider built on this descriptor exposes
    // listRecentJobs and the store runs tier-2 (vs degrading to tier-1).
    expect(defaultDescriptor.endpoints.listRecentJobs).toBeTypeOf('function');
    expect(defaultDescriptor.format.parseJobHandles).toBeTypeOf('function');
  });

  it('joins job-addressed endpoints off the explicit jobs base URL (D5)', () => {
    // No folder to strip: a job is addressed by id alone, and the folder-free
    // jobs base is handed in by the transport (config.jobsBaseUrl) — the template
    // just joins, no route-root string surgery.
    expect(endpoints.jobStatus(JOBS_BASE, 'job1')).toBe(
      '/api/v1/volview_processing/jobs/job1'
    );
    expect(endpoints.jobResults(JOBS_BASE, 'job1')).toBe(
      '/api/v1/volview_processing/jobs/job1/results'
    );
    expect(endpoints.cancel?.(JOBS_BASE, 'job1')).toBe(
      '/api/v1/volview_processing/jobs/job1/cancel'
    );
  });

  it('percent-encodes the job id in job-addressed endpoints', () => {
    expect(endpoints.cancel?.(JOBS_BASE, 'a/b')).toBe(
      '/api/v1/volview_processing/jobs/a%2Fb/cancel'
    );
  });

  it('joins job-addressed endpoints off whatever base it is handed (pure join, no regex)', () => {
    // The former `jobsRoot` regex is gone: the descriptor performs no route-root
    // surgery, so a bare base hangs the job routes directly off it.
    const base = '/volview_processing';
    expect(endpoints.jobStatus(base, 'job1')).toBe(
      '/volview_processing/jobs/job1'
    );
    expect(endpoints.cancel?.(base, 'job1')).toBe(
      '/volview_processing/jobs/job1/cancel'
    );
  });
});

// The task summary is advisory display metadata, validated by a LIGHT lenient
// guard that must FAIL SOFT: a malformed entry is dropped with a warning, never
// thrown on, so one bad summary never kills the picker (Seam 2 fail-closed
// discipline; review §5.3). This replaces the former unvalidated
// `raw as TaskSummary[]` cast.
describe('default descriptor task-summary parsing (fail soft)', () => {
  const { parseTasks } = defaultDescriptor.format;

  it('drops a malformed summary and keeps the valid ones (listTasks survives)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = parseTasks([
      { id: 't1', title: 'One', dockerImage: 'org/img:1', category: ['seg'] },
      { id: 42, title: 'bad id type' }, // malformed: id is not a string
      { title: 'no id' }, // malformed: id missing
      null, // malformed: not an object
      { id: 't2', title: 'Two' },
    ]);

    // The picker survives with exactly the well-formed summaries, in order.
    expect(parsed.map((t) => t.id)).toEqual(['t1', 't2']);
    // Advisory hints ride through the lenient guard verbatim (pass-through).
    expect(parsed[0].dockerImage).toBe('org/img:1');
    expect(parsed[0].category).toEqual(['seg']);
    // The drop was reported, not silent.
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('degrades a non-array payload to an empty list without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseTasks({} as unknown)).toEqual([]);
    expect(parseTasks(null as unknown)).toEqual([]);
    expect(parseTasks('nope' as unknown)).toEqual([]);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('passes a fully valid task list through unchanged', () => {
    const summaries: TaskSummary[] = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', description: 'second' },
    ];
    expect(parseTasks(summaries)).toEqual(summaries);
  });
});
