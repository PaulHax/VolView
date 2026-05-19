// Ported from slicer_cli_web/web_client/parser/defaultValue.js.

import { convert, type WidgetType } from './convert';

export type DefaultValue = {
  value?: string | number | boolean | string[] | number[];
};

export const parseDefaultValue = (
  type: WidgetType,
  defaultEl: Element | null
): DefaultValue => {
  if (!defaultEl) return {};
  const text = defaultEl.textContent ?? '';
  if (text.length === 0) return {};

  // Skip template placeholders like `{{x}}` — same logic as the JS parser.
  const isTemplate =
    text.substring(0, 2) === '{{' &&
    text.substring(Math.max(0, text.length - 2)) === '}}';
  if (!isTemplate) {
    return { value: convert(type, text) };
  }
  const defstr = '__default__';
  const converted = convert(type, defstr);
  if (converted === defstr) {
    return { value: converted };
  }
  return {};
};
