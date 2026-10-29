import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  computed,
  defineAsyncComponent,
  defineComponent,
  h,
  nextTick,
} from 'vue';
import { createVuetify } from 'vuetify';
import EnFaceLoadError from '@/src/enface/EnFaceLoadError.vue';
import ViewTypeSwitcher from '@/src/components/ViewTypeSwitcher.vue';
import { useViewStore } from '@/src/store/views';
import { seatImage } from '@/src/segmentation/__tests__/segmentMaskFixtures';
import { cleanupCachedImages } from '@/tests/unit/imageCacheCleanup';

enableAutoUnmount(afterEach);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('visualViewport', null);
});
afterEach(() => vi.unstubAllGlobals());
afterEach(() => cleanupCachedImages([]));

it.each([null, 'oct'])(
  'keeps view selection usable after the En face chunk fails with source %s',
  async (imageId) => {
    if (imageId) await seatImage(imageId);
    const views = useViewStore();
    views.setNamedLayoutsFromConfig({ Recovery: [['enface', 'coronal']] });
    views.switchToNamedLayout('Recovery');
    views.setDataForAllViews(imageId);
    const peerView = views.layoutViews[1];
    const loadError = new Error('Chunk request failed');
    const UnavailableViewer = defineAsyncComponent({
      loader: () => Promise.reject(loadError),
      errorComponent: EnFaceLoadError,
    });
    const Host = defineComponent({
      setup() {
        const selected = computed(() => views.layoutViews[0]);
        return () =>
          h('div', [
            h('section', { 'aria-label': 'Recoverable pane' }, [
              selected.value?.type === 'EnFace'
                ? h(UnavailableViewer, { viewId: selected.value.id })
                : h(ViewTypeSwitcher, {
                    viewId: selected.value.id,
                    imageId: selected.value?.dataID,
                  }),
            ]),
            h('section', { 'aria-label': 'Peer pane' }, [
              h(ViewTypeSwitcher, {
                viewId: peerView.id,
                imageId: peerView.dataID,
              }),
            ]),
          ]);
      },
    });
    const wrapper = mount(Host, {
      attachTo: document.body,
      global: {
        plugins: [createVuetify()],
        config: {
          errorHandler(error) {
            if (error !== loadError) throw error;
          },
        },
      },
    });
    await flushPromises();
    const pane = wrapper.get('[aria-label="Recoverable pane"]');
    const peer = wrapper.get('[aria-label="Peer pane"]');
    expect(pane.get('[role="alert"]').text()).toMatch(/could not load/);
    expect(pane.get('.v-select__selection-text').text()).toBe('En face');
    expect(peer.get('.v-select__selection-text').text()).toBe('Coronal');

    await pane.get('.v-field').trigger('mousedown');
    await nextTick();
    const axial = Array.from(document.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent?.trim() === 'Axial'
    );
    expect(axial).toBeDefined();
    axial!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    expect(pane.find('[role="alert"]').exists()).toBe(false);
    expect(pane.get('.v-select__selection-text').text()).toBe('Axial');
    expect(peer.get('.v-select__selection-text').text()).toBe('Coronal');
  }
);
