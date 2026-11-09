import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ModulePanel from '@/src/components/ModulePanel.vue';
import { createStateFileRestorer } from '@/src/io/import/processors/restoreStateFile';
import { ManifestSchema } from '@/src/io/state-file/schema';
import { useSegmentationStore } from '@/src/segmentation/store';
import {
  activateAppPinia,
  seatImage,
} from '@/src/segmentation/__tests__/segmentMaskFixtures';
import { useViewStore } from '@/src/store/views';
import { useToolStore } from '@/src/store/tools';
import { useImageStatsStore } from '@/src/store/image-stats';
import { Tools } from '@/src/store/tools/types';
import { defer } from '@/src/utils';

beforeEach(() => {
  activateAppPinia();
});
afterEach(() => vi.restoreAllMocks());

it.each(['view', 'tool'])(
  'observes %s readiness before selecting Data',
  async (readiness) => {
    useImageStatsStore().stats.image = {
      scalarMin: 0,
      scalarMax: 1,
      autoRangeValues: {},
    };
    await seatImage('image');
    const wrapper = shallowMount(ModulePanel);
    const views = useViewStore();
    const id = views.layoutViews[0].id;
    const manifest = ManifestSchema.parse({
      version: '8.0.0',
      activeView: id,
      dataSources: [{ id: 1, type: 'uri', uri: '/image.nrrd' }],
      datasets: [{ id: 'saved', dataSourceId: 1 }],
      viewByID: {
        [id]: {
          id,
          name: 'Axial',
          type: '2D',
          dataID: 'saved',
          options: { orientation: 'Axial' },
        },
      },
      tools: { current: Tools.Paint },
    });
    const masks =
      defer<
        Awaited<
          ReturnType<ReturnType<typeof useSegmentationStore>['deserialize']>
        >
      >();
    vi.spyOn(useSegmentationStore(), 'deserialize').mockReturnValue(
      masks.promise
    );
    const restored = createStateFileRestorer({ addWarning: vi.fn() })(
      manifest,
      [],
      { saved: 'image' }
    );
    const tabs = wrapper.findComponent({ name: 'VTabs' });
    await nextTick();
    expect(views.getView(id)?.dataID).toBe('image');
    const release = async () => {
      masks.resolve({ skipped: [], restoredImportIds: new Set() });
      await restored;
      await nextTick();
      expect(useToolStore().currentTool).toBe(Tools.Paint);
    };
    try {
      if (readiness === 'tool') await release();
      tabs.vm.$emit('update:modelValue', 'Data');
      await nextTick();
      if (readiness !== 'tool') await release();
      expect(tabs.props('modelValue')).toBe(
        readiness === 'tool' ? 'Data' : 'Annotations'
      );
    } finally {
      wrapper.unmount();
    }
  }
);
