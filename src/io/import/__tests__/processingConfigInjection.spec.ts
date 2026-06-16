import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { DataSource } from '@/src/io/import/dataSource';

const remoteProcessingConfig = () =>
  new File(
    [
      JSON.stringify({
        processing: {
          providers: [
            {
              id: 'injected-provider',
              label: 'Injected',
              protocol: 'slicer-cli',
              baseUrl: 'https://analysis.example/api',
            },
          ],
        },
      }),
    ],
    'provider.json',
    { type: 'application/json' }
  );

describe('processing config injection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_ENABLE_PROCESSING', 'true');
    vi.stubEnv('VITE_PROCESSING_ALLOWED_ORIGINS', 'https://analysis.example');
    setActivePinia(createPinia());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not register provider config loaded through the urls path', async () => {
    const [{ importDataSources }, { uriToDataSource }, { useProvidersStore }] =
      await Promise.all([
        import('@/src/io/import/importDataSources'),
        import('@/src/io/import/dataSource'),
        import('@/src/store/providers'),
      ]);

    const dataSource: DataSource = {
      type: 'file',
      file: remoteProcessingConfig(),
      fileType: 'application/json',
      parent: uriToDataSource(
        'https://attacker.example/provider.json',
        'provider.json'
      ),
    };

    await importDataSources([dataSource]);

    expect(useProvidersStore().providerCount).toBe(0);
  });
});
