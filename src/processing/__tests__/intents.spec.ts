import { describe, expect, it } from 'vitest';

import {
  resultIntentSchema,
  vocabularyVersion,
} from '@/src/processing/intents';

describe('result intent vocabulary', () => {
  it('exports vocabulary version 1', () => {
    expect(vocabularyVersion).toBe(1);
  });

  const fileRef = { url: 'https://example/out.nrrd', name: 'out.nrrd' };

  describe.each(['add-base-image', 'add-layer', 'restore-state', 'download'])(
    'file-only intent %s',
    (intent) => {
      it('parses a valid sample', () => {
        const parsed = resultIntentSchema.parse({ intent, ...fileRef });
        expect(parsed).toEqual({ intent, ...fileRef });
      });

      it('rejects a sample missing the file name', () => {
        expect(() =>
          resultIntentSchema.parse({ intent, url: fileRef.url })
        ).toThrow();
      });
    }
  );

  describe('attach-segment-group', () => {
    const segments = [
      { value: 1, name: 'liver', color: [255, 0, 0, 255] as const },
      {
        value: 2,
        name: 'tumor',
        color: [0, 255, 0, 255] as const,
        visible: false,
      },
    ];

    it('parses a valid sample carrying segment descriptors', () => {
      const parsed = resultIntentSchema.parse({
        intent: 'attach-segment-group',
        ...fileRef,
        segments,
      });
      expect(parsed).toEqual({
        intent: 'attach-segment-group',
        ...fileRef,
        segments,
      });
    });

    it('rejects a sample missing its segments field', () => {
      expect(() =>
        resultIntentSchema.parse({ intent: 'attach-segment-group', ...fileRef })
      ).toThrow();
    });

    it('rejects a malformed segment color', () => {
      expect(() =>
        resultIntentSchema.parse({
          intent: 'attach-segment-group',
          ...fileRef,
          segments: [{ value: 1, name: 'liver', color: [255, 0, 0] }],
        })
      ).toThrow();
    });
  });

  it('rejects an unknown intent kind', () => {
    expect(() =>
      resultIntentSchema.parse({ intent: 'add-polygon', ...fileRef })
    ).toThrow();
  });
});
