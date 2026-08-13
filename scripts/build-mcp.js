/**
 * @proactive-agent/mcp 构建脚本（替代 shell 里的 esbuild CLI 转义注入）
 *
 * 用 esbuild JS API 从 mcp 的 package.json 读取 version 注入 PROACTIVE_MCP_VERSION，
 * 彻底规避 shell 里 --define:...=\"$npm_package_version\" 的引号转义坑（esbuild
 * 收到不带引号的 0.9.2 会报 "Invalid define value"）。
 *
 * 版本真相源：packages/proactive-mcp/package.json 的 version（由 scripts/sync-version.sh 保证与根一致）。
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const root = join(scriptsDir, '..')

const pkg = JSON.parse(readFileSync(join(root, 'packages/proactive-mcp/package.json'), 'utf8'))

await build({
  entryPoints: [join(root, 'packages/proactive-mcp/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  define: { PROACTIVE_MCP_VERSION: JSON.stringify(pkg.version) },
  outfile: join(root, 'packages/proactive-mcp/dist/index.js'),
})

console.log(`build OK: @proactive-agent/mcp@${pkg.version} -> packages/proactive-mcp/dist/index.js`)
