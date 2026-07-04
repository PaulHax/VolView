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
