#!/usr/bin/env bash
# Deploy the landing page and the job board to Vercel from a clean export of HEAD.
#
# Why an export and not the working tree: the Vercel CLI attaches the git
# commit, Vercel resolves its author as a GitHub user, and a team that user
# isn't a member of BLOCKS the deployment ("commit author doesn't have
# permission"). A tree with no .git carries no author. The export also leaves
# out contracts/ — 2.4 GB of Rust target and Foundry libraries the sites never use.
#
#   scripts/deploy-web.sh            # both
#   scripts/deploy-web.sh app        # just the job board
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# No defaults on purpose: this repo was copied from the Arbitrum port, and a
# default pointing at its projects would overwrite that live deployment.
# deployments/hosting.env (gitignored) or the environment must name Monad's own.
[ -f "$ROOT/deployments/hosting.env" ] && { set -a; . "$ROOT/deployments/hosting.env"; set +a; }
ORG=${VERCEL_ORG_ID:?set VERCEL_ORG_ID}
# Plain functions, not an associative array: macOS still ships bash 3.2.
project_id() {
  case "$1" in
    landing) echo "${VERCEL_LANDING_PROJECT_ID:?set VERCEL_LANDING_PROJECT_ID (the Monad landing project)}" ;;
    app) echo "${VERCEL_APP_PROJECT_ID:?set VERCEL_APP_PROJECT_ID (the Monad app project)}" ;;
  esac
}
WHICH=${1:-all}

OUT=$(mktemp -d "${TMPDIR:-/tmp}/xorv-web.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
git -C "$ROOT" archive HEAD | tar -x -C "$OUT"
rm -rf "$OUT/contracts"

for name in landing app; do
  [ "$WHICH" = all ] || [ "$WHICH" = "$name" ] || continue
  echo "── $name"
  (cd "$OUT" && VERCEL_ORG_ID=$ORG VERCEL_PROJECT_ID=$(project_id "$name") vercel deploy --prod --yes 2>&1 \
    | grep -E "Aliased|Production:|rror" | tail -2)
done
