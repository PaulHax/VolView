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
});
