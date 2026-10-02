import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { computed, effectScope, ref, type EffectScope } from 'vue';
import vtkCamera from '@kitware/vtk.js/Rendering/Core/Camera';
import { useAutoFitState } from '@/src/composables/useAutoFitState';
import { usePersistCameraConfig } from '@/src/composables/usePersistCameraConfig';
import { useViewStore } from '@/src/store/views';
import { useViewConfigStore } from '@/src/store/view-configs';
import { useViewCameraStore } from '@/src/store/view-configs/camera';

describe('split camera fit mode', () => {
  const scopes: EffectScope[] = [];
  beforeEach(() => {
    setActivePinia(createPinia());
    useViewConfigStore();
    vi.useFakeTimers();
  });
  afterEach(() => {
    scopes.splice(0).forEach((scope) => scope.stop());
    vi.useRealTimers();
  });

  const createCamera = (viewID: string, dataID = ref('image')) => {
    const store = useViewCameraStore();
    const camera = vtkCamera.newInstance();
    const scope = effectScope();
    scopes.push(scope);
    const fit = scope.run(() => {
      const enabled = computed({
        get: () => store.getAutoFitState(viewID, dataID.value),
        set: (value: boolean) =>
          store.setAutoFitState(viewID, dataID.value, value),
      });
      const autoFit = useAutoFitState(camera, enabled);
      usePersistCameraConfig(viewID, dataID, camera);
      return autoFit;
    })!;
    return { camera, fit };
  };

  it.each([true, false])(
    'retains source auto-fit=%s when a split renderer first resizes',
    async (enabled) => {
      const views = useViewStore();
      const cameras = useViewCameraStore();
      const source = views.layoutViews[0].id;
      views.setDataForView(source, 'image');
      cameras.updateConfig(source, 'image', { parallelScale: 14 });
      cameras.markCameraAsInitialized(source, 'image');
      const original = createCamera(source);
      if (!enabled) {
        original.fit.resume();
        original.camera.setParallelScale(15);
        original.fit.pause();
        await vi.runAllTimersAsync();
      }
      const copiedScale = original.camera.getParallelScale();
      const target = views.splitView(source, 'row')!;
      const split = createCamera(target);
      expect(split.camera.getParallelScale()).toBe(copiedScale);
      expect(split.fit.autoFit.value).toBe(enabled);
      expect(cameras.isCameraInitialized(target, 'image')).toBe(true);

      // VtkSliceView's resize observer fits only when the stored mode allows it.
      if (split.fit.autoFit.value) {
        split.fit.withPaused(() => split.camera.setParallelScale(42));
      }
      await vi.runAllTimersAsync();
      expect(split.camera.getParallelScale()).toBe(enabled ? 42 : copiedScale);
      expect(cameras.getConfig(target, 'image')?.parallelScale).toBe(
        enabled ? 42 : copiedScale
      );
      expect(original.camera.getParallelScale()).toBe(copiedScale);
      split.fit.autoFit.value = !enabled;
      expect(original.fit.autoFit.value).toBe(enabled);
    }
  );

  it('tracks fit mode by dataset and clears it on close, image deletion, and restore', () => {
    const views = useViewStore();
    const cameras = useViewCameraStore();
    const source = views.layoutViews[0].id;
    cameras.updateConfig(source, 'image', { parallelScale: 14 });
    cameras.setAutoFitState(source, 'image', false);
    cameras.setAutoFitState(source, 'other', false);
    const imageID = ref('image');
    const original = createCamera(source, imageID);
    expect(original.fit.autoFit.value).toBe(false);
    imageID.value = 'fresh';
    expect(original.fit.autoFit.value).toBe(true);
    imageID.value = 'other';
    expect(original.fit.autoFit.value).toBe(false);

    const target = views.splitView(source, 'column')!;
    expect(cameras.getAutoFitState(target, 'image')).toBe(false);
    views.closeView(target);
    expect(cameras.getAutoFitState(target, 'image')).toBe(true);
    useViewConfigStore().removeData('image');
    expect(cameras.getAutoFitState(source, 'image')).toBe(true);
    expect(cameras.getAutoFitState(source, 'other')).toBe(false);
    views.deserializeLayout({
      version: '6.1.0',
      dataSources: [],
      viewByID: {},
    });
    expect(cameras.getAutoFitState(source, 'other')).toBe(true);
  });
});
