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
