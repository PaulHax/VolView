// Ported from slicer_cli_web/web_client/parser/panel.js.

import { parseGroup, type ParsedGroup } from './group';
import type { ParseOpts } from './param';

export type ParsedPanel = {
  advanced: boolean;
  groups: ParsedGroup[];
};

export const parsePanel = (
  panelEl: Element,
  opts: ParseOpts = {}
): ParsedPanel | null => {
  // Find direct <label> children — the original parser used
  // `<parameters> > label` (jQuery), so label must be a direct child.
  const labels = Array.from(panelEl.children).filter(
    (c) => c.tagName === 'label'
  );
  const groups = labels
    .map((label) => parseGroup(label, opts))
    .filter((g): g is ParsedGroup => g !== null);
  if (groups.length === 0) return null;
  return {
    advanced: panelEl.getAttribute('advanced') === 'true',
    groups,
  };
};
