import { describe, expect, it } from 'vitest';

import { resultToIntent } from '@/src/processing/adapters/slicer-cli/resultToIntent';
import { resultIntentSchema } from '@/src/processing/intents';
import type { ProcessingResult } from '@/src/processing/types';

const base = (overrides: Partial<ProcessingResult> = {}): ProcessingResult => ({
  id: 'r1',
  name: 'out.nrrd',
  url: 'https://example/out.nrrd',
  ...overrides,
});

describe('resultToIntent', () => {
  it('maps role "segmentGroup" → attach-segment-group, carrying segments', () => {
    const segments = [
      { value: 1, name: 'liver', color: [255, 0, 0, 255] as const },
    ];
    const intent = resultToIntent(base({ role: 'segmentGroup', segments }));
    expect(intent).toEqual({
      intent: 'attach-segment-group',
      url: 'https://example/out.nrrd',
      name: 'out.nrrd',
      segments,
    });
    // Translation must produce a valid vocabulary entry.
    expect(() => resultIntentSchema.parse(intent)).not.toThrow();
  });

  it('defaults missing segments to an empty array', () => {
    const intent = resultToIntent(base({ role: 'segmentGroup' }));
    expect(intent).toMatchObject({
      intent: 'attach-segment-group',
      segments: [],
    });
    expect(() => resultIntentSchema.parse(intent)).not.toThrow();
  });

  it('maps role "layer" → add-layer', () => {
    expect(resultToIntent(base({ role: 'layer' })).intent).toBe('add-layer');
  });

  it('maps role "state" → restore-state', () => {
    expect(resultToIntent(base({ role: 'state' })).intent).toBe(
      'restore-state'
    );
  });

  it('maps role "download" → download', () => {
    expect(resultToIntent(base({ role: 'download' })).intent).toBe('download');
  });

  it('maps role "base" → add-base-image', () => {
    expect(resultToIntent(base({ role: 'base' })).intent).toBe(
      'add-base-image'
    );
  });

  it('maps unset role → add-base-image', () => {
    expect(resultToIntent(base()).intent).toBe('add-base-image');
  });

  it('always carries the result file reference', () => {
    const intent = resultToIntent(base({ role: 'layer' }));
    expect(intent).toMatchObject({
      url: 'https://example/out.nrrd',
      name: 'out.nrrd',
    });
  });
});

describe('resultToIntent — prefers a valid provider intent (item 3.1)', () => {
  it('prefers a present, valid intent over the role translation', () => {
    // role would translate to add-base-image; the provider intent wins.
    const intent = resultToIntent(base({ role: 'base', intent: 'download' }));
    expect(intent).toEqual({
      intent: 'download',
      url: 'https://example/out.nrrd',
      name: 'out.nrrd',
    });
    expect(() => resultIntentSchema.parse(intent)).not.toThrow();
  });

  it('honors a provider intent unreachable from role alone (download, unset role)', () => {
    // Unset role translates to add-base-image; the facade marks a non-image
    // file as download — only the preferred intent expresses it.
    expect(resultToIntent(base({ intent: 'download' })).intent).toBe(
      'download'
    );
  });

  it('carries segments when the provider intent is attach-segment-group', () => {
    const segments = [
      { value: 1, name: 'liver', color: [255, 0, 0, 255] as const },
    ];
    const intent = resultToIntent(
      base({ intent: 'attach-segment-group', segments })
    );
    expect(intent).toEqual({
      intent: 'attach-segment-group',
      url: 'https://example/out.nrrd',
      name: 'out.nrrd',
      segments,
    });
  });

  it('drops segments on an intent that does not declare them', () => {
    const intent = resultToIntent(
      base({
        intent: 'add-base-image',
        segments: [{ value: 1, name: 'liver', color: [1, 2, 3, 4] as const }],
      })
    );
    expect(intent).toEqual({
      intent: 'add-base-image',
      url: 'https://example/out.nrrd',
      name: 'out.nrrd',
    });
  });

  it('falls back to role translation for an invalid intent string', () => {
    const intent = resultToIntent(base({ intent: 'bogus', role: 'layer' }));
    expect(intent.intent).toBe('add-layer');
    expect(() => resultIntentSchema.parse(intent)).not.toThrow();
  });

  it('falls back to role translation when intent is absent', () => {
    expect(resultToIntent(base({ role: 'segmentGroup' })).intent).toBe(
      'attach-segment-group'
    );
  });
});
