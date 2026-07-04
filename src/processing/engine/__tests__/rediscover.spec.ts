import { describe, it, expect } from 'vitest';

import {
  reassociateBase,
  passesWatermark,
  sourceInScene,
  type ReattachCandidate,
} from '@/src/processing/engine/rediscover';

// ---------------------------------------------------------------------------
// reassociateBase — match a job's input opaque URIs to a reloaded dataset,
// UNIFORM for every format (no DICOM-StudyUID special case, Chunk 19 / D5).
// ---------------------------------------------------------------------------

describe('reassociateBase', () => {
  it('matches a DICOM-series base and an NRRD base through the SAME code path', () => {
    const dicomSlices = [
      '/api/v1/file/a1/proxiable/1-001.dcm',
      '/api/v1/file/a2/proxiable/1-002.dcm',
      '/api/v1/file/a3/proxiable/1-003.dcm',
    ];
    const nrrd = ['/api/v1/file/b1/proxiable/scan.nrrd'];

    // A multi-URI DICOM series and a single-URI NRRD re-associate identically —
    // the candidate's provenance URIs are a subset of the job's input URIs.
    const dicomBase = reassociateBase(dicomSlices, [
      { id: 'dicom-vol', uris: dicomSlices },
    ]);
    const nrrdBase = reassociateBase(nrrd, [{ id: 'nrrd-vol', uris: nrrd }]);

    expect(dicomBase).toBe('dicom-vol');
    expect(nrrdBase).toBe('nrrd-vol');
  });

  it('returns undefined when no reloaded dataset was a job input', () => {
    expect(
      reassociateBase(['/f/a'], [{ id: 'other', uris: ['/f/z'] }])
    ).toBeUndefined();
    // A dataset only PARTIALLY overlapping the inputs is not the base (its own
    // provenance must be a subset — the whole dataset was an input).
    expect(
      reassociateBase(['/f/a'], [{ id: 'partial', uris: ['/f/a', '/f/b'] }])
    ).toBeUndefined();
  });

  it('prefers the most specific match when several datasets were inputs', () => {
    // A labelmap-consuming task binds both an image (2 slices) and a labelmap
    // (1 file); both are subsets of the input URIs, but the base is the image.
    const inputUris = ['/f/s1', '/f/s2', '/f/mask'];
    const candidates: ReattachCandidate[] = [
      { id: 'mask', uris: ['/f/mask'] },
      { id: 'image', uris: ['/f/s1', '/f/s2'] },
    ];
    expect(reassociateBase(inputUris, candidates)).toBe('image');
  });

  it('skips empty-provenance candidates (local drops can never be a job input)', () => {
    expect(
      reassociateBase(
        ['/f/a'],
        [
          { id: 'local', uris: [] },
          { id: 'server', uris: ['/f/a'] },
        ]
      )
    ).toBe('server');
    // An all-empty candidate set yields no base.
    expect(reassociateBase([], [{ id: 'local', uris: [] }])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// passesWatermark — apply iff finishedAt > sessionSavedAt; conservative failure
// direction is to ATTACH (resurrect), never silently drop (D5).
// ---------------------------------------------------------------------------

describe('passesWatermark', () => {
  const T10 = '2026-07-03T10:00:00Z';
  const T12 = '2026-07-03T12:00:00Z';
  const T20 = '2026-07-03T20:00:00Z';

  it('no watermark → attach all (MVP parity)', () => {
    expect(passesWatermark(T10, undefined)).toBe(true);
    expect(passesWatermark(undefined, undefined)).toBe(true);
  });

  it('applies a job finished strictly after the watermark', () => {
    expect(passesWatermark(T20, T12)).toBe(true);
  });

  it('rejects a job finished at or before the watermark', () => {
    expect(passesWatermark(T10, T12)).toBe(false);
    expect(passesWatermark(T12, T12)).toBe(false); // equal is not "after"
  });

  it('compares as UTC instants across timezone spellings (no client clock)', () => {
    // Same instant, different offset spelling: +00:00 vs a −05:00 wall time.
    expect(
      passesWatermark('2026-07-03T12:00:01Z', '2026-07-03T07:00:00-05:00')
    ).toBe(true);
  });

  it('resurrects (attaches) on a missing finishedAt or unparseable instant', () => {
    expect(passesWatermark(undefined, T12)).toBe(true);
    expect(passesWatermark('', T12)).toBe(true);
    expect(passesWatermark('not-a-date', T12)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sourceInScene — the scene-state idempotency key {jobId, outputId} (Chunk 5).
// ---------------------------------------------------------------------------

describe('sourceInScene', () => {
  const target = { jobId: 'j1', outputId: 'seg' };

  it('true when the exact {jobId, outputId} group is already in the scene', () => {
    expect(sourceInScene([{ jobId: 'j1', outputId: 'seg' }], target)).toBe(
      true
    );
  });

  it('false when absent, and undefined (hand-painted) entries never match', () => {
    expect(sourceInScene([], target)).toBe(false);
    expect(sourceInScene([undefined, undefined], target)).toBe(false);
    // A different job / output is not a match.
    expect(sourceInScene([{ jobId: 'j2', outputId: 'seg' }], target)).toBe(
      false
    );
    expect(sourceInScene([{ jobId: 'j1', outputId: 'other' }], target)).toBe(
      false
    );
  });
});
