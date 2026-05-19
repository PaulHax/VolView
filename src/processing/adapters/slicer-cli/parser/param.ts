// Ported from slicer_cli_web/web_client/parser/param.js.
//
// Returns null for output parameters that are scalar (i.e. parameter-output
// pattern). File/image *outputs* are turned into the 'new-file' synthetic
// widget type for an output filename slot.

import { widgetType } from './widget';
import type { WidgetType } from './convert';
import { parseDefaultValue } from './defaultValue';
import { parseConstraints, type Constraints } from './constraints';
import { convert } from './convert';

export type ParsedParam = {
  type: WidgetType | string;
  slicerType: string;
  title: string;
  description: string;
  channel: 'input' | 'output';
  id: string;
  value?: string | number | boolean | string[] | number[];
  values?: Array<string | number | boolean>;
  required?: boolean;
  extensions?: string | null;
  reference?: string | null;
  defaultNameMatch?: string | null;
  defaultPathMatch?: string | null;
  defaultRelativePath?: string | null;
  multiple?: boolean;
  datalist?: boolean;
  shapes?: string | null;
} & Constraints;

export type ParseOpts = {
  output?: boolean;
  params?: Record<string, string>;
};

const childText = (el: Element, tag: string): string => {
  for (const c of Array.from(el.children)) {
    if (c.tagName === tag) return c.textContent ?? '';
  }
  return '';
};

const firstChild = (el: Element, tag: string): Element | null => {
  for (const c of Array.from(el.children)) {
    if (c.tagName === tag) return c;
  }
  return null;
};

const allChildren = (el: Element, tag: string): Element[] =>
  Array.from(el.children).filter((c) => c.tagName === tag);

export const parseParam = (
  paramEl: Element,
  opts: ParseOpts = {}
): ParsedParam | null => {
  let type = widgetType(paramEl);
  const channelText = childText(paramEl, 'channel');
  const channel: 'input' | 'output' =
    channelText === 'output' ? 'output' : 'input';
  const id = childText(paramEl, 'name') || childText(paramEl, 'longflag');

  const extra: Partial<ParsedParam> = {};
  if (childText(paramEl, 'index').length > 0) {
    extra.required = true;
  }

  if ((type === 'file' || type === 'image') && channel === 'output') {
    type = 'new-file';
    extra.extensions = paramEl.getAttribute('fileExtensions');
    extra.reference = paramEl.getAttribute('reference');
  } else if (channel === 'output') {
    // Scalar output / parameter-output — record in opts and skip rendering.
    opts.output = true;
    opts.params = { ...(opts.params || {}), [id]: type ?? paramEl.tagName };
    return null;
  } else if (
    channel === 'input' &&
    type &&
    ['image', 'file', 'item', 'directory', 'multi'].includes(type)
  ) {
    extra.defaultNameMatch = paramEl.getAttribute('defaultNameMatch');
    extra.defaultPathMatch = paramEl.getAttribute('defaultPathMatch');
    extra.defaultRelativePath = paramEl.getAttribute('defaultRelativePath');
    if (type !== 'directory') {
      extra.multiple = paramEl.getAttribute('multiple') === 'true';
    }
  }

  if (channel === 'input' && paramEl.getAttribute('datalist')) {
    extra.datalist = true;
  }
  if (type === 'region') {
    extra.shapes = paramEl.getAttribute('shapes');
  }

  if (!type) {
    console.warn(`Unhandled parameter type "${paramEl.tagName}"`);
  }

  let values: { values?: Array<string | number | boolean> } = {};
  if (type === 'string-enumeration' || type === 'number-enumeration') {
    values = {
      values: allChildren(paramEl, 'element').map(
        (el) =>
          convert(type as WidgetType, el.textContent ?? '') as string | number
      ),
    };
  }

  return {
    type: type ?? paramEl.tagName,
    slicerType: paramEl.tagName,
    title: childText(paramEl, 'label'),
    description: childText(paramEl, 'description'),
    channel,
    id,
    ...values,
    ...parseDefaultValue(type as WidgetType, firstChild(paramEl, 'default')),
    ...parseConstraints(type as WidgetType, firstChild(paramEl, 'constraints')),
    ...extra,
  };
};
