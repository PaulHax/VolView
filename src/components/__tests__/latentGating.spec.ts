// Chunk 1 (one-build collapse) acceptance: processing and remote-save code ship
// in every build but stay latent = inert until a runtime signal turns them on.
// These tests pin the two runtime gates that replace the deleted build flags:
//   - Analysis tab   ⇒ ModulePanel reveals it only when `providerCount > 0`.
//   - Remote save     ⇒ the surface/egress engage only when `saveUrl !== ''`.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { shallowMount, flushPromises, VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// Keep the Analysis async-component cheap and DOM-safe if it ever renders.
vi.mock('@/src/components/AnalysisModule.vue', () => ({
  default: { name: 'AnalysisModule', template: '<div />' },
}));

// Observe remote-save egress without a network round-trip or the heavy
// serialize path — both are mocked at the module seam.
vi.mock('@/src/utils/fetch', () => ({
  $fetch: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/src/io/state-file/serialize', () => ({
  serialize: vi
    .fn()
    .mockResolvedValue(new Blob(['x'], { type: 'application/zip' })),
}));

import ModulePanel from '@/src/components/ModulePanel.vue';
import { useProvidersStore } from '@/src/store/providers';
import useRemoteSaveStateStore from '@/src/store/remote-save-state';
import { $fetch } from '@/src/utils/fetch';
import type { ProcessingProviderConfig } from '@/src/processing/types';

// Stub the Vuetify shell so mounting ModulePanel exercises only its own gating
// logic (we read the `modules` computed, never the rendered DOM).
const vuetifyStubs = {
  'v-tabs': true,
  'v-tab': true,
  'v-window': true,
  'v-window-item': true,
  'v-icon': true,
};

const mountModulePanel = () =>
  shallowMount(ModulePanel, { global: { stubs: vuetifyStubs } });

const moduleNames = (wrapper: VueWrapper) =>
  (wrapper.vm as unknown as { modules: { name: string }[] }).modules.map(
    (m) => m.name
  );

const sampleProvider: ProcessingProviderConfig = {
  id: 'p1',
  label: 'Fake Provider',
  protocol: 'slicer-cli',
  baseUrl: 'http://localhost/',
};

describe('Analysis tab is latent — gated on provider presence', () => {
  let wrapper: VueWrapper | null = null;

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('shows no Analysis tab when no provider is configured', async () => {
    wrapper = mountModulePanel();
    await flushPromises();

    expect(moduleNames(wrapper)).not.toContain('Analysis');
  });

  it('reveals the Analysis tab once a provider registers', async () => {
    wrapper = mountModulePanel();
    await flushPromises();
    expect(moduleNames(wrapper)).not.toContain('Analysis');

    useProvidersStore().registerProviderConfig(sampleProvider);
    await flushPromises();

    expect(moduleNames(wrapper)).toContain('Analysis');
  });
});

describe('Remote save is latent — gated on a save target', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked($fetch).mockClear();
  });

  it('exposes no save target and performs no egress when unconfigured', async () => {
    const store = useRemoteSaveStateStore();

    // No `save=` URL param → empty saveUrl → the remote-save surface stays
    // hidden (ControlsStrip/WelcomePage gate on `saveUrl !== ''`).
    expect(store.saveUrl).toBe('');

    await store.saveState();

    expect($fetch).not.toHaveBeenCalled();
  });

  it('performs egress only after a save target is set (always-built, latent)', async () => {
    const store = useRemoteSaveStateStore();
    store.setSaveUrl('https://example.test/save');

    await store.saveState();

    expect($fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked($fetch).mock.calls[0][0]).toBe(
      'https://example.test/save'
    );
  });
});
