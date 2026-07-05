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
  LC_ALL=C find fixtures generated -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > MANIFEST.sha256
)

# --- Provenance stamp (fix #8): make the vendored copy self-describing so a
# reader (and the facade's own test_contract_source) can see WHICH client commit
# / version it was synced from, and self-certify the tree against a single digest.
# This does NOT by itself prove the copy is CURRENT -- that is the client's
# verify-facade.sh step, the only checker that can see both trees. Written OUTSIDE
# fixtures/ + generated/, so it is not covered by MANIFEST.sha256 (which hashes
# only those subtrees); its own integrity rides tree_sha256 below.
contract_version="$(node -p "require('$dest/generated/openapi.json').info.version")"
spec_version="$(grep -oE 'SPEC_VERSION = [0-9]+' "$pkg_dir/task-spec.ts" | grep -oE '[0-9]+')"
intent_version="$(grep -oE 'INTENT_VOCABULARY_VERSION = [0-9]+' "$pkg_dir/wire.ts" | grep -oE '[0-9]+')"
client_sha="$(git -C "$pkg_dir" rev-parse --short HEAD)"
if [ -n "$(git -C "$pkg_dir" status --porcelain -- "$pkg_dir")" ]; then
  client_dirty=true
else
  client_dirty=false
fi
# tree_sha256 = sha256 of MANIFEST.sha256, which already provably equals the
# copied tree, so hashing it transitively certifies fixtures/ + generated/.
tree_sha256="$(sha256sum "$dest/MANIFEST.sha256" | cut -d' ' -f1)"

cat > "$dest/SOURCE.txt" <<EOF
# Provenance of the vendored processing-contract copy.
# Written by processing-contract/scripts/sync-facade.sh -- DO NOT hand-edit.
# tree_sha256 = sha256 of MANIFEST.sha256; the facade test re-derives it.
contract_version=$contract_version
spec_version=$spec_version
intent_vocabulary_version=$intent_version
client_git_sha=$client_sha
client_git_dirty=$client_dirty
tree_sha256=$tree_sha256
EOF

echo "synced fixtures + generated schemas (+ MANIFEST.sha256 + SOURCE.txt) -> $dest"
