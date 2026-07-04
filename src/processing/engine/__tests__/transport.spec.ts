import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createEngineTransport, type TransportDescriptor } from '../transport';
import { setGlobalHeader, deleteGlobalHeader } from '@/src/utils/fetch';

// ---------------------------------------------------------------------------
// Capture every HTTP call the engine makes, returning canned JSON. Because the
// engine routes through `$fetch` (which merges the module-global headers), the
// recorded `init.headers` carry the bearer token — a RAW `fetch` would not.
// ---------------------------------------------------------------------------

type Call = { url: string; init: RequestInit | undefined };

const stubFetch = (json: unknown) => {
  const calls: Call[] = [];
  const stub = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', stub);
  return calls;
};

const authOf = (call: Call): string | null =>
  new Headers(call.init?.headers).get('Authorization');

// A descriptor keyed by a label so its endpoints, input placement, and result
// format are all trivially distinguishable when the engine reads them.
const descriptorFor = (label: string): TransportDescriptor => ({
  endpoints: {
    listTasks: (b) => `${b}/${label}/tasks`,
    taskSpec: (b, t) => `${b}/${label}/spec/${t}`,
    runTask: (b, t) => `${b}/${label}/run/${t}`,
    jobStatus: (b, j) => `${b}/${label}/status/${j}`,
    jobResults: (b, j) => `${b}/${label}/results/${j}`,
  },
  buildRunRequest: (values) => ({
    method: 'POST',
    body: JSON.stringify({ [label]: values }),
  }),
  lifecycle: 'poll',
  format: {
    parseTasks: () => [{ id: `${label}-task`, title: label }],
    parseSpec: (raw) => raw as never,
    parseRunResponse: () => ({ jobId: `${label}-job` }),
    parseStatus: (jobId) => ({ jobId, state: 'running' }),
    parseResults: () => [
      { id: `${label}-result`, name: label, url: `http://x/${label}` },
    ],
  },
});

describe('engine transport reads its descriptor + uses $fetch', () => {
  beforeEach(() => {
    setGlobalHeader('Authorization', 'Bearer test-token');
  });
  afterEach(() => {
    deleteGlobalHeader('Authorization');
    vi.unstubAllGlobals();
  });

  // Acceptance #2: no raw fetch in engine paths — proven because the bearer
  // header set via setGlobalHeader reaches the request (only $fetch merges it).
  it('carries the global bearer header on every call (never raw fetch)', async () => {
    const calls = stubFetch({});
    const engine = createEngineTransport('http://host', descriptorFor('A'));

    await engine.getTaskSpec('t1');
    await engine.runTask('t1', { radius: 3 });
    await engine.getJob('j1');
    await engine.getResults('j1');

    expect(calls.length).toBe(4);
    calls.forEach((c) => expect(authOf(c)).toBe('Bearer test-token'));
  });

  // Acceptance #3: swapping the descriptor redirects the engine's calls —
  // endpoint path, input placement, and result format all move with it.
  it('routes endpoints / input-placement / result-format through the descriptor', async () => {
    // Descriptor A.
    let calls = stubFetch({});
    const engineA = createEngineTransport('http://host', descriptorFor('A'));
    await engineA.getTaskSpec('t1');
    await engineA.runTask('t1', { radius: 3 });
    const resultsA = await engineA.getResults('j1');

    expect(calls[0].url).toBe('http://host/A/spec/t1');
    expect(calls[1].url).toBe('http://host/A/run/t1');
    expect(calls[1].init?.body).toBe(JSON.stringify({ A: { radius: 3 } }));
    expect(resultsA[0].id).toBe('A-result');

    // Swap to descriptor B — same engine code, different descriptor.
    vi.unstubAllGlobals();
    calls = stubFetch({});
    const engineB = createEngineTransport('http://host', descriptorFor('B'));
    await engineB.getTaskSpec('t1');
    await engineB.runTask('t1', { radius: 3 });
    const resultsB = await engineB.getResults('j1');

    expect(calls[0].url).toBe('http://host/B/spec/t1');
    expect(calls[1].url).toBe('http://host/B/run/t1');
    expect(calls[1].init?.body).toBe(JSON.stringify({ B: { radius: 3 } }));
    expect(resultsB[0].id).toBe('B-result');
  });

  // Lifecycle axis is read from the descriptor. Only `poll` is built in v1; the
  // engine fails closed on any other lifecycle rather than mis-driving a job.
  it('reads the lifecycle axis and fails closed on the unbuilt inline driver', async () => {
    stubFetch({});
    const inline = { ...descriptorFor('A'), lifecycle: 'inline' as const };
    const engine = createEngineTransport('http://host', inline);
    await expect(engine.runTask('t1', {})).rejects.toThrow(/lifecycle/);
  });

  // Staging (Chunk 15): client-created labelmap bytes POST to the descriptor's
  // stage endpoint (bearer-carrying $fetch), and the minted URIs come back
  // through the descriptor's response parser — never constructed by the client.
  it('stages bytes through the descriptor stage endpoint and returns minted URIs', async () => {
    const base = descriptorFor('A');
    const staging: TransportDescriptor = {
      ...base,
      endpoints: { ...base.endpoints, stage: (b) => `${b}/A/stage` },
      format: {
        ...base.format,
        parseStageResponse: (raw) => (raw as { uris: string[] }).uris,
      },
    };
    const calls = stubFetch({
      uris: ['/api/v1/file/abc/proxiable/seg.seg.nrrd'],
    });
    const engine = createEngineTransport('http://host', staging);

    const uris = await engine.stageInput(new Blob(['bytes']), 'seg.seg.nrrd');

    expect(uris).toEqual(['/api/v1/file/abc/proxiable/seg.seg.nrrd']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://host/A/stage?name=seg.seg.nrrd');
    expect(calls[0].init?.method).toBe('POST');
    expect(authOf(calls[0])).toBe('Bearer test-token');
  });

  // Fail closed: a descriptor with no stage endpoint does not support
  // client-created inputs — the transport refuses rather than guess a route.
  it('fails closed when the descriptor advertises no stage endpoint', async () => {
    stubFetch({});
    const engine = createEngineTransport('http://host', descriptorFor('A'));
    await expect(engine.stageInput(new Blob(['x']))).rejects.toThrow(
      /does not support staging/i
    );
  });
});
