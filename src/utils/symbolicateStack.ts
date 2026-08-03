import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

/**
 * Rewrites minified stack frames to their original sources.
 *
 * Production bundles are minified, so `error.stack` names files like
 * `index-C4GXqX3N.js` at meaningless line/column offsets. The build emits
 * source maps next to those bundles and they are deployed alongside them, so a
 * report can be resolved against them on demand -- no build or deployment
 * change required.
 *
 * Maps are only fetched when an error is actually reported, and each one is
 * fetched at most once per session.
 */

// The `<url>:<line>:<column>` tail every browser appends to a stack frame.
const FRAME = /((?:https?:\/\/|\/)[^\s()]+\.js):(\d+):(\d+)/;

const mapCache = new Map<string, Promise<TraceMap | null>>();

const loadMap = (bundleUrl: string): Promise<TraceMap | null> => {
  const cached = mapCache.get(bundleUrl);
  if (cached) return cached;

  const pending = fetch(`${bundleUrl}.map`)
    .then((response) => (response.ok ? response.json() : null))
    .then((json) => (json ? new TraceMap(json) : null))
    .catch(() => null);

  mapCache.set(bundleUrl, pending);
  return pending;
};

const frameUrl = (line: string): string | undefined => FRAME.exec(line)?.[1];

// Source paths are relative to the bundle, e.g. `../../src/utils/bugReport.ts`.
const trimSource = (source: string): string => source.replace(/^(\.\.\/)+/, '');

const rewriteFrame = (
  line: string,
  maps: Map<string, TraceMap | null>
): string => {
  const match = FRAME.exec(line);
  if (!match) return line;

  const [located, url, row, column] = match;
  const map = maps.get(url);
  if (!map) return line;

  const position = originalPositionFor(map, {
    line: Number(row),
    column: Number(column),
  });
  if (!position.source) return line;

  const original = `${trimSource(position.source)}:${position.line}:${position.column}`;
  // Minifiers rarely record original identifiers, so a name is a bonus.
  const name = position.name ? ` [${position.name}]` : '';
  return `${line.replace(located, original)}${name}`;
};

/**
 * Resolves every mappable frame in a stack trace. Frames without a reachable
 * source map are left untouched, so a partial result is still useful.
 */
export const symbolicateStack = async (stack: string): Promise<string> => {
  const lines = stack.split('\n');
  const urls = [...new Set(lines.map(frameUrl))].filter(
    (url): url is string => url !== undefined
  );
  if (urls.length === 0) return stack;

  const loaded = await Promise.all(
    urls.map(async (url) => [url, await loadMap(url)] as const)
  );

  const maps = new Map(loaded);
  return lines.map((line) => rewriteFrame(line, maps)).join('\n');
};
