import { describe, expect, it } from 'vitest';

import { hits, isTest, sourceFiles } from '@/src/__tests__/sourceAudit';

// Phrases that tie segment order to drawing order rather than to picking,
// shortcuts or export.
const DEPTH_PROMISE =
  /render(s|ing)?\s+(in front|on top|above|depth)|(in front|on top|above)\s+of\s+(the\s+)?(other|earlier|later|sibling)\s+segments/i;

describe('what registry order is documented to control', () => {
  it('promises no drawing order anywhere the user can read it', () => {
    const files = sourceFiles(
      import.meta.url,
      'src/segmentation',
      'src/components'
    ).filter((rel) => !isTest(rel));

    expect(hits(files, DEPTH_PROMISE)).toEqual([]);
  });
});
