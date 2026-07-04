import { describe, expect, it } from 'vitest';

import {
  parseJobHandles,
  parseJobRef,
  parseJobStatus,
  parseResults,
} from '@/src/processing/engine/wire';
import type {
  ProcessingJobStatus,
  ProcessingResult,
} from '@/src/processing/types';

describe('parseJobStatus', () => {
  it('passes a valid status through byte-identically', () => {
    const status: ProcessingJobStatus = {
      jobId: 'job-1',
      state: 'running',
      progress: 0.4,
    };
    expect(parseJobStatus('job-1', status)).toEqual(status);
  });

  it('accepts every declared terminal/non-terminal state', () => {
    (['pending', 'running', 'success', 'error', 'cancelled'] as const).forEach(
      (state) => {
        expect(parseJobStatus('job-1', { jobId: 'job-1', state }).state).toBe(
          state
        );
      }
    );
  });

  it('preserves unknown wire keys on the happy path', () => {
    const raw = { jobId: 'job-1', state: 'success', extra: 'keep-me' };
    expect(parseJobStatus('job-1', raw)).toMatchObject({ extra: 'keep-me' });
  });

  it('converts an unknown state into a terminal error keyed to the requested job', () => {
    const result = parseJobStatus('job-1', {
      jobId: 'job-1',
      state: 'who-knows',
    });
    expect(result.jobId).toBe('job-1');
    expect(result.state).toBe('error');
    expect(result.errorTail).toContain('Malformed job status');
  });

  it('converts a missing state into a terminal error', () => {
    expect(parseJobStatus('job-1', { jobId: 'job-1' }).state).toBe('error');
  });

  it('pins a valid status to the requested jobId, not the echoed one', () => {
    const status = parseJobStatus('job-1', {
      jobId: 'something-else',
      state: 'success',
    });
    expect(status.jobId).toBe('job-1');
    expect(status.state).toBe('success');
  });

  it('converts a non-object payload into a terminal error', () => {
    expect(parseJobStatus('job-1', 'nonsense').state).toBe('error');
    expect(parseJobStatus('job-1', null).state).toBe('error');
  });
});

describe('parseJobRef', () => {
  it('parses a ref with no initial status (async/poll path)', () => {
    expect(parseJobRef({ jobId: 'job-1' })).toEqual({ jobId: 'job-1' });
  });

  it('parses a born-terminal ref with a valid status', () => {
    const status: ProcessingJobStatus = { jobId: 'job-1', state: 'success' };
    expect(parseJobRef({ jobId: 'job-1', status })).toEqual({
      jobId: 'job-1',
      status,
    });
  });

  it('turns a malformed born-terminal status into a terminal error, not an infinite poll', () => {
    const ref = parseJobRef({
      jobId: 'job-1',
      status: { jobId: 'job-1', state: 'bogus' },
    });
    expect(ref.jobId).toBe('job-1');
    expect(ref.status?.state).toBe('error');
  });

  // Nothing can be tracked without a usable job id, so every unusable form throws.
  it.each([
    ['a missing job id', { status: { state: 'success' } }],
    ['an empty job id', { jobId: '' }],
    ['a non-string job id', { jobId: 42 }],
  ])('throws on a ref with %s', (_label, input) => {
    expect(() => parseJobRef(input)).toThrow(/Malformed job ref/);
  });
});

describe('parseResults', () => {
  const valid: ProcessingResult[] = [
    { id: 'r1', name: 'out.nrrd', url: 'https://example/out.nrrd' },
  ];

  it('passes a valid result list through byte-identically', () => {
    expect(parseResults(valid)).toEqual(valid);
  });

  it('preserves a segment-group result with descriptors and unknown keys', () => {
    const raw = [
      {
        id: 'r1',
        name: 'seg.nrrd',
        url: 'https://example/seg.nrrd',
        intent: 'add-segment-group',
        segments: [{ value: 1, name: 'liver', color: [255, 0, 0, 255] }],
        extra: 'keep-me',
      },
    ];
    expect(parseResults(raw)).toEqual(raw);
  });

  it('tolerates null mimeType/size (the facade emits absent file fields as null)', () => {
    const raw = [
      {
        id: 'r1',
        name: 'out.nrrd',
        url: 'https://example/out.nrrd',
        mimeType: null,
        size: null,
      },
    ];
    // Null is accepted (not thrown) and normalized to absent so the output
    // still matches `ProcessingResult` (mimeType?: string, size?: number).
    const parsed = parseResults(raw);
    expect(parsed[0]).toMatchObject({ id: 'r1', name: 'out.nrrd' });
    expect(parsed[0].mimeType).toBeUndefined();
    expect(parsed[0].size).toBeUndefined();
  });

  it('throws on a non-array payload', () => {
    expect(() => parseResults({ id: 'r1' })).toThrow(/Malformed job results/);
  });

  it('throws when a result is missing a required field', () => {
    expect(() => parseResults([{ id: 'r1', name: 'out.nrrd' }])).toThrow(
      /Malformed job results/
    );
  });
});

describe('parseJobHandles (tier-2, Chunk 19)', () => {
  const handle = {
    jobId: 'job-abc123',
    taskId: 'OtsuSegmentation',
    inputUris: ['/api/v1/file/a1/proxiable/1.dcm'],
    finishedAt: '2026-07-03T18:24:05.123000+00:00',
  };

  it('passes a valid NeutralJobHandle[] through', () => {
    expect(parseJobHandles([handle])).toEqual([handle]);
    // A running job carries an empty finishedAt (still a string) — valid.
    expect(parseJobHandles([{ ...handle, finishedAt: '' }])).toEqual([
      { ...handle, finishedAt: '' },
    ]);
    expect(parseJobHandles([])).toEqual([]);
  });

  it('throws on a non-array or a malformed handle (re-discovery fails loud)', () => {
    expect(() => parseJobHandles({ jobId: 'x' })).toThrow(
      /Malformed job handles/
    );
    // Missing inputUris — the re-association key — is rejected.
    expect(() =>
      parseJobHandles([{ jobId: 'j', taskId: 't', finishedAt: 'T' }])
    ).toThrow(/Malformed job handles/);
  });
});
