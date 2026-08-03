import { symbolicateStack } from '@/src/utils/symbolicateStack';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Maps generated line 1, column 0 onto src/boom.ts line 1, column 0.
const SOURCE_MAP = {
  version: 3,
  sources: ['../../src/boom.ts'],
  sourcesContent: ['export const boom = () => { throw new Error("x"); };'],
  names: [],
  mappings: 'AAAA',
};

// Maps are cached for the session by URL, so each case needs its own bundle.
let bundleCount = 0;
const nextBundle = () =>
  `http://localhost/assets/index-${(bundleCount += 1)}.js`;

const stubFetch = (body: object | null) => {
  const fetchMock = vi.fn(async () =>
    body
      ? ({ ok: true, json: async () => body } as unknown as Response)
      : ({ ok: false } as unknown as Response)
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('symbolicateStack', () => {
  it('rewrites a mapped frame to its original source', async () => {
    const bundle = nextBundle();
    stubFetch(SOURCE_MAP);

    const result = await symbolicateStack(
      `Error: x\n    at qN (${bundle}:1:0)`
    );

    expect(result).toContain('src/boom.ts:1:0');
    expect(result).not.toContain(bundle);
    // Non-frame lines survive untouched.
    expect(result.split('\n')[0]).toEqual('Error: x');
  });

  it('requests the source map next to the bundle', async () => {
    const bundle = nextBundle();
    const fetchMock = stubFetch(SOURCE_MAP);

    await symbolicateStack(`Error: x\n    at qN (${bundle}:1:0)`);

    expect(fetchMock).toHaveBeenCalledWith(`${bundle}.map`);
  });

  it('leaves the stack alone when no map is reachable', async () => {
    const bundle = nextBundle();
    stubFetch(null);

    const stack = `Error: x\n    at qN (${bundle}:1:0)`;
    expect(await symbolicateStack(stack)).toEqual(stack);
  });

  it('leaves a stack with no frames alone without fetching', async () => {
    const fetchMock = stubFetch(SOURCE_MAP);

    expect(await symbolicateStack('Error: x')).toEqual('Error: x');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches each bundle map only once', async () => {
    const bundle = nextBundle();
    const fetchMock = stubFetch(SOURCE_MAP);

    await symbolicateStack(
      `Error: x\n    at a (${bundle}:1:0)\n    at b (${bundle}:1:0)`
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
