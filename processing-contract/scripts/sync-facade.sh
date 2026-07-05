#!/usr/bin/env bash
# Vendor the processing-contract fixtures + generated JSON Schemas into the
# girder_volview facade so its tests consume the SAME artifacts (D4: one
# normative source in VolView, a synced copy in the facade — never hand-edited).
#
# Usage:
#   processing-contract/scripts/sync-facade.sh [FACADE_REPO]
# FACADE_REPO defaults to the sibling checkout used in the dev/GATE-L stack.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_dir="$(dirname "$here")"
facade_repo="${1:-$HOME/src/dsa/girder_volview}"
dest="$facade_repo/tests/contract"

if [ ! -d "$facade_repo" ]; then
  echo "facade repo not found: $facade_repo" >&2
  exit 1
fi

# Regenerate the JSON Schemas + the published OpenAPI first so the copy is never
# stale (both land in generated/, both are vendored below). One entry point wraps
# BOTH generators so the pipeline cannot be run half-way (Chunk 29).
(cd "$pkg_dir/.." && npm run --silent contract:generate)

mkdir -p "$dest"
rm -rf "$dest/fixtures" "$dest/generated"
cp -R "$pkg_dir/fixtures" "$dest/fixtures"
cp -R "$pkg_dir/generated" "$dest/generated"

# Write a content-addressed manifest over EVERYTHING copied so the vendored copy
# is tamper-evident (Chunk 29): the facade's test_contract_manifest re-hashes
# these files against it, catching a hand-edited fixture AND a stale/partial sync
# (a file present-but-unlisted or listed-but-missing both fail the re-hash). The
# manifest itself is excluded (it lives at the tests/contract root, outside the
# copied subtrees). Sorted for a deterministic, diff-friendly manifest.
(
  cd "$dest"
  find fixtures generated -type f -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256
)

echo "synced fixtures + generated schemas (+ MANIFEST.sha256) -> $dest"
