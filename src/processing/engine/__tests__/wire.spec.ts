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
import { loadFixture } from '@/processing-contract/__tests__/loadFixtures';

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
  const validItems: ProcessingResult[] = [
    { id: 'r1', name: 'out.nrrd', url: 'https://example/out.nrrd' },
  ];

  it('parses the {intents, missing} envelope into {results, missing}', () => {
    const { results, missing } = parseResults({
      intents: validItems,
      missing: 2,
    });
    expect(results).toEqual(validItems);
    expect(missing).toBe(2);
  });

  it('normalizes an absent `missing` to 0 (a facade that omits it is compatible)', () => {
    expect(parseResults({ intents: validItems })).toEqual({
      results: validItems,
      missing: 0,
    });
  });

  it('preserves a segment-group result with descriptors and unknown keys', () => {
    const intents = [
      {
        id: 'r1',
        name: 'seg.nrrd',
        url: 'https://example/seg.nrrd',
        intent: 'add-segment-group',
        segments: [{ value: 1, name: 'liver', color: [255, 0, 0, 255] }],
        extra: 'keep-me',
      },
    ];
    expect(parseResults({ intents, missing: 0 }).results).toEqual(intents);
  });

  it('structurally accepts an out-of-range segment descriptor (bounds deferred downstream)', () => {
    // The engine wire schema is DERIVED from the contract's segmentDescriptorSchema
    // but LOOSENS its bounds back to plain numbers: `value` and RGBA channels the
    // contract rejects (0-background value, a >255 channel) must pass here so a
    // single out-of-range descriptor cannot throw away a whole result list — the
    // semantic bounds live downstream in `resultToIntent`. This pins the "loosen,
    // don't inherit" derivation (a naive `.extend()` would re-impose the bounds).
    const intents = [
      {
        id: 'r1',
        name: 'seg.nrrd',
        url: 'https://example/seg.nrrd',
        intent: 'add-segment-group',
        segments: [{ value: 0, name: 'bg', color: [300, -5, 0, 255] }],
      },
    ];
    expect(parseResults({ intents, missing: 0 }).results).toEqual(intents);
  });

  it('tolerates null mimeType/size (the facade emits absent file fields as null)', () => {
    const intents = [
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
    const { results } = parseResults({ intents });
    expect(results[0]).toMatchObject({ id: 'r1', name: 'out.nrrd' });
    expect(results[0].mimeType).toBeUndefined();
    expect(results[0].size).toBeUndefined();
  });

  it('exercises the job-results.missing.json wire fixture (GATE-C acceptance)', () => {
    // The golden fixture pins the {intents, missing} envelope with PURE-intent
    // items (the contract vocabulary floor). The real facade ENRICHES each intent
    // with the id/name the JobList reads (exactly `_collectJobResults`' merge), so
    // simulate that enrichment before feeding the transport parser.
    const fixture = loadFixture('wire/job-results.missing.json') as {
      intents: Array<Record<string, unknown>>;
      missing: number;
    };
    expect(fixture.missing).toBe(2);
    const enriched = {
      ...fixture,
      intents: fixture.intents.map((intent, n) => ({
        id: `out-${n}`,
        ...intent,
      })),
    };
    const { results, missing } = parseResults(enriched);
    expect(missing).toBe(2);
    expect(results).toHaveLength(1);
    expect(results[0].intent).toBe('add-base-image');
  });

  it('throws on a bare list — the pre-envelope shape is no longer accepted', () => {
    expect(() => parseResults(validItems)).toThrow(/Malformed job results/);
  });

  it('throws on a non-object payload', () => {
    expect(() => parseResults({ id: 'r1' })).toThrow(/Malformed job results/);
  });

  it('throws when a result item is missing a required field', () => {
    expect(() =>
      parseResults({ intents: [{ id: 'r1', name: 'out.nrrd' }] })
    ).toThrow(/Malformed job results/);
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
