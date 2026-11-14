#!/usr/bin/env bash
# Replace vendor/provider-claude-code with bb's built-in Claude Code provider
# (plugins/provider-claude-code in https://github.com/get-bb/bb, MIT) at a
# release tag, verbatim. This plugin's own changes live outside vendor/ (see
# server.ts and host.ts), so a sync is: run this, review the diff, run
# `npm test`, `npm run typecheck` and `bb plugin build`.
#
#   scripts/sync-upstream.sh desktop-v0.49.0
set -euo pipefail
tag="${1:?usage: sync-upstream.sh <bb release tag, e.g. desktop-v0.49.0>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q
git -C "$work" remote add origin https://github.com/get-bb/bb.git
git -C "$work" fetch -q --depth 1 --filter=blob:none origin "refs/tags/$tag:refs/tags/$tag"
commit="$(git -C "$work" rev-parse "$tag^{commit}")"
git -C "$work" archive "$tag" plugins/provider-claude-code LICENSE | tar -x -C "$work"

rm -rf "$root/vendor/provider-claude-code"
mkdir -p "$root/vendor"
mv "$work/plugins/provider-claude-code" "$root/vendor/provider-claude-code"
cp "$work/LICENSE" "$root/vendor/LICENSE"
printf 'repository: https://github.com/get-bb/bb\npath: plugins/provider-claude-code\ntag: %s\ncommit: %s\n' \
  "$tag" "$commit" >"$root/vendor/UPSTREAM"
echo "vendor/provider-claude-code is now $tag ($commit)"
grep -E '"(@anthropic-ai/claude-agent-sdk|@modelcontextprotocol/sdk|zod|bbPluginSdk)"' \
  "$root/vendor/provider-claude-code/package.json" | sed 's/^ */  upstream /'
echo "Compare these with package.json, and the upstream server.ts/host.ts with ours."
