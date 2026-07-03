// Config-by-shape recognition (D9, chunk 2). A JSON is recognized as config
// purely by shape (no channel distinction). Recognition is strict on the trust
// boundary: only known top-level section keys ⇒ config; a known key polluted by
// any unknown top-level key ⇒ near-miss (surfaced, imported as data); no config
// signal ⇒ data. The confusion fixture is the standing guard that the config
// and data schemas don't overlap.

import { describe, it, expect } from 'vitest';
import { recognizeConfig } from '@/src/io/import/configJson';

describe('config-by-shape recognition', () => {
  it('recognizes a JSON with only known top-level keys as config', async () => {
    const result = await recognizeConfig({
      windowing: { level: 40, width: 400 },
    });
    expect(result.kind).toBe('config');
    if (result.kind === 'config') {
      expect(result.config.windowing).toEqual({ level: 40, width: 400 });
    }
  });

  it('recognizes a processing-only config (registration gated later by origin)', async () => {
    const result = await recognizeConfig({
      processing: {
        providers: [
          {
            id: 'p',
            label: 'Analysis',
            protocol: 'slicer-cli',
            baseUrl: '/volview_processing',
          },
        ],
      },
    });
    expect(result.kind).toBe('config');
  });

  it('rejects a config-shaped JSON with an unknown top-level key as a near-miss', async () => {
    const result = await recognizeConfig({
      windowing: { level: 40, width: 400 },
      futureSection: { enabled: true }, // newer config on an older client
    });
    expect(result.kind).toBe('near-miss');
    if (result.kind === 'near-miss') {
      expect(result.unknownKeys).toEqual(['futureSection']);
    }
  });

  it('treats a JSON with no known top-level keys as data (silent)', async () => {
    const result = await recognizeConfig({
      vertices: [[0, 0, 0]],
      faces: [[0, 1, 2]],
    });
    expect(result.kind).toBe('data');
  });

  it('treats non-objects and empty objects as data', async () => {
    expect((await recognizeConfig([1, 2, 3])).kind).toBe('data');
    expect((await recognizeConfig('a string')).kind).toBe('data');
    expect((await recognizeConfig(42)).kind).toBe('data');
    expect((await recognizeConfig(null)).kind).toBe('data');
    expect((await recognizeConfig({})).kind).toBe('data');
  });

  // The standing guard: a data JSON crafted to ALSO look like config (it carries
  // a valid `labels` config subset) must NOT be read as config. Under lenient
  // parsing the stray `labels` key would have been applied; strict recognition
  // rejects it because the data keys are unknown top-level keys.
  it('confusion fixture: a data JSON that also validates as config imports as data, not config', async () => {
    const result = await recognizeConfig({
      labels: { defaultLabels: { tumor: { color: '#ff0000' } } },
      vertices: [[0, 0, 0]],
      cells: [[0, 1, 2]],
    });
    expect(result.kind).not.toBe('config');
    expect(result.kind).toBe('near-miss');
    if (result.kind === 'near-miss') {
      expect(result.unknownKeys).toContain('vertices');
      expect(result.unknownKeys).toContain('cells');
    }
  });

  // Self-extension invariant at the recognition layer: a config that tries to
  // carry its own allow-list has an unknown top-level key, so the whole thing is
  // rejected as config — a config can never allow-list itself.
  it('rejects a config that tries to smuggle an allow-list', async () => {
    const result = await recognizeConfig({
      processing: {
        providers: [
          {
            id: 'p',
            label: 'Analysis',
            protocol: 'slicer-cli',
            baseUrl: 'https://analysis.example/api',
          },
        ],
      },
      allowedOrigins: ['https://analysis.example'],
    });
    expect(result.kind).toBe('near-miss');
    if (result.kind === 'near-miss') {
      expect(result.unknownKeys).toEqual(['allowedOrigins']);
    }
  });
});
