import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProvider } from '@/src/processing/adapters/slicer-cli';

// Minimal ok-Response stand-in: fetchJson only reads `ok` and `json()`.
const jsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

const provider = () =>
  createProvider({
    id: 'p1',
    label: 'Fake',
    protocol: 'slicer-cli',
    baseUrl: 'http://localhost/',
  });

describe('SlicerCliProvider — wire validation seam', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getJob converts an unknown wire state into a terminal error state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ jobId: 'job-1', state: 'gibberish' }))
    );
    const status = await provider().getJob('job-1');
    expect(status.state).toBe('error');
  });

  it('getJob passes a valid wire status through unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ jobId: 'job-1', state: 'success' }))
    );
    expect((await provider().getJob('job-1')).state).toBe('success');
  });

  it('runTask surfaces a terminal error for a malformed born-terminal status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          jobId: 'job-1',
          status: { jobId: 'job-1', state: 'bad' },
        })
      )
    );
    const ref = await provider().runTask('task-1', {});
    expect(ref.jobId).toBe('job-1');
    expect(ref.status?.state).toBe('error');
  });

  it('getResults rejects a malformed result payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ not: 'an array' }))
    );
    await expect(provider().getResults('job-1')).rejects.toThrow(
      /Malformed job results/
    );
  });
});
