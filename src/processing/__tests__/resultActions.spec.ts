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
  it('prefers the validated intent over role', () => {
    // The facade emits a consistent role+intent; resultToIntent prefers intent.
    expect(
      naturalIntent(result({ role: 'segmentGroup', intent: 'add-layer' }))
    ).toBe('add-layer');
  });

  it('falls back to role translation when no intent is present', () => {
    expect(naturalIntent(result({ role: 'segmentGroup' }))).toBe(
      'attach-segment-group'
    );
  });

  it('treats an unset role/intent as add-base-image', () => {
    expect(naturalIntent(result())).toBe('add-base-image');
  });
});

describe('canOpen', () => {
  it('hides Open for a download-only output (the role-omitted facade case)', () => {
    // The facade omits `role` for non-labelmaps but always emits `intent`, so a
    // non-image download output arrives as { intent: 'download' } with no role.
    // Role-only gating wrongly offered Open; intent gating must not.
    expect(canOpen(result({ name: 'report.csv', intent: 'download' }))).toBe(
      false
    );
  });

  it('shows Open for a base image', () => {
    expect(canOpen(result({ intent: 'add-base-image' }))).toBe(true);
  });

  it('shows Open for a segment group (matches prior behavior)', () => {
    expect(
      canOpen(result({ role: 'segmentGroup', intent: 'attach-segment-group' }))
    ).toBe(true);
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
    expect(canBeLayer(result({ intent: 'attach-segment-group' }))).toBe(false);
  });

  it('offers the layer action for an image base output, not a non-image one', () => {
    expect(canBeLayer(result({ name: 'vol.nrrd' }))).toBe(true);
    expect(canBeLayer(result({ name: 'notes.txt' }))).toBe(false);
  });
});

describe('canBeSegmentGroup', () => {
  it('is true for a segment-group result', () => {
    expect(canBeSegmentGroup(result({ intent: 'attach-segment-group' }))).toBe(
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

  it('lets an image base output seed a segment group, not a non-image one', () => {
    expect(canBeSegmentGroup(result({ name: 'vol.nrrd' }))).toBe(true);
    expect(canBeSegmentGroup(result({ name: 'notes.txt' }))).toBe(false);
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
