// Ported from slicer_cli_web/web_client/parser/widget.js.

import type { WidgetType } from './convert';

const TYPE_MAP: Record<string, WidgetType> = {
  integer: 'number',
  float: 'number',
  double: 'number',
  boolean: 'boolean',
  string: 'string',
  'integer-vector': 'number-vector',
  'float-vector': 'number-vector',
  'double-vector': 'number-vector',
  'string-vector': 'string-vector',
  'integer-enumeration': 'number-enumeration',
  'float-enumeration': 'number-enumeration',
  'double-enumeration': 'number-enumeration',
  'string-enumeration': 'string-enumeration',
  region: 'region',
  image: 'image',
  file: 'file',
  item: 'item',
  directory: 'directory',
  multi: 'multi',
};

export const widgetType = (paramEl: Element): WidgetType | undefined =>
  TYPE_MAP[paramEl.tagName];
