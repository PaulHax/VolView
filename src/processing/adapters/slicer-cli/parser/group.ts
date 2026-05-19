// Ported from slicer_cli_web/web_client/parser/group.js.
//
// A group is delimited by a <label> within a <parameters> panel. The group
// collects all siblings after the label, up to the next <label> sibling,
// excluding <description>.

import { parseParam, type ParsedParam, type ParseOpts } from './param';

export type ParsedGroup = {
  label: string;
  description: string;
  parameters: ParsedParam[];
};

export const parseGroup = (
  labelEl: Element,
  opts: ParseOpts = {}
): ParsedGroup | null => {
  // Find a sibling <description> (preferring one immediately after).
  let descriptionEl: Element | null = null;
  for (const sib of Array.from(labelEl.parentElement?.children ?? [])) {
    if (sib.tagName === 'description' && sib !== labelEl) {
      descriptionEl = sib;
      break;
    }
  }

  // Build paramlist: all siblings after labelEl up to next <label> (or end),
  // excluding <description>.
  const parent = labelEl.parentElement;
  if (!parent) return null;
  const sibs = Array.from(parent.children);
  const startIdx = sibs.indexOf(labelEl) + 1;
  const paramEls: Element[] = [];
  for (let i = startIdx; i < sibs.length; i += 1) {
    if (sibs[i].tagName === 'label') break;
    if (sibs[i].tagName === 'description') continue;
    paramEls.push(sibs[i]);
  }

  const parameters = paramEls
    .map((p) => parseParam(p, opts))
    .filter((p): p is ParsedParam => p !== null);

  if (parameters.length === 0) return null;
  return {
    label: labelEl.textContent ?? '',
    description: descriptionEl?.textContent ?? '',
    parameters,
  };
};
