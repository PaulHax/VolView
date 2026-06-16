import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { config as baseConfig } from '@/src/io/import/configJson';
import {
  withProcessingConfig,
  applyProcessingConfig,
} from '@/src/processing/config';
import { useProvidersStore } from '@/src/store/providers';
import type { Config } from '@/src/io/import/configJson';

function processingConfig(baseUrl: string, id = 'analysis-provider'): Config {
  return withProcessingConfig(baseConfig).parse({
    processing: {
      providers: [
        {
          id,
          label: 'Analysis',
          protocol: 'slicer-cli',
          baseUrl,
        },
      ],
    },
  }) as Config;
}

describe('processing config provider origins', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubEnv('VITE_PROCESSING_ALLOWED_ORIGINS', '');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('accepts same-origin providers', () => {
    const providers = useProvidersStore();

    applyProcessingConfig(processingConfig('/volview_processing'));

    expect(providers.providerCount).toBe(1);
    expect(providers.configs.get('analysis-provider')?.baseUrl).toBe(
      '/volview_processing'
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects foreign-origin providers by default', () => {
    const providers = useProvidersStore();

    applyProcessingConfig(processingConfig('https://analysis.example/api'));

    expect(providers.providerCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'origin "https://analysis.example" is not allowed'
      )
    );
  });

  it('accepts allow-listed foreign-origin providers', () => {
    const providers = useProvidersStore();
    vi.stubEnv('VITE_PROCESSING_ALLOWED_ORIGINS', 'https://analysis.example');

    applyProcessingConfig(processingConfig('https://analysis.example/api'));

    expect(providers.providerCount).toBe(1);
    expect(providers.configs.get('analysis-provider')?.baseUrl).toBe(
      'https://analysis.example/api'
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a scheme-less allow-list entry as an https origin', () => {
    const providers = useProvidersStore();
    vi.stubEnv('VITE_PROCESSING_ALLOWED_ORIGINS', 'analysis.example');

    applyProcessingConfig(processingConfig('https://analysis.example/api'));

    expect(providers.providerCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('loadedSources match keys (item 3.6 wire validation)', () => {
  const parseSources = (loadedSources: unknown[]) =>
    (
      withProcessingConfig(baseConfig).parse({
        processing: {
          providers: [
            {
              id: 'p',
              label: 'Analysis',
              protocol: 'slicer-cli',
              baseUrl: '/volview_processing',
              context: { loadedSources },
            },
          ],
        },
      }) as Config & {
        processing: {
          providers: Array<{
            context: {
              loadedSources: Array<{ name: string; matchKey?: unknown }>;
            };
          }>;
        };
      }
    ).processing.providers[0].context.loadedSources;

  it('preserves a valid series match key', () => {
    const [src] = parseSources([
      {
        datasetId: 'i1',
        name: 'Brain',
        sourceRef: 'series:f:1.2.3',
        matchKey: {
          kind: 'series',
          seriesInstanceUID: '1.2.3',
          seriesDescription: 'Brain',
        },
      },
    ]);
    expect(src.matchKey).toEqual({
      kind: 'series',
      seriesInstanceUID: '1.2.3',
      seriesDescription: 'Brain',
    });
  });

  it('preserves a valid name match key', () => {
    const [src] = parseSources([
      {
        datasetId: 'i1',
        name: 'mask.nrrd',
        sourceRef: 'file:1',
        matchKey: { kind: 'name', name: 'mask.nrrd' },
      },
    ]);
    expect(src.matchKey).toEqual({ kind: 'name', name: 'mask.nrrd' });
  });

  it('degrades a malformed match key to undefined without failing the parse', () => {
    const [src] = parseSources([
      {
        datasetId: 'i1',
        name: 'mystery',
        sourceRef: 'file:1',
        matchKey: { kind: 'bogus' },
      },
    ]);
    // The source still loads; it just cannot be matched by key.
    expect(src.matchKey).toBeUndefined();
    expect(src.name).toBe('mystery');
  });
});
