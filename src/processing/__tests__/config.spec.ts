import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { config as baseConfig } from '@/src/io/import/configJson';
import {
  withProcessingConfig,
  applyProcessingConfig,
} from '@/src/processing/config';
import {
  PROCESSING_ORIGINS_PATH,
  resetAllowedOriginsCache,
} from '@/src/io/originGate';
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

// Serve (or refuse) the deployment-controlled same-origin allow-list. `null`
// simulates the file not served (the demo / same-origin-only posture).
const stubAllowList = (origins: string[] | null) => {
  resetAllowedOriginsCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes(PROCESSING_ORIGINS_PATH)) {
        return origins === null
          ? { ok: false, status: 404 }
          : { ok: true, status: 200, json: async () => ({ origins }) };
      }
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch
  );
};

describe('processing config provider origins', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    stubAllowList(null); // default: no allow-list served ⇒ same-origin only
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetAllowedOriginsCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts same-origin providers with zero config', async () => {
    const providers = useProvidersStore();

    await applyProcessingConfig(processingConfig('/volview_processing'));

    expect(providers.providerCount).toBe(1);
    expect(providers.configs.get('analysis-provider')?.baseUrl).toBe(
      '/volview_processing'
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects foreign-origin providers by default', async () => {
    const providers = useProvidersStore();

    await applyProcessingConfig(
      processingConfig('https://analysis.example/api')
    );

    expect(providers.providerCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'origin "https://analysis.example" is not allowed'
      )
    );
  });

  it('accepts allow-listed foreign-origin providers', async () => {
    const providers = useProvidersStore();
    stubAllowList(['https://analysis.example']);

    await applyProcessingConfig(
      processingConfig('https://analysis.example/api')
    );

    expect(providers.providerCount).toBe(1);
    expect(providers.configs.get('analysis-provider')?.baseUrl).toBe(
      'https://analysis.example/api'
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a scheme-less allow-list entry as an https origin', async () => {
    const providers = useProvidersStore();
    stubAllowList(['analysis.example']);

    await applyProcessingConfig(
      processingConfig('https://analysis.example/api')
    );

    expect(providers.providerCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the allow-list only from the same-origin source, never from config (self-extension invariant)', async () => {
    const providers = useProvidersStore();
    // The deployment serves no allow-list. `applyProcessingConfig` reads
    // origins solely from the fetched same-origin source, so a cross-origin
    // provider cannot be blessed by anything the config carries.
    stubAllowList(null);

    await applyProcessingConfig(
      processingConfig('https://analysis.example/api')
    );

    expect(providers.providerCount).toBe(0);
    // The allow-list fetch targets the fixed same-origin path — not any origin
    // the config could name.
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(PROCESSING_ORIGINS_PATH);
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
