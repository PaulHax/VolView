import { describe, expect, it } from 'vitest';

import {
  parseJobRef,
  parseJobStatus,
  parseResults,
} from '@/src/processing/adapters/slicer-cli/wire';
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

  it('throws when the job id is missing — nothing can be tracked', () => {
    expect(() => parseJobRef({ status: { state: 'success' } })).toThrow(
      /Malformed job ref/
    );
  });

  it('throws when the job id is empty or not a string', () => {
    expect(() => parseJobRef({ jobId: '' })).toThrow(/Malformed job ref/);
    expect(() => parseJobRef({ jobId: 42 })).toThrow(/Malformed job ref/);
  });
});

describe('parseResults', () => {
  const valid: ProcessingResult[] = [
    { id: 'r1', name: 'out.nrrd', url: 'https://example/out.nrrd' },
  ];

  it('passes a valid result list through byte-identically', () => {
    expect(parseResults(valid)).toEqual(valid);
  });

  it('preserves a segmentGroup result with descriptors and unknown keys', () => {
    const raw = [
      {
        id: 'r1',
        name: 'seg.nrrd',
        url: 'https://example/seg.nrrd',
        role: 'segmentGroup',
        segments: [{ value: 1, name: 'liver', color: [255, 0, 0, 255] }],
        extra: 'keep-me',
      },
    ];
    expect(parseResults(raw)).toEqual(raw);
  });

  it('degrades an unrecognized role to undefined instead of rejecting the list', () => {
    const raw = [
      {
        id: 'r1',
        name: 'out.nrrd',
        url: 'https://example/out.nrrd',
        role: 'future-role',
      },
    ];
    expect(parseResults(raw)[0].role).toBeUndefined();
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
