// Ported from slicer_cli_web/web_client/parser/convert.js — pure TS, no jQuery.

export type WidgetType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'number-vector'
  | 'string-vector'
  | 'number-enumeration'
  | 'string-enumeration'
  | 'region'
  | 'image'
  | 'file'
  | 'item'
  | 'directory'
  | 'multi'
  | 'new-file';

export const convert = (
  type: WidgetType,
  value: string
): string | number | boolean | string[] | number[] => {
  if (type === 'number' || type === 'number-enumeration') {
    return parseFloat(value);
  }
  if (type === 'boolean') {
    return value.toLowerCase() === 'true';
  }
  if (type === 'number-vector') {
    return value.split(',').map((s) => parseFloat(s));
  }
  if (type === 'string-vector') {
    return value.split(',');
  }
  return value;
};
