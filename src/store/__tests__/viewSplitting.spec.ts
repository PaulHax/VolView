import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import JSZip from 'jszip';
import { useViewStore } from '@/src/store/views';
import { useIdStore } from '@/src/store/id';
import { getLayoutSlots } from '@/src/utils/layoutEditing';
import { ManifestSchema, type StateFile } from '@/src/io/state-file/schema';

const snapshot = (store: ReturnType<typeof useViewStore>) => {
  const state: StateFile = {
    zip: new JSZip(),
    manifest: { version: '6.1.0', dataSources: [] },
  };
  store.serialize(state);
  return ManifestSchema.parse(JSON.parse(JSON.stringify(state.manifest)));
};

describe('Splitting layout views', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each(['row', 'column'] as const)(
    'splits only the chosen area along %s',
    (direction) => {
      const store = useViewStore();
      store.setLayoutFromGrid([2, 1]);
      const [left, right] = store.layoutViews;
      store.setDataForView(right.id, 'image');
      const before = snapshot(store);
      const newID = store.splitView(right.id, direction)!;
      const after = snapshot(store);
      const bounds = getLayoutSlots(after.layout!);
      expect(store.layoutViews.map((view) => view.id)).toEqual([
        left.id,
        right.id,
        newID,
      ]);
      expect(bounds[0]).toEqual(getLayoutSlots(before.layout!)[0]);
      expect(store.getViewForSlot(bounds[2].slotIndex)?.id).toBe(newID);
      expect(store.getView(newID)).toEqual({ ...right, id: newID });
      expect(store.getView(newID)?.options).not.toBe(right.options);
      expect(store.activeView).toBe(left.id);
      expect(store.currentLayoutName).toBeNull();
      expect(
        bounds[1].width * bounds[1].height + bounds[2].width * bounds[2].height
      ).toBe(5000);
      expect(bounds[1][direction === 'row' ? 'width' : 'height']).toBe(
        direction === 'row' ? 25 : 50
      );
    }
  );

  it('supports repeated mixed splits, compacts closed slots, and preserves hidden views', () => {
    const store = useViewStore();
    const hidden = store.layoutViews.slice(2).map((view) => view.id);
    store.setLayoutFromGrid([2, 1]);
    const [left, right] = store.layoutViews;
    const middleID = store.splitView(right.id, 'column')!;
    const lastID = store.splitView(middleID, 'row')!;
    store.setActiveView(middleID);
    expect(store.closeView(middleID)).toBe(true);
    expect(store.activeView).toBe(left.id);
    expect(store.viewIDs).not.toContain(middleID);
    expect(store.viewIDs).toEqual(expect.arrayContaining(hidden));
    expect(store.layoutViews.map((view) => view.id)).toEqual([
      left.id,
      right.id,
      lastID,
    ]);
    const slots = getLayoutSlots(store.visibleLayout);
    expect(
      slots.map((slot) => store.getViewForSlot(slot.slotIndex)?.id)
    ).toEqual([left.id, right.id, lastID]);
    expect(slots[2]).toMatchObject({
      left: 50,
      top: 50,
      width: 50,
      height: 50,
    });
    expect(snapshot(store).layoutSlots).not.toContain(middleID);
  });

  it('expands a maximized view before splitting and retains all peers', () => {
    const store = useViewStore();
    const source = store.layoutViews[1];
    store.setActiveView(source.id);
    store.toggleActiveViewMaximized();
    expect(store.visibleViews).toHaveLength(1);
    const id = store.splitView(source.id, 'column')!;
    expect(store.visibleViews).toHaveLength(5);
    expect(store.activeView).toBe(source.id);
    expect(store.visibleViews.map((view) => view.id)).toContain(id);
    expect(store.getViewForSlot(0)?.id).toBe(store.layoutViews[0].id);
  });

  it('does not close the last view or split hidden or missing views', () => {
    const store = useViewStore();
    const hidden = store.layoutViews[1].id;
    store.setLayoutFromGrid([1, 1]);
    const before = snapshot(store);
    expect(store.closeView(store.layoutViews[0].id)).toBe(false);
    expect(store.closeView(hidden)).toBe(false);
    expect(store.splitView(hidden, 'row')).toBeNull();
    expect(store.splitView('missing', 'column')).toBeNull();
    expect(snapshot(store)).toEqual(before);
  });

  it('restores a custom layout and can split without replacing restored IDs', () => {
    const store = useViewStore();
    const id = store.splitView(store.layoutViews[0].id, 'row')!;
    store.splitView(id, 'column');
    const manifest = ManifestSchema.parse(snapshot(store));
    setActivePinia(createPinia());
    const restored = useViewStore();
    restored.deserializeLayout(manifest);
    useIdStore().reset();
    const source = restored.layoutViews[0];
    const originalIDs = [...restored.viewIDs];
    const newID = restored.splitView(source.id, 'column')!;
    expect(originalIDs).not.toContain(newID);
    expect(restored.viewIDs).toHaveLength(originalIDs.length + 1);
    expect(restored.getView(source.id)).toMatchObject(source);
    expect(restored.layoutViews).toHaveLength(7);
  });

  it('clears image bindings from split and hidden views without changing layout', () => {
    const store = useViewStore();
    store.setDataForAllViews('image');
    const newID = store.splitView(store.layoutViews[0].id, 'row')!;
    const before = snapshot(store).layout;
    store.removeDataFromViews('image');
    expect(store.getView(newID)?.dataID).toBeNull();
    expect(store.getAllViews().every((view) => view.dataID === null)).toBe(
      true
    );
    expect(snapshot(store).layout).toEqual(before);
    store.setDataForView(newID, 'next-image');
    store.replaceView(newID, {
      name: 'Volume',
      type: '3D',
      dataID: 'next-image',
      options: { viewDirection: 'Posterior', viewUp: 'Superior' },
    });
    expect(store.getView(newID)).toBeNull();
    expect(store.layoutViews).toHaveLength(5);
    expect(
      store.layoutViews.some(
        (view) => view.type === '3D' && view.dataID === 'next-image'
      )
    ).toBe(true);
  });
});
