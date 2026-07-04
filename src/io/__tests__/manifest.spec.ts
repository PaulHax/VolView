import { describe, it, expect } from 'vitest';

import { RemoteDataManifest } from '@/src/io/manifest';

// The launch manifest gained an optional `sessionSavedAt` (Chunk 19, D5): the
// restored session zip's server-side save instant, the tier-2 watermark. It is
// additive so a pre-Chunk-19 manifest (no field) still parses = attach-all.
describe('RemoteDataManifest — sessionSavedAt (Chunk 19)', () => {
  it('parses a manifest carrying the session watermark', () => {
    const manifest = RemoteDataManifest.parse({
      resources: [{ url: '/api/v1/file/a/proxiable/a.nrrd', name: 'a.nrrd' }],
      sessionSavedAt: '2026-07-03T12:00:00+00:00',
    });
    expect(manifest.sessionSavedAt).toBe('2026-07-03T12:00:00+00:00');
  });

  it('tolerates a manifest with no watermark (attach-all / older facade)', () => {
    const manifest = RemoteDataManifest.parse({
      resources: [{ url: '/api/v1/file/a/proxiable/a.nrrd' }],
    });
    expect(manifest.sessionSavedAt).toBeUndefined();
    expect(manifest.resources).toHaveLength(1);
  });
});
