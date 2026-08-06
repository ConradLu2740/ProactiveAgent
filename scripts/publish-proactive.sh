#!/usr/bin/env bash
# ProactiveAgent npm 发布准备脚本
#
# 用法: bash scripts/publish-proactive.sh [--publish]
#   （默认只准备发布目录 dist-publish/，不实际发布）
#   --publish  准备并执行 npm publish（需要已 npm login）
#
# 产物:
#   dist-publish/core/  -> @proactive-agent/core（bundle 单文件，零依赖）
#   dist-publish/mcp/   -> @proactive-agent/mcp （bundle 单文件，零依赖）
#
# 注意: 真实发布是外部公开操作，发布前确认 license 策略与包内容。

set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLISH_DIR="$ROOT/dist-publish"
VERSION="0.3.0-beta.2"
LICENSE="${LICENSE:-MIT}"

echo "==> 构建 bundle"
(cd "$ROOT/packages/proactive-core" && bun run build)
# mcp 构建时注入版本号（--define），保证 --version / serverInfo.version 与发布版本一致
(cd "$ROOT/packages/proactive-mcp" && bun build src/index.ts --target=node --banner '#!/usr/bin/env node' --define "PROACTIVE_MCP_VERSION=\"$VERSION\"" --outfile=dist/index.js)

rm -rf "$PUBLISH_DIR"
mkdir -p "$PUBLISH_DIR/core/dist" "$PUBLISH_DIR/mcp/dist"

# ---- @proactive-agent/core ----
cat > "$PUBLISH_DIR/core/package.json" <<EOF
{
  "name": "@proactive-agent/core",
  "version": "$VERSION",
  "license": "$LICENSE",
  "description": "ProactiveAgent headless engine: proactive memory (capture/recall/persona/scene) + proactive suggestions. Host-agnostic, zero-dependency bundle.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=18" }
}
EOF
cp "$ROOT/packages/proactive-core/dist/index.js" "$PUBLISH_DIR/core/dist/"
# 生成类型声明（tsc 只输出 d.ts）
(cd "$ROOT/packages/proactive-core" && bunx tsc --declaration --emitDeclarationOnly --module esnext --moduleResolution bundler --skipLibCheck --downlevelIteration --target es2022 --outDir "$PUBLISH_DIR/core/dist" src/index.ts 2>/dev/null || echo "  (d.ts 生成失败，可后续补)")
cp "$ROOT/packages/proactive-core/README.md" "$PUBLISH_DIR/core/" 2>/dev/null || true
printf 'MIT License\n\nCopyright (c) 2026 ProactiveAgent contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n' > "$PUBLISH_DIR/core/LICENSE"

# ---- @proactive-agent/mcp ----
cat > "$PUBLISH_DIR/mcp/package.json" <<EOF
{
  "name": "@proactive-agent/mcp",
  "version": "$VERSION",
  "license": "$LICENSE",
  "description": "ProactiveAgent MCP Server: proactive memory + suggestions as pluggable MCP tools/resources/prompts for any MCP-capable agent (Claude Code, Kimi Code, Cline, Cursor).",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "bin": { "proactive-mcp": "./dist/index.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=18" }
}
EOF
cp "$ROOT/packages/proactive-mcp/dist/index.js" "$PUBLISH_DIR/mcp/dist/"
# hooks 编译进发布包（内联 core，node 直接运行；会话级主动推送无需 clone 源码）
mkdir -p "$PUBLISH_DIR/mcp/dist/hooks"
(cd "$ROOT/packages/proactive-mcp" && bun run build:hooks 2>/dev/null || echo "  (hooks 编译跳过)")
cp "$ROOT/packages/proactive-mcp/dist/hooks/today-push.js" "$PUBLISH_DIR/mcp/dist/hooks/" 2>/dev/null || true
cp "$ROOT/packages/proactive-mcp/dist/hooks/session-end.js" "$PUBLISH_DIR/mcp/dist/hooks/" 2>/dev/null || true
(cd "$ROOT/packages/proactive-mcp" && bunx tsc --declaration --emitDeclarationOnly --module esnext --moduleResolution bundler --skipLibCheck --downlevelIteration --target es2022 --outDir "$PUBLISH_DIR/mcp/dist" src/index.ts 2>/dev/null || true)
cp "$ROOT/packages/proactive-mcp/README.md" "$PUBLISH_DIR/mcp/" 2>/dev/null || true
cp "$ROOT/CHANGELOG.md" "$PUBLISH_DIR/mcp/" 2>/dev/null || true
cp "$ROOT/CHANGELOG.md" "$PUBLISH_DIR/core/" 2>/dev/null || true

# 构建后自检：--version 输出必须与发布版本一致（防版本号再次漂移）
VER_CHECK=$(node "$PUBLISH_DIR/mcp/dist/index.js" --version 2>/dev/null || true)
if [ "$VER_CHECK" != "$VERSION" ]; then
  echo "==> ⚠️ 版本号不一致：--version 输出 [$VER_CHECK]，预期 [$VERSION]（dist 可能未重新构建或 define 注入失败）"
  exit 1
fi
echo "==> 版本自检通过: $VER_CHECK"
# ---- @proactive-agent/mcp - NOTICE（第三方组件声明） ----
cat > "$PUBLISH_DIR/mcp/NOTICE" <<'EOF'
This package bundles the following third-party MIT-licensed components:

- @modelcontextprotocol/sdk (https://github.com/modelcontextprotocol/typescript-sdk) — MIT License
  Copyright (c) 2024 Model Context Protocol
- zod (https://github.com/colinhacks/zod) — MIT License
  Copyright (c) 2020 Colin McDonnell

Their license texts are distributed in the respective upstream packages.
EOF
cat > "$PUBLISH_DIR/core/NOTICE" <<'EOF'
@proactive-agent/core is a standalone MIT-licensed implementation.
Type definitions are compatible with @proma/shared (AGPL-3.0) interfaces; no
AGPL implementation code is bundled.
EOF
printf 'MIT License\n\nCopyright (c) 2026 ProactiveAgent contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n' > "$PUBLISH_DIR/mcp/LICENSE"

echo "==> 发布目录已就绪: $PUBLISH_DIR"
ls -lh "$PUBLISH_DIR/core/dist/index.js" "$PUBLISH_DIR/mcp/dist/index.js"

if [ "${1:-}" = "--publish" ]; then
  echo "==> npm login 检查"
  npm whoami >/dev/null 2>&1 || { echo "需要先 npm login"; exit 1; }
  (cd "$PUBLISH_DIR/core" && npm publish --access public)
  (cd "$PUBLISH_DIR/mcp" && npm publish --access public)
  echo "==> 发布完成"
elif [ "${1:-}" = "--build-only" ]; then
  echo "==> CI build-only：发布由 GitHub Actions trusted publishing 执行"
else
  echo "==> 未发布（预览模式）。确认无误后执行: bash scripts/publish-proactive.sh --publish"
fi
