import { describe, it, expect } from 'vitest';

import { defaultDescriptor } from '../descriptor';

// The neutral-facade default descriptor is the ONE place that knows the facade's
// URL layout. These pin the job-addressed / folder-free split (D5, Chunk 18):
// the launch-context endpoints stay folder-scoped, the job endpoints re-root to
// the folder-free `volview_processing` surface.

const FOLDER_BASE = '/api/v1/folder/abc123/volview_processing';
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
  });

  it('re-roots job-addressed endpoints off the folder (D5)', () => {
    // The `folder/<id>/` segment is dropped: a job is addressed by id alone.
    expect(endpoints.jobStatus(FOLDER_BASE, 'job1')).toBe(
      '/api/v1/volview_processing/jobs/job1'
    );
    expect(endpoints.jobResults(FOLDER_BASE, 'job1')).toBe(
      '/api/v1/volview_processing/jobs/job1/results'
    );
    expect(endpoints.cancel?.(FOLDER_BASE, 'job1')).toBe(
      '/api/v1/volview_processing/jobs/job1/cancel'
    );
  });

  it('percent-encodes the job id in job-addressed endpoints', () => {
    expect(endpoints.cancel?.(FOLDER_BASE, 'a/b')).toBe(
      '/api/v1/volview_processing/jobs/a%2Fb/cancel'
    );
  });

  it('leaves an already folder-free baseUrl unchanged', () => {
    // A deployment whose baseUrl is already the processing root has no folder to
    // strip — job endpoints hang directly off it.
    const base = '/volview_processing';
    expect(endpoints.jobStatus(base, 'job1')).toBe(
      '/volview_processing/jobs/job1'
    );
    expect(endpoints.cancel?.(base, 'job1')).toBe(
      '/volview_processing/jobs/job1/cancel'
    );
  });
});
