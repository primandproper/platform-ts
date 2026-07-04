#!/usr/bin/env bash
#
# One-time bootstrap: create every @primandproper/* package on npm at a baseline
# version, then hand ongoing releases off to changesets/action (.github/workflows/release.yml).
#
# After this runs once, you never run it again — you author changesets
# (`pnpm changeset`), merge to main, and CI does the rest.
#
# Requirements:
#   - NPM_TOKEN in the environment: an npm automation token with publish rights
#     to the @primandproper scope (the scope/org must already exist on npm).
#   - pnpm + node installed; deps installed (`pnpm install`).
#
# Provenance is intentionally NOT generated here — it needs GitHub Actions OIDC,
# so the baseline release ships without it. Every subsequent CI publish has it.
#
# Usage:
#   ./scripts/first-publish.sh            # publish baseline 0.0.1 (token from .env)
#   ./scripts/first-publish.sh 0.0.1 --dry-run
#
# The token is used ONCE, here, locally — it is never stored in CI. Ongoing
# publishes go through npm Trusted Publishing (OIDC) from release.yml, tokenless.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Convenience: pull the token from .env if present (accepts either name).
if [[ -f .env ]]; then
  set -a; . ./.env; set +a
fi
NPM_TOKEN="${NPM_TOKEN:-${NPM_ACCESS_TOKEN:-}}"
: "${NPM_TOKEN:?set NPM_TOKEN or NPM_ACCESS_TOKEN (npm token with publish rights to @primandproper)}"

BASELINE="0.0.1"
DRY_RUN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) BASELINE="$arg" ;;
  esac
done

# Auth via a throwaway userconfig so the committed .npmrc is never touched.
NPMRC="$(mktemp)"
trap 'rm -f "$NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"
export NPM_CONFIG_USERCONFIG="$NPMRC"

echo "==> Publishing to npm as: $(npm whoami)"
echo "==> Baseline version: ${BASELINE} ${DRY_RUN:+(dry run)}"

# Pin every publishable workspace package to the baseline. pnpm rewrites the
# workspace:* deps to this same version at publish time, so consumers get valid ranges.
node -e '
  const fs = require("fs"), path = require("path");
  const v = process.argv[1];
  let n = 0;
  for (const d of fs.readdirSync("packages")) {
    const p = path.join("packages", d, "package.json");
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (j.private) continue;
    j.version = v;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    n++;
  }
  console.error("==> Set " + n + " packages to " + v);
' "$BASELINE"

pnpm exec prettier --write "packages/*/package.json" > /dev/null
pnpm install >/dev/null # reconcile lockfile importer versions
pnpm build

# -r skips the private root; --no-git-checks tolerates the dirty tree.
echo "==> Publishing all packages..."
pnpm -r publish --no-git-checks --access public ${DRY_RUN}

cat <<EOF

Done. All packages are on npm at ${BASELINE}.

Next steps (one-time), so CI never needs a stored token:
  1. Commit the version bump on a branch and merge it (keeps package.json in
     sync with what's published so changesets computes the next bump correctly):
       git switch -c chore/baseline-0.0.1
       git add packages/*/package.json && git commit -m "chore: baseline release 0.0.1"
  2. Set up npm Trusted Publishing (OIDC) so CI publishes tokenless. For each
     package: npmjs.com > the package > Settings > Trusted publisher > add
       GitHub org/user: primandproper
       repository:      platform-ts
       workflow:        release.yml
     (all packages point at the same workflow). Provenance is then automatic.
  3. In repo Settings > Actions > General, allow "GitHub Actions to create and
     approve pull requests" so the "version packages" PR can be opened.

From here on: \`pnpm changeset\` -> merge to main -> merge the "version packages"
PR -> only the changed packages publish, over OIDC, no token.
EOF
