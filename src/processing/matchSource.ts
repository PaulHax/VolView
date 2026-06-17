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

// Of the sources satisfying `predicate`, return the single match. A non-DICOM
// dataset name is not guaranteed unique within a folder, so >1 match is
// ambiguous: warn and refuse to bind rather than silently picking the first —
// the exact wrong-volume failure this module exists to prevent. Zero matches
// returns `undefined` so the caller can try the next key.
const soleMatch = (
  sources: readonly LoadedProcessingSource[],
  predicate: (s: LoadedProcessingSource) => boolean,
  name: string
): LoadedProcessingSource | undefined => {
  const matches = sources.filter(predicate);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.warn(
      `[analysis] ${matches.length} advertised sources share the name "${name}"; ` +
        'refusing to auto-bind an ambiguous match.'
    );
  }
  return undefined;
};

// Bind the on-screen volume to exactly one advertised source. DICOM volumes
// match by SeriesInstanceUID (their names come from headers, not filenames, so
// name matching "would always fail") — a UID is globally unique, so its first
// match is the only match. Non-DICOM single-file volumes match by dataset name,
// which is *not* unique, so only an unambiguous (exactly-one) name match binds.
// Returns `undefined` when nothing matches, or when a name is ambiguous — the
// caller must surface that rather than silently binding `sources[0]`.
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
    const byNameKey = soleMatch(
      sources,
      (s) => s.matchKey?.kind === 'name' && s.matchKey.name === name,
      name
    );
    if (byNameKey) return byNameKey;
    // Back-compat: a source from a facade that predates match keys carries
    // only the plain `name` field.
    const byPlainName = soleMatch(
      sources,
      (s) => !s.matchKey && s.name === name,
      name
    );
    if (byPlainName) return byPlainName;
  }

  return undefined;
};
