#!/usr/bin/env bash
# ProactiveAgent hooks 构建脚本（esbuild，替代原 bun build:hooks）
# 用法: bash ../../scripts/build-hooks.sh  （在 packages/proactive-mcp 下运行）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCP_DIR="$ROOT/packages/proactive-mcp"
cd "$MCP_DIR"

for hook in today-push session-end user-prompt kimi-user-prompt event-capture; do
  npx esbuild "hooks/$hook.ts" \
    --bundle \
    --platform=node \
    --format=esm \
    --banner:js='#!/usr/bin/env node' \
    --outfile="dist/hooks/$hook.js"
  echo "==> built dist/hooks/$hook.js"
done
