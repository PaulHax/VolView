import type { Layout, LayoutDirection, LayoutItem } from '@/src/types/layout';

export function splitLayoutSlot(
  layout: Layout,
  slotIndex: number,
  newSlotIndex: number,
  direction: LayoutDirection
): Layout {
  return {
    ...layout,
    items: layout.items.map((item): LayoutItem => {
      if (item.type === 'layout') {
        return {
          ...splitLayoutSlot(item, slotIndex, newSlotIndex, direction),
          type: 'layout',
        };
      }
      if (item.slotIndex !== slotIndex) return item;
      return {
        type: 'layout',
        direction,
        items: [item, { type: 'slot', slotIndex: newSlotIndex }],
      };
    }),
  };
}

export function removeLayoutSlot(layout: Layout, slotIndex: number): Layout {
  return {
    ...layout,
    items: layout.items.flatMap((item): LayoutItem[] => {
      if (item.type === 'slot') {
        if (item.slotIndex === slotIndex) return [];
        return [
          {
            ...item,
            slotIndex:
              item.slotIndex > slotIndex ? item.slotIndex - 1 : item.slotIndex,
          },
        ];
      }
      const child = removeLayoutSlot(item, slotIndex);
      if (child.items.length === 0) return [];
      if (child.items.length === 1) return [child.items[0]];
      return [{ ...child, type: 'layout' }];
    }),
  };
}

type Bounds = { left: number; top: number; width: number; height: number };

// Flat leaves let Vue retain viewer instances when their nesting changes.
export function getLayoutSlots(
  layout: Layout,
  bounds: Bounds = { left: 0, top: 0, width: 100, height: 100 }
): (Bounds & { slotIndex: number })[] {
  return layout.items.flatMap((item, index) => {
    const childBounds =
      layout.direction === 'row'
        ? {
            ...bounds,
            left: bounds.left + (index * bounds.width) / layout.items.length,
            width: bounds.width / layout.items.length,
          }
        : {
            ...bounds,
            top: bounds.top + (index * bounds.height) / layout.items.length,
            height: bounds.height / layout.items.length,
          };
    return item.type === 'slot'
      ? [{ ...childBounds, slotIndex: item.slotIndex }]
      : getLayoutSlots(item, childBounds);
  });
}
