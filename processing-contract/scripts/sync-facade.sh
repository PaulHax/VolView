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
# stale (both land in generated/, both are vendored below).
(cd "$pkg_dir/.." && npx tsx processing-contract/scripts/generate-json-schema.ts)
(cd "$pkg_dir/.." && npx tsx processing-contract/scripts/generate-openapi.ts)

mkdir -p "$dest"
rm -rf "$dest/fixtures" "$dest/generated"
cp -R "$pkg_dir/fixtures" "$dest/fixtures"
cp -R "$pkg_dir/generated" "$dest/generated"

echo "synced fixtures + generated schemas -> $dest"
