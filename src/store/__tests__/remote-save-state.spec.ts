// One gate for all configured egress (chunk 2): the remote-save target passes
// the SAME runtime origin gate as processing providers. A disallowed origin
// never reaches `saveUrl`, so the surface (gated on `saveUrl !== ''`) and its
// egress both stay inert.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('@/src/utils/fetch', () => ({
  $fetch: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/src/io/state-file/serialize', () => ({
  serialize: vi
    .fn()
    .mockResolvedValue(new Blob(['x'], { type: 'application/zip' })),
}));

import useRemoteSaveStateStore from '@/src/store/remote-save-state';
import {
  PROCESSING_ORIGINS_PATH,
  resetAllowedOriginsCache,
} from '@/src/io/originGate';
import { $fetch } from '@/src/utils/fetch';

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

describe('remote save passes the shared origin gate', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked($fetch).mockClear();
  });

  afterEach(() => {
    resetAllowedOriginsCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts a same-origin save URL with zero config', async () => {
    stubAllowList(null);
    const store = useRemoteSaveStateStore();
    const url = `${window.location.origin}/api/session/save`;

    await store.setSaveUrl(url);

    expect(store.saveUrl).toBe(url);
  });

  it('refuses a cross-origin save URL when no allow-list is served', async () => {
    stubAllowList(null);
    const store = useRemoteSaveStateStore();

    await store.setSaveUrl('https://attacker.example/save');

    expect(store.saveUrl).toBe('');
  });

  it('accepts a cross-origin save URL that the deployment allow-list names', async () => {
    stubAllowList(['https://backup.example']);
    const store = useRemoteSaveStateStore();

    await store.setSaveUrl('https://backup.example/save');

    expect(store.saveUrl).toBe('https://backup.example/save');
  });

  it('performs no egress to a refused save target', async () => {
    stubAllowList(null);
    const store = useRemoteSaveStateStore();

    await store.setSaveUrl('https://attacker.example/save');
    await store.saveState();

    expect($fetch).not.toHaveBeenCalled();
  });
});
