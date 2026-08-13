#!/usr/bin/env bash
# 版本统一同步脚本（Single Source of Truth）
#
# 真相源：根 package.json 的 "version" 字段 = 主版本（core + mcp + kimi-plugin 共享）。
#   @proactive-agent/adapters 为独立版本线，以 packages/proactive-adapters/package.json 为准。
#
# 发布新版本的标准流程：
#   1. 修改根 package.json 的 version（唯一需要手工改动的地方）
#   2. 若 adapters 同步发版，修改 packages/proactive-adapters/package.json 的 version
#   3. 运行:  npm run sync:version   （= bash scripts/sync-version.sh）
#   4. 运行:  npm run build          （publish-proactive.sh 会自动从根 package.json 读取版本）
#
# 本脚本幂等，可重复运行。改写只用「字符串替换」，不重写整个 JSON，
# 避免 JSON.parse + JSON.stringify 把紧凑单行字段（files/engines）展开成多行导致 diff 噪音。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node <<'NODE'
const fs = require('fs');
const read = (p) => fs.readFileSync(p, 'utf8');

// 1. 单一真相源：根 package.json version
const master = JSON.parse(read('package.json')).version;
if (!/^\d+\.\d+\.\d+/.test(master)) {
  console.error(`✗ 非法版本号: "${master}"（根 package.json）`);
  process.exit(1);
}
console.log(`主版本（根 package.json）: ${master}`);

// 2. 同步 core / mcp 的顶层 version（字符串替换，保留原格式）
for (const name of ['packages/proactive-core/package.json', 'packages/proactive-mcp/package.json']) {
  const src = read(name);
  const next = src.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${master}"`);
  if (next !== src) { fs.writeFileSync(name, next); console.log(`  ✅ ${name} -> ${master}`); }
  else { console.log(`  =  ${name} 已一致 (${master})`); }
}

// 3. adapters 独立版本线（只读，不随主版本联动）
const adaptersVer = JSON.parse(read('packages/proactive-adapters/package.json')).version;
console.log(`adapters 独立版本: ${adaptersVer}（不随主版本联动，如需发版单独改 packages/proactive-adapters/package.json）`);

// 4. kimi.plugin.json：version 字段 + mcpServers args 里的 @proactive-agent/mcp@<ver> 联动
const pluginPath = 'kimi-plugin/kimi.plugin.json';
if (fs.existsSync(pluginPath)) {
  const src = read(pluginPath);
  let next = src.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${master}"`);
  next = next.replace(/@proactive-agent\/mcp@[^"\s]+/g, `@proactive-agent/mcp@${master}`);
  if (next !== src) { fs.writeFileSync(pluginPath, next); console.log(`  ✅ ${pluginPath} -> ${master}`); }
  else { console.log(`  =  ${pluginPath} 已一致 (${master})`); }
} else {
  console.log(`  ⚠️  未找到 ${pluginPath}，跳过`);
}
NODE

# 5. package-lock.json：交给 npm 同步（workspace 包版本 + 顶层 version 字段）
#    用 --package-lock-only 只改 lock 不装依赖，--ignore-scripts 防 side-effect。
echo "==> 同步 package-lock.json（npm install --package-lock-only）"
if npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null 2>&1; then
  echo "  ✅ package-lock.json 已同步"
else
  echo "  ⚠️  npm install --package-lock-only 失败，请手动检查 package-lock.json"
fi

echo ""
echo "==> 同步完成。当前各处版本："
node -e "console.log('  root       :', require('./package.json').version)"
node -e "console.log('  core       :', require('./packages/proactive-core/package.json').version)"
node -e "console.log('  mcp        :', require('./packages/proactive-mcp/package.json').version)"
node -e "console.log('  adapters   :', require('./packages/proactive-adapters/package.json').version)"
node -e "console.log('  kimi-plugin:', require('./kimi-plugin/kimi.plugin.json').version)"
