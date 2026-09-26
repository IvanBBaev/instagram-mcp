#!/usr/bin/env bash
# Build a lean, reproducible MCPB bundle from the npm tarball contents.
# Usage: scripts/build-mcpb.sh [repo-dir] [out-dir]   (offline except npm/npx fetches; publishes nothing)
set -euo pipefail
REPO="$(cd "${1:-.}" && pwd)"; OUT="$(mkdir -p "${2:-$REPO}" && cd "${2:-$REPO}" && pwd)"
VERSION="$(node -p "require('$REPO/package.json').version")"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
( cd "$REPO" && npm run build >/dev/null && npm pack --ignore-scripts --pack-destination "$WORK" >/dev/null )
tar xzf "$WORK/instagram-mcp-ai-$VERSION.tgz" -C "$WORK"          # -> $WORK/package (exact npm file allowlist)
cp "$REPO/manifest.json" "$REPO/package-lock.json" "$WORK/package/"
( cd "$WORK/package" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm package-lock.json )
[ "$(node -p "require('$WORK/package/manifest.json').version")" = "$VERSION" ] || { echo "manifest.json version != $VERSION" >&2; exit 1; }
npx -y @anthropic-ai/mcpb@2 validate "$WORK/package/manifest.json"
npx -y @anthropic-ai/mcpb@2 pack "$WORK/package" "$OUT/instagram-mcp-ai-$VERSION.mcpb"
echo "Built $OUT/instagram-mcp-ai-$VERSION.mcpb"
