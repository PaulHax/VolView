// Config-by-shape + origin gate, exercised through the real import pipeline
// (chunk 2). There is no channel distinction any more: a provider config
// registers iff its origin passes the runtime gate, no matter how it arrived
// (a `config`-role uri, a plain `urls=` file, or a dropped file).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { PROCESSING_ORIGINS_PATH } from '@/src/io/originGate';
import type { DataSource } from '@/src/io/import/dataSource';

type ProviderConfig = {
  id: string;
  label: string;
  baseUrl: string;
};

const configWithProvider = (
  baseUrl: string,
  extraSections: Record<string, unknown> = {}
) => ({
  processing: {
    providers: [
      {
        id: 'injected-provider',
        label: 'Injected',
        baseUrl,
      } satisfies ProviderConfig,
    ],
  },
  ...extraSections,
});

const jsonFile = (obj: unknown, name = 'config.json') =>
  new File([JSON.stringify(obj)], name, { type: 'application/json' });

// The real fetch, captured before any stubbing — non-origins requests (e.g.
// itk-wasm's emscripten module load, pulled in by importing the full pipeline)
// must still go through so the import graph initializes.
const realFetch = globalThis.fetch;

// Serve (`origins`) or refuse (`null`) the deployment allow-list, delegating
// everything else to the real fetch.
const stubAllowList = (origins: string[] | null) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(PROCESSING_ORIGINS_PATH)) {
        return origins === null
          ? { ok: false, status: 404 }
          : { ok: true, status: 200, json: async () => ({ origins }) };
      }
      return realFetch(input, init);
    }) as unknown as typeof fetch
  );
};

describe('processing config injection (config-by-shape, origin-gated)', () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers a same-origin provider from a plain urls= file (no config role, no allow-list)', async () => {
    stubAllowList(null);
    const [{ importDataSources }, { uriToDataSource }, { useProvidersStore }] =
      await Promise.all([
        import('@/src/io/import/importDataSources'),
        import('@/src/io/import/dataSource'),
        import('@/src/store/providers'),
      ]);

    // No 'config' role on the parent — the channel that was previously refused.
    const dataSource: DataSource = {
      type: 'file',
      file: jsonFile(
        configWithProvider('/api/v1/folder/abc/volview_processing')
      ),
      fileType: 'application/json',
      parent: uriToDataSource(
        'http://localhost:3000/data/some-file.json',
        'some-file.json'
      ),
    };

    await importDataSources([dataSource]);

    expect(useProvidersStore().providerCount).toBe(1);
  });

  it('drops a cross-origin provider but still applies the rest of the config (demo posture)', async () => {
    stubAllowList(null); // demo serves no allow-list
    const [
      { importDataSources },
      { uriToDataSource },
      { useProvidersStore },
      { useWindowingStore },
    ] = await Promise.all([
      import('@/src/io/import/importDataSources'),
      import('@/src/io/import/dataSource'),
      import('@/src/store/providers'),
      import('@/src/store/view-configs/windowing'),
    ]);

    const dataSource: DataSource = {
      type: 'file',
      file: jsonFile(
        configWithProvider('https://analysis.example/api', {
          windowing: { level: 40, width: 400 },
        })
      ),
      fileType: 'application/json',
      parent: uriToDataSource(
        'https://demo.example/user-supplied.json',
        'user-supplied.json'
      ),
    };

    await importDataSources([dataSource]);

    // Cross-origin provider is inert; the non-processing section still applies.
    expect(useProvidersStore().providerCount).toBe(0);
    expect(useWindowingStore().runtimeConfigWindowLevel).toEqual({
      level: 40,
      width: 400,
    });
  });

  it('registers a cross-origin provider when the deployment allow-list names its origin', async () => {
    stubAllowList(['https://analysis.example']);
    const [{ importDataSources }, { uriToDataSource }, { useProvidersStore }] =
      await Promise.all([
        import('@/src/io/import/importDataSources'),
        import('@/src/io/import/dataSource'),
        import('@/src/store/providers'),
      ]);

    const dataSource: DataSource = {
      type: 'file',
      file: jsonFile(configWithProvider('https://analysis.example/api')),
      fileType: 'application/json',
      parent: uriToDataSource(
        'https://demo.example/user-supplied.json',
        'user-supplied.json'
      ),
    };

    await importDataSources([dataSource]);

    expect(useProvidersStore().providerCount).toBe(1);
  });

  it('does not let a config self-extend the allow-list (near-miss on the smuggled key)', async () => {
    stubAllowList(null);
    const [{ importDataSources }, { uriToDataSource }, { useProvidersStore }] =
      await Promise.all([
        import('@/src/io/import/importDataSources'),
        import('@/src/io/import/dataSource'),
        import('@/src/store/providers'),
      ]);

    // A config that both points a provider cross-origin AND tries to bless that
    // origin from within the config. The `allowedOrigins` key is unknown at the
    // top level, so the whole config is rejected as config — the provider never
    // registers.
    const dataSource: DataSource = {
      type: 'file',
      file: jsonFile(
        configWithProvider('https://analysis.example/api', {
          allowedOrigins: ['https://analysis.example'],
        })
      ),
      fileType: 'application/json',
      parent: uriToDataSource(
        'https://attacker.example/self-extend.json',
        'self-extend.json'
      ),
    };

    await importDataSources([dataSource]).catch(() => undefined);

    expect(useProvidersStore().providerCount).toBe(0);
  });
});

describe('multiple configs merge at section granularity, last-wins (in-flight decision)', () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies each recognized config in order; a later section overwrites an earlier one, others coexist', async () => {
    const [
      { applyPreStateConfig, config },
      { useWindowingStore },
      { useSegmentGroupStore },
    ] = await Promise.all([
      import('@/src/io/import/configJson'),
      import('@/src/store/view-configs/windowing'),
      import('@/src/store/segmentGroups'),
    ]);

    // Config A sets windowing.
    await applyPreStateConfig(
      config.parse({ windowing: { level: 40, width: 400 } })
    );
    // Config B touches a DIFFERENT section — A's windowing must survive.
    await applyPreStateConfig(
      config.parse({ io: { segmentGroupSaveFormat: 'nrrd' } })
    );
    // Config C revisits windowing — last-wins for that section.
    await applyPreStateConfig(
      config.parse({ windowing: { level: 80, width: 800 } })
    );

    expect(useWindowingStore().runtimeConfigWindowLevel).toEqual({
      level: 80,
      width: 800,
    });
    expect(useSegmentGroupStore().saveFormat).toBe('nrrd');
  });
});

describe('config near-miss is surfaced before falling through to data', () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs + notifies naming the offending key, and does not apply the config', async () => {
    const [
      { default: handleConfig },
      { useMessageStore },
      { useWindowingStore },
      { Skip },
    ] = await Promise.all([
      import('@/src/io/import/processors/handleConfig'),
      import('@/src/store/messages'),
      import('@/src/store/view-configs/windowing'),
      import('@/src/utils/evaluateChain'),
    ]);

    const dataSource: DataSource = {
      type: 'file',
      file: jsonFile({
        windowing: { level: 40, width: 400 },
        futureSection: { enabled: true }, // newer config on an older client
      }),
      fileType: 'application/json',
    };

    const result = await handleConfig(dataSource);

    // Falls through to data import rather than being consumed as config.
    expect(result).toBe(Skip);

    // The rejection is surfaced (user-visible notification naming the key).
    const messages = useMessageStore().messages;
    const nearMiss = messages.find(
      (m) => m.title === 'Unrecognized configuration'
    );
    expect(nearMiss).toBeDefined();
    expect(nearMiss?.options.details).toContain('futureSection');

    // And the config was NOT applied (no partial-apply of the known section).
    expect(useWindowingStore().runtimeConfigWindowLevel).toBeUndefined();
  });
});
