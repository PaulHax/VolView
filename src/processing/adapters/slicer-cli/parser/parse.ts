// Ported from slicer_cli_web/web_client/parser/parse.js.

import { parsePanel, type ParsedPanel } from './panel';
import type { ParseOpts, ParsedParam } from './param';

export type SlicerCliDocument = {
  xml: string;
  title: string;
  description: string;
  version?: string;
  'documentation-url'?: string;
  license?: string;
  contributor?: string;
  acknowledgements?: string;
  panels: ParsedPanel[];
  // Output bindings discovered during parsing (parameter-output etc.)
  outputParams?: Record<string, string>;
  parameters: ParsedParam[];
};

const firstChild = (el: Element, tag: string): Element | null => {
  for (const c of Array.from(el.children)) {
    if (c.tagName === tag) return c;
  }
  return null;
};

const allChildren = (el: Element, tag: string): Element[] =>
  Array.from(el.children).filter((c) => c.tagName === tag);

export const parseSlicerCli = (xml: string): SlicerCliDocument => {
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const parseErr = dom.querySelector('parsererror');
  if (parseErr) {
    throw new Error(`Invalid Slicer CLI XML: ${parseErr.textContent}`);
  }
  const executable = dom.querySelector('executable');
  if (!executable) {
    throw new Error('Slicer CLI XML missing <executable>');
  }

  const titleEl = firstChild(executable, 'title');
  const descEl = firstChild(executable, 'description');

  const opts: ParseOpts = {};
  const panels = allChildren(executable, 'parameters')
    .map((p) => parsePanel(p, opts))
    .filter((p): p is ParsedPanel => p !== null);

  const meta: Partial<SlicerCliDocument> = {};
  (
    [
      'version',
      'documentation-url',
      'license',
      'contributor',
      'acknowledgements',
    ] as const
  ).forEach((key) => {
    const el = firstChild(executable, key);
    if (el && el.textContent) {
      (meta as Record<string, string>)[key] = el.textContent;
    }
  });

  // Flatten all rendered parameters for easy iteration by the form layer.
  const parameters: ParsedParam[] = [];
  panels.forEach((panel) =>
    panel.groups.forEach((g) => g.parameters.forEach((p) => parameters.push(p)))
  );

  return {
    xml,
    title: titleEl?.textContent ?? '',
    description: descEl?.textContent ?? '',
    ...meta,
    panels,
    parameters,
    outputParams: opts.params,
  };
};
