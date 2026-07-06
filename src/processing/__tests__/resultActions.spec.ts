import { describe, expect, it } from 'vitest';

import {
  canOpen,
  canBeLayer,
  canBeSegmentGroup,
  looksLikeImage,
  naturalIntent,
} from '@/src/processing/resultActions';
import type { ProcessingResult } from '@/src/processing/types';

const result = (
  overrides: Partial<ProcessingResult> = {}
): ProcessingResult => ({
  id: 'r1',
  name: 'output.nii.gz',
  url: 'https://host/file/r1/download',
  ...overrides,
});

describe('naturalIntent', () => {
  it('consumes the facade-emitted intent directly', () => {
    // The client reads the neutral `intent` and applies it verbatim.
    expect(naturalIntent(result({ intent: 'add-layer' }))).toBe('add-layer');
  });

  it('resolves a labelmap output to add-segment-group', () => {
    expect(naturalIntent(result({ intent: 'add-segment-group' }))).toBe(
      'add-segment-group'
    );
  });

  it('degrades a result with no intent to the download floor', () => {
    // Facade always emits `intent` now; a missing one fails closed to download
    // rather than falling back to a role (which no longer exists).
    expect(naturalIntent(result())).toBe('download');
  });

  it('degrades an unknown intent name to download', () => {
    expect(naturalIntent(result({ intent: 'add-polygon' }))).toBe('download');
  });
});

describe('canOpen', () => {
  it('hides Open for a download-only output', () => {
    expect(canOpen(result({ name: 'report.csv', intent: 'download' }))).toBe(
      false
    );
  });

  it('shows Open for a base image', () => {
    expect(canOpen(result({ intent: 'add-base-image' }))).toBe(true);
  });

  it('shows Open for a segment group', () => {
    expect(canOpen(result({ intent: 'add-segment-group' }))).toBe(true);
  });
});

describe('canBeLayer', () => {
  it('is true for an explicit layer result', () => {
    expect(canBeLayer(result({ intent: 'add-layer' }))).toBe(true);
  });

  it('is false for download / restore-state / segment-group results', () => {
    expect(canBeLayer(result({ intent: 'download', name: 'x.csv' }))).toBe(
      false
    );
    expect(canBeLayer(result({ intent: 'restore-state' }))).toBe(false);
    expect(canBeLayer(result({ intent: 'add-segment-group' }))).toBe(false);
  });

  it('offers the layer action for an image base output, not a non-image one', () => {
    expect(
      canBeLayer(result({ intent: 'add-base-image', name: 'vol.nrrd' }))
    ).toBe(true);
    expect(
      canBeLayer(result({ intent: 'add-base-image', name: 'notes.txt' }))
    ).toBe(false);
  });
});

describe('canBeSegmentGroup', () => {
  it('is true for a segment-group result', () => {
    expect(canBeSegmentGroup(result({ intent: 'add-segment-group' }))).toBe(
      true
    );
  });

  it('is false for layer / download / restore-state results', () => {
    expect(canBeSegmentGroup(result({ intent: 'add-layer' }))).toBe(false);
    expect(
      canBeSegmentGroup(result({ intent: 'download', name: 'x.csv' }))
    ).toBe(false);
    expect(canBeSegmentGroup(result({ intent: 'restore-state' }))).toBe(false);
  });

  it('does not offer segment-group action for base-image outputs', () => {
    expect(
      canBeSegmentGroup(result({ intent: 'add-base-image', name: 'vol.nrrd' }))
    ).toBe(false);
    expect(
      canBeSegmentGroup(result({ intent: 'add-base-image', name: 'notes.txt' }))
    ).toBe(false);
  });
});

describe('looksLikeImage', () => {
  it('recognizes image-like mime types', () => {
    expect(
      looksLikeImage(result({ name: 'no-ext', mimeType: 'application/dicom' }))
    ).toBe(true);
  });

  it('recognizes image-like extensions case-insensitively', () => {
    expect(looksLikeImage(result({ name: 'SCAN.NII.GZ' }))).toBe(true);
    expect(looksLikeImage(result({ name: 'mask.nrrd' }))).toBe(true);
  });

  it('rejects non-image files', () => {
    expect(looksLikeImage(result({ name: 'report.csv' }))).toBe(false);
  });
});
