import { DataSource } from '@/src/io/import/dataSource';
import { ImportHandler, asIntermediateResult } from '@/src/io/import/common';
import { readRemoteManifestFile } from '@/src/io/manifest';
import { useProvidersStore } from '@/src/store/providers';
import { Skip } from '@/src/utils/evaluateChain';
import { ZodError } from 'zod';

/**
 * Reads a JSON file that conforms to the remote manifest spec.
 * @param dataSource
 * @returns
 */
const handleRemoteManifest: ImportHandler = async (dataSource) => {
  if (
    dataSource.type !== 'file' ||
    dataSource.fileType !== 'application/json'
  ) {
    return Skip;
  }

  try {
    const remotes: DataSource[] = [];
    const manifest = await readRemoteManifestFile(dataSource.file);
    // Tier-2 session watermark (Chunk 19, D5): the launch manifest carries the
    // restored session zip's server-side save instant iff a session was
    // selected. Record it so cold-reload re-attach applies a result only when
    // `finishedAt > sessionSavedAt` (no session → undefined → attach all).
    if (manifest.sessionSavedAt) {
      useProvidersStore().setSessionWatermark(manifest.sessionSavedAt);
    }
    manifest.resources.forEach((res) => {
      remotes.push({
        type: 'uri',
        uri: res.url,
        name: res.name ?? new URL(res.url, window.location.origin).pathname,
        parent: dataSource,
      });
    });

    return asIntermediateResult(remotes);
  } catch (err) {
    if (err instanceof ZodError) return Skip;
    throw err;
  }
};

export default handleRemoteManifest;
