// Runtime egress origin gate (D9, chunk 2). Same-origin is implicitly trusted;
// a cross-origin target passes only if the deployment's same-origin allow-list
// names its origin. Missing / empty / malformed / unreachable allow-list ⇒
// same-origin only (fail closed).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROCESSING_ORIGINS_PATH,
  isOriginAllowed,
  resolveOrigin,
  resetAllowedOriginsCache,
} from '@/src/io/originGate';

// Body may be a JSON value (served allow-list), or `undefined` to simulate a
// 404 (no allow-list served), or `'invalid'` for a malformed body.
const stubOriginsFetch = (
  body: unknown,
  { ok = true }: { ok?: boolean } = {}
) => {
  resetAllowedOriginsCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes(PROCESSING_ORIGINS_PATH)) {
        return { ok: false, status: 404 };
      }
      if (!ok) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (body === 'invalid') throw new Error('not json');
          return body;
        },
      };
    }) as unknown as typeof fetch
  );
};

const sameOrigin = (path: string) => `${window.location.origin}${path}`;

describe('origin gate', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetAllowedOriginsCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('allows a same-origin absolute URL with no allow-list served', async () => {
    stubOriginsFetch(undefined, { ok: false });
    expect(await isOriginAllowed(sameOrigin('/api/save'))).toBe(true);
  });

  it('allows a relative URL (resolves same-origin) with no allow-list', async () => {
    stubOriginsFetch(undefined, { ok: false });
    expect(await isOriginAllowed('/volview_processing')).toBe(true);
    // Same-origin short-circuits before the allow-list is fetched.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin URL when no allow-list is served', async () => {
    stubOriginsFetch(undefined, { ok: false });
    expect(await isOriginAllowed('https://attacker.example/exfil')).toBe(false);
  });

  it('allows a cross-origin URL only when the allow-list names its origin', async () => {
    stubOriginsFetch({ origins: ['https://analysis.example'] });
    expect(await isOriginAllowed('https://analysis.example/api')).toBe(true);
    expect(await isOriginAllowed('https://other.example/api')).toBe(false);
  });

  it('accepts a scheme-less allow-list entry as an https origin', async () => {
    stubOriginsFetch({ origins: ['analysis.example'] });
    expect(await isOriginAllowed('https://analysis.example/api')).toBe(true);
    expect(await isOriginAllowed('http://analysis.example/api')).toBe(false);
  });

  it('tolerates a bare JSON array of origins', async () => {
    stubOriginsFetch(['https://analysis.example']);
    expect(await isOriginAllowed('https://analysis.example/api')).toBe(true);
  });

  it('fails closed to same-origin only when the allow-list is malformed', async () => {
    stubOriginsFetch({ origins: 'not-an-array' });
    expect(await isOriginAllowed('https://analysis.example/api')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(PROCESSING_ORIGINS_PATH)
    );
  });

  it('fails closed when the allow-list body is not JSON', async () => {
    stubOriginsFetch('invalid');
    expect(await isOriginAllowed('https://analysis.example/api')).toBe(false);
  });

  it('fails closed when the fetch itself rejects (not served)', async () => {
    resetAllowedOriginsCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch
    );
    expect(await isOriginAllowed('https://analysis.example/api')).toBe(false);
  });

  it('refuses an unparseable URL', async () => {
    stubOriginsFetch(undefined, { ok: false });
    // A scheme with no host throws in the URL parser ⇒ no origin ⇒ refused.
    expect(await isOriginAllowed('http://')).toBe(false);
  });

  it('fetches the allow-list at most once across many checks (memoized)', async () => {
    stubOriginsFetch({ origins: ['https://analysis.example'] });
    await isOriginAllowed('https://analysis.example/api');
    await isOriginAllowed('https://other.example/api');
    await isOriginAllowed('https://analysis.example/api');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('resolveOrigin normalizes relative and absolute URLs', () => {
    expect(resolveOrigin('/x')).toBe(window.location.origin);
    expect(resolveOrigin('https://h.example:8443/y')).toBe(
      'https://h.example:8443'
    );
    // A scheme with no host is unparseable ⇒ null.
    expect(resolveOrigin('http://')).toBeNull();
  });
});
