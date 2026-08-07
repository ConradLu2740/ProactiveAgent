#!/usr/bin/env bash
# ProactiveAgent MCPB bundle 打包脚本
#
# 用途: Smithery 改版后仅支持 HTTP URL 或 MCPB bundle 两种发布方式
#       （旧 smithery.yaml GitHub 集成已废弃）。本脚本把 @proactive-agent/mcp
#       的单文件零依赖产物打包为 .mcpb（MCP Bundle），供:
#         smithery mcp publish ./dist-publish/proactive-agent-<VERSION>.mcpb -n <org>/proactive-agent
#
# 用法:
#   bash scripts/pack-mcpb.sh            # 直接基于现有 dist-publish 产物打包
#   bash scripts/pack-mcpb.sh --build    # 先跑 publish-proactive.sh --build-only 再打包
#
# 产物: dist-publish/proactive-agent-<VERSION>.mcpb
#
# 注意: mcpb CLI 的 manifest schema（v0.3）只允许 tools 含 name/description，
#       但 Smithery 服务端要求每个 tool 有 inputSchema。因此本脚本：
#         1) 先用 mcpb pack 生成标准结构包
#         2) 再以运行时 tools/list 真实 schema 重建 manifest 并替换 zip 内的 manifest.json
#
# 参考:
#   https://github.com/modelcontextprotocol/mcpb
#   https://claude.com/docs/connectors/building/mcpb

set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLISH_DIR="$ROOT/dist-publish"
MCPB_DIR="$PUBLISH_DIR/mcpb"

if [ "${1:-}" = "--build" ]; then
  echo "==> 先构建 dist-publish 产物"
  bash "$ROOT/scripts/publish-proactive.sh" --build-only
fi

# 从发布产物读取版本（避免与 publish-proactive.sh 的 VERSION 再次漂移）
if [ ! -f "$PUBLISH_DIR/mcp/package.json" ]; then
  echo "错误: 缺少 $PUBLISH_DIR/mcp/package.json，请先构建（bash scripts/publish-proactive.sh --build-only 或 bash scripts/pack-mcpb.sh --build）"
  exit 1
fi
VERSION="$(python3 -c "import json;print(json.load(open('$PUBLISH_DIR/mcp/package.json'))['version'])")"
echo "==> 版本: $VERSION"

# ---- 组装 MCPB 目录结构 ----
rm -rf "$MCPB_DIR"
mkdir -p "$MCPB_DIR/server/hooks"

cp "$PUBLISH_DIR/mcp/dist/index.js" "$MCPB_DIR/server/index.js"
cp "$PUBLISH_DIR/mcp/dist/hooks/"*.js "$MCPB_DIR/server/hooks/" 2>/dev/null || true
cp "$PUBLISH_DIR/mcp/README.md" "$MCPB_DIR/" 2>/dev/null || true
cp "$PUBLISH_DIR/mcp/LICENSE" "$MCPB_DIR/" 2>/dev/null || true
cp "$PUBLISH_DIR/mcp/CHANGELOG.md" "$MCPB_DIR/" 2>/dev/null || true

# server/package.json: type=module 保证 node 以 ESM 加载 index.js
cat > "$MCPB_DIR/server/package.json" <<EOF
{"name":"@proactive-agent/mcpb-server","private":true,"type":"module","version":"$VERSION"}
EOF

# ---- manifest.json（mcpb CLI 可校验的基础版，tools 仅含 name/description） ----
cat > "$MCPB_DIR/manifest.json" <<EOF
{
  "manifest_version": "0.3",
  "name": "proactive-agent",
  "display_name": "ProactiveAgent MCP",
  "version": "$VERSION",
  "description": "ProactiveAgent MCP Server: proactive memory + suggestions as pluggable MCP tools/resources/prompts for any MCP-capable agent (Claude Code, Kimi Code, Cline, Cursor).",
  "long_description": "ProactiveAgent 是一个带主动性的 MCP server：\\n\\n- **主动记忆**：自动/手动沉淀长期记忆（事实、偏好、流程、纠正），支持召回、提取、统计、确认/拒绝工作流。\\n- **主动建议**：基于记忆与当前上下文生成可执行的主动建议，支持接受/忽略反馈闭环。\\n- **辅助能力**：人格画像（persona）、场景总结（scene）、会话中途/结束信号、每日复盘 prompt、冷启动 onboarding。\\n\\n数据默认存储在 ~/.proma-proactive/（用户级共享，跨工具复用），可用 PROACTIVE_DATA_DIR 环境变量覆盖。\\n\\n适用于任何支持 MCP 的 agent 客户端（Claude Code、Kimi Code、Cline、Cursor 等）。",
  "author": {
    "name": "ProactiveAgent contributors",
    "url": "https://github.com/ConradLu2740/ProactiveAgent"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/ConradLu2740/ProactiveAgent.git"
  },
  "homepage": "https://github.com/ConradLu2740/ProactiveAgent",
  "documentation": "https://github.com/ConradLu2740/ProactiveAgent/blob/main/packages/proactive-mcp/README.md",
  "support": "https://github.com/ConradLu2740/ProactiveAgent/issues",
  "license": "MIT",
  "icon": "icon.png",
  "keywords": ["mcp", "memory", "proactive", "suggestions", "agent", "claude", "recall", "persona"],
  "server": {
    "type": "node",
    "entry_point": "server/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["\${__dirname}/server/index.js"],
      "env": {}
    }
  },
  "prompts_generated": true,
  "tools_generated": true,
  "compatibility": {
    "platforms": ["darwin", "win32", "linux"],
    "runtimes": {
      "node": ">=18.0.0"
    }
  }
}
EOF

# icon: 从 social-preview 中心裁方形（存在则复用，否则跳过；icon 为可选字段）
if [ -f "$ROOT/.github/social-preview.png" ]; then
  python3 - <<PYEOF
from PIL import Image
img = Image.open("$ROOT/.github/social-preview.png")
w, h = img.size
side = min(w, h)
square = img.crop(((w-side)//2, (h-side)//2, (w-side)//2+side, (h-side)//2+side)).resize((512,512), Image.LANCZOS)
square.save("$MCPB_DIR/icon.png")
print("icon: 512x512 已生成")
PYEOF
fi

# ---- 校验 + 打包（基础包） ----
echo "==> validate (base manifest)"
bunx mcpb validate "$MCPB_DIR/manifest.json"

OUT="$PUBLISH_DIR/proactive-agent-$VERSION.mcpb"
echo "==> pack (base bundle)"
bunx mcpb pack "$MCPB_DIR" "$OUT"

# ---- 用运行时真实 tools/list schema 重建完整 manifest 并替换 zip 内 manifest.json ----
echo "==> 提取运行时 tools/list 真实 schema"
SMOKE_DIR="$(mktemp -d)"
(cd "$SMOKE_DIR" && unzip -q "$OUT")
node -e "
const { spawn } = require('node:child_process');
const path = require('node:path');
const cp = spawn('node', [path.join('$SMOKE_DIR', 'server/index.js')], { stdio: ['pipe','pipe','pipe'] });
let out = '';
cp.stdout.on('data', d => { out += d.toString(); });
cp.stderr.on('data', () => {});
setTimeout(() => {
  cp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'packer',version:'1.0'}}}) + '\n');
  setTimeout(() => {
    cp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}}) + '\n');
  }, 1200);
}, 500);
setTimeout(() => {
  cp.kill();
  const lines = out.trim().split('\n');
  let tools = [];
  for (const l of lines) {
    try {
      const d = JSON.parse(l);
      if (d.result && Array.isArray(d.result.tools)) { tools = d.result.tools; break; }
    } catch {}
  }
  if (!tools.length) { console.error('tools/list 提取失败'); process.exit(1); }
  require('fs').writeFileSync('$SMOKE_DIR/tools-array.json', JSON.stringify(tools));
  console.log('tools/list:', tools.length, 'tools');
}, 5000);
"
python3 - <<PYEOF
import json, zipfile, os
tools = json.load(open("$SMOKE_DIR/tools-array.json"))
full = json.load(open("$MCPB_DIR/manifest.json"))
# 每个 tool 保留 name/inputSchema/description/title/execution（Smithery ServerCard.Tool）
smithery_tools = []
for t in tools:
    e = {"name": t["name"], "inputSchema": t.get("inputSchema", {"type": "object", "properties": {}, "required": []})}
    for k in ("description", "title", "execution"):
        if t.get(k): e[k] = t[k]
    smithery_tools.append(e)
full["tools"] = smithery_tools

tmp = "$OUT.tmp"
with zipfile.ZipFile("$OUT", "r") as zin:
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "manifest.json":
                data = json.dumps(full, ensure_ascii=False, indent=2).encode("utf-8")
                item.file_size = len(data)
            zout.writestr(item, data)
os.replace(tmp, "$OUT")

# 验证
with zipfile.ZipFile("$OUT") as z:
    m = json.loads(z.read("manifest.json"))
    assert all("inputSchema" in t for t in m["tools"]), "manifest tools missing inputSchema"
    print("zip manifest 已更新: tools =", len(m["tools"]), "| 全部含 inputSchema ✓")
PYEOF

rm -rf "$SMOKE_DIR"

echo ""
echo "==> 打包完成: $OUT"
ls -lh "$OUT"
echo ""
echo "下一步发布（需 Smithery 登录 + 用户确认）:"
echo "  smithery mcp publish $OUT -n <org>/proactive-agent"
