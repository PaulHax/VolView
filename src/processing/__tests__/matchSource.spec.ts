import { describe, expect, it } from 'vitest';

import { matchActiveSource } from '@/src/processing/matchSource';
import type { LoadedProcessingSource, SourceRef } from '@/src/processing/types';

const ref = (s: string) => s as SourceRef;

const dicomSource = (
  uid: string,
  overrides: Partial<LoadedProcessingSource> = {}
): LoadedProcessingSource => ({
  datasetId: `item-${uid}`,
  name: `Series ${uid}`,
  sourceRef: ref(`series:folder:${uid}`),
  matchKey: { kind: 'series', seriesInstanceUID: uid },
  ...overrides,
});

const nameSource = (
  name: string,
  overrides: Partial<LoadedProcessingSource> = {}
): LoadedProcessingSource => ({
  datasetId: `item-${name}`,
  name,
  sourceRef: ref(`file:${name}`),
  matchKey: { kind: 'name', name },
  ...overrides,
});

describe('matchActiveSource', () => {
  it('binds the active DICOM series, not sources[0]', () => {
    const sources = [dicomSource('1.2.3'), dicomSource('4.5.6')];
    const match = matchActiveSource(sources, { seriesInstanceUID: '4.5.6' });
    expect(match).toBe(sources[1]);
    expect(match?.sourceRef).toBe('series:folder:4.5.6');
  });

  it('matches a non-DICOM volume by name', () => {
    const sources = [nameSource('brain.nii.gz'), nameSource('mask.nrrd')];
    const match = matchActiveSource(sources, { name: 'mask.nrrd' });
    expect(match).toBe(sources[1]);
    expect(match?.sourceRef).toBe('file:mask.nrrd');
  });

  it('returns undefined when nothing matches (caller refuses to bind)', () => {
    const sources = [dicomSource('1.2.3'), nameSource('brain.nii.gz')];
    expect(
      matchActiveSource(sources, {
        seriesInstanceUID: 'unknown',
        name: 'nope.nrrd',
      })
    ).toBeUndefined();
  });

  it('prefers the SeriesInstanceUID over name for DICOM volumes', () => {
    // A non-DICOM source happens to share the active series' display name; the
    // UID match must win and must not be fooled by the colliding name.
    const series = dicomSource('1.2.3', { name: 'Scan' });
    const collidingName = nameSource('Scan');
    const match = matchActiveSource([collidingName, series], {
      seriesInstanceUID: '1.2.3',
      name: 'Scan',
    });
    expect(match).toBe(series);
  });

  it('does not match a name against a DICOM series description', () => {
    // For a non-DICOM active volume (no UID) the name must only bind a
    // name-keyed source, never a series-keyed one that reuses the string.
    const series = dicomSource('1.2.3', {
      name: 'shared',
      matchKey: {
        kind: 'series',
        seriesInstanceUID: '1.2.3',
        seriesDescription: 'shared',
      },
    });
    expect(matchActiveSource([series], { name: 'shared' })).toBeUndefined();
  });

  it('falls back to the plain name field for pre-matchKey sources', () => {
    const legacy: LoadedProcessingSource = {
      datasetId: 'i1',
      name: 'legacy.nrrd',
      sourceRef: ref('file:legacy'),
    };
    expect(matchActiveSource([legacy], { name: 'legacy.nrrd' })).toBe(legacy);
  });

  it('returns undefined for empty identity', () => {
    const sources = [dicomSource('1.2.3'), nameSource('brain.nii.gz')];
    expect(matchActiveSource(sources, {})).toBeUndefined();
  });
});
