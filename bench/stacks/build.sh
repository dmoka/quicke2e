#!/usr/bin/env bash
# Builds every Tier-2 stack app into bench/stacks/dist/<stack>. Deterministic: pinned deps, npm ci.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
for s in vanilla mui antd radix vue-ep wc iframe legacy; do
  echo "build $s"; STACK=$s npx vite build
done
