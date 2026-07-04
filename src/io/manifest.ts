import { z } from 'zod';

export const RemoteResource = z.object({
  url: z.string(),
  name: z.optional(z.string()),
});

export const RemoteDataManifest = z.object({
  resources: z.array(RemoteResource),
  // Tier-2 session watermark (Chunk 19, D5): the restored session zip's own
  // server-side save instant, present iff the launch selected a session. The
  // client compares each re-discovered job's `finishedAt` against it
  // (`finishedAt > sessionSavedAt`); absent → attach all (MVP parity). Optional
  // + additive, so a pre-Chunk-19 manifest (no field) still parses.
  sessionSavedAt: z.optional(z.string()),
});

export async function readRemoteManifestFile(manifestFile: File) {
  const decoder = new TextDecoder();
  const ab = await manifestFile.arrayBuffer();
  const text = decoder.decode(new Uint8Array(ab));
  const manifest = RemoteDataManifest.parse(JSON.parse(text));
  return manifest;
}
