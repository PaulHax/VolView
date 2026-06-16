// ---------------------------------------------------------------------------
// Active-volume binding (item 3.6).
//
// In a multi-volume folder the facade advertises one source per volume (item
// 3.2), each carrying an opaque `matchKey`. This module picks the source that
// corresponds to the on-screen volume so a job runs on the *viewed* volume
// rather than `sources[0]`. Pure + Girder-free: it compares image metadata
// VolView already holds against the provider-supplied key; it never learns
// Girder ids or routes.
// ---------------------------------------------------------------------------

import type { LoadedProcessingSource } from '@/src/processing/types';

// The on-screen volume's identity, gathered from VolView image metadata.
// `seriesInstanceUID` is present only for DICOM volumes; `name` is the display
// name VolView shows for any dataset.
export type ActiveVolumeIdentity = {
  seriesInstanceUID?: string;
  name?: string;
};

// Bind the on-screen volume to exactly one advertised source. DICOM volumes
// match by SeriesInstanceUID (their names come from headers, not filenames, so
// name matching "would always fail"); non-DICOM single-file volumes match by
// dataset name. Returns `undefined` when nothing confidently matches — the
// caller must surface the ambiguity rather than silently binding `sources[0]`.
export const matchActiveSource = (
  sources: readonly LoadedProcessingSource[],
  active: ActiveVolumeIdentity
): LoadedProcessingSource | undefined => {
  const { seriesInstanceUID, name } = active;

  if (seriesInstanceUID) {
    const bySeries = sources.find(
      (s) =>
        s.matchKey?.kind === 'series' &&
        s.matchKey.seriesInstanceUID === seriesInstanceUID
    );
    if (bySeries) return bySeries;
  }

  if (name) {
    const byNameKey = sources.find(
      (s) => s.matchKey?.kind === 'name' && s.matchKey.name === name
    );
    if (byNameKey) return byNameKey;
    // Back-compat: a source from a facade that predates match keys carries
    // only the plain `name` field.
    const byPlainName = sources.find((s) => !s.matchKey && s.name === name);
    if (byPlainName) return byPlainName;
  }

  return undefined;
};
