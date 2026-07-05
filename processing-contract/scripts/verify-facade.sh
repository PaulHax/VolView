#!/usr/bin/env bash
# Fix #8 -- the ACTUAL cross-repo drift guard. The facade's own tests can only
# self-certify its vendored copy (present, well-formed, internally consistent);
# only the client (the normative source) can prove that copy is CURRENT, and only
# where the facade tree is reachable. Regenerate the client contract, then diff
# the canonical client tree against the facade's vendored copy. A nonzero exit
# means the facade is stale -- someone regenerated the contract without re-running
# sync-facade.sh.
#
#   processing-contract/scripts/verify-facade.sh [FACADE_REPO]
# FACADE_REPO defaults to the sibling checkout used in the dev/GATE-L stack.
#
# Honest scope: no existing CI job checks out BOTH repos, so this is enforceable
# on the dev machine / pre-push today. To make it CI-enforced, add a combined job
# that checks out the facade alongside the client and runs this script (see
# workflow/DECISIONS-LOG.md). When the facade tree is absent it self-skips (exit
# 0, loud) so standalone client CI stays green -- mirroring the facade's live-e2e
# self-skip convention.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_dir="$(dirname "$here")"
facade_repo="${1:-$HOME/src/dsa/girder_volview}"
dest="$facade_repo/tests/contract"

if [ ! -d "$dest" ]; then
  echo "verify-facade: facade tree not present ($dest) -- SKIPPING." >&2
  echo "  (enforceable only where both repos are checked out: dev machine or a" >&2
  echo "   combined CI job. Standalone client CI cannot see the facade.)" >&2
  exit 0
fi

# Regenerate so we compare against fresh output, never a stale working copy.
(cd "$pkg_dir/.." && npm run --silent contract:generate)

status=0
for sub in fixtures generated; do
  if ! diff -r "$pkg_dir/$sub" "$dest/$sub"; then
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "" >&2
  echo "FACADE CONTRACT IS STALE: the vendored copy differs from the client" >&2
  echo "contract above. Run: processing-contract/scripts/sync-facade.sh" >&2
  exit 1
fi
echo "verify-facade: facade vendored contract is in sync."
