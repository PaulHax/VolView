// Ported from slicer_cli_web/web_client/parser/constraints.js.

import { convert, type WidgetType } from './convert';

export type Constraints = {
  min?: number | string;
  max?: number | string;
  step?: number | string;
};

const childText = (parent: Element | null, tag: string): string => {
  if (!parent) return '';
  for (const c of Array.from(parent.children)) {
    if (c.tagName === tag) return c.textContent ?? '';
  }
  return '';
};

export const parseConstraints = (
  type: WidgetType,
  constraintsEl: Element | null
): Constraints => {
  if (!constraintsEl) return {};
  const spec: Constraints = {};
  const min = childText(constraintsEl, 'minimum');
  const max = childText(constraintsEl, 'maximum');
  const step = childText(constraintsEl, 'step');
  if (min) spec.min = convert(type, min) as number | string;
  if (max) spec.max = convert(type, max) as number | string;
  if (step) spec.step = convert(type, step) as number | string;
  return spec;
};
