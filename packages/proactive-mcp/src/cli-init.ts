/**
 * proactive-mcp init — 一键生成挂载配置
 *
 * 在当前目录生成 .mcp.json（项目级），让 Claude Code / Kimi Code / Cline
 * 等宿主直接识别挂载 ProactiveAgent MCP server。
 *
 * 用法：
 *   proactive-mcp init            # 已安装模式：指向当前 bundle 自身（node <installed>/dist/index.js）
 *   proactive-mcp init --local    # 开发中：本地源码路径（bun run <repo>/src/index.ts）
 *   proactive-mcp init --kimi     # 同时写入 Kimi 专属 ~/.kimi-code/mcp.json（需确认覆盖）
 *
 * 输出：.mcp.json 内容 + 下一步指引。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const SERVER_NAME = 'proactive-agent'

/**
 * 构建 server 配置。
 *
 * 三种模式：
 *  - local:       `--local`，开发中指向仓库源码（bun run <repo>/src/index.ts）
 *  - installed:   默认（从 npm tarball / npm 包安装后），指向当前 bundle 自身（node <self>/dist/index.js），
 *                 不依赖 bun、不依赖未发布的 npm 包引用
 */
function buildServerConfig(local: boolean): Record<string, unknown> {
  if (local) {
    // 本地模式：指向当前仓库的入口（发布前验证用）
    const here = new URL('.', import.meta.url).pathname
    const entry = resolve(here, 'index.ts')
    return {
      command: 'bun',
      args: ['run', entry],
    }
  }
  // 已安装模式：从 dist bundle 的自身位置推断 server 入口。
  // 无论全局安装还是项目级安装，import.meta.url 都指向真实安装路径。
  const self = fileURLToPath(import.meta.url)
  return {
    command: 'node',
    args: [self],
  }
}

/** 生成项目级 .mcp.json（不覆盖已有 proactive-agent 条目，除非 --force） */
export function writeProjectMcp(local: boolean, force: boolean): { path: string; content: string; wrote: boolean } {
  const target = join(process.cwd(), '.mcp.json')
  let existing: Record<string, unknown> = {}
  if (existsSync(target)) {
    try {
      existing = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown>
    } catch {
      existing = {}
    }
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>
  if (servers[SERVER_NAME] && !force) {
    return { path: target, content: JSON.stringify(existing, null, 2), wrote: false }
  }
  servers[SERVER_NAME] = buildServerConfig(local)
  const merged = { ...existing, mcpServers: servers }
  writeFileSync(target, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  return { path: target, content: JSON.stringify(merged, null, 2), wrote: true }
}

/** Kimi 用户级配置（~/.kimi-code/mcp.json），--kimi 时尝试写入 */
export function writeKimiUserMcp(local: boolean, force: boolean): { path?: string; wrote: boolean; skipped: boolean } {
  const home = process.env.HOME ?? ''
  if (!home) return { wrote: false, skipped: true }
  const target = join(home, '.kimi-code', 'mcp.json')
  let existing: Record<string, unknown> = {}
  if (existsSync(target)) {
    try {
      existing = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown>
    } catch {
      existing = {}
    }
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>
  if (servers[SERVER_NAME] && !force) return { path: target, wrote: false, skipped: false }
  servers[SERVER_NAME] = buildServerConfig(local)
  writeFileSync(target, JSON.stringify({ ...existing, mcpServers: servers }, null, 2) + '\n', 'utf-8')
  return { path: target, wrote: true, skipped: false }
}

export function runInit(args: string[]): void {
  const local = args.includes('--local')
  const kimi = args.includes('--kimi')
  const force = args.includes('--force')

  const project = writeProjectMcp(local, force)
  if (project.wrote) {
    console.log(`✅ 已写入项目级配置: ${project.path}`)
  } else {
    console.log(`ℹ️  ${project.path} 已存在 proactive-agent 条目（用 --force 覆盖）:`)
  }
  console.log(project.content)
  console.log()

  if (kimi) {
    const km = writeKimiUserMcp(local, force)
    if (km.skipped) {
      console.log('ℹ️  未写入 Kimi 用户级配置（无法确定 HOME）')
    } else if (km.wrote) {
      console.log(`✅ 已写入 Kimi 用户级配置: ${km.path}`)
    } else {
      console.log(`ℹ️  ${km.path} 已存在 proactive-agent 条目（用 --force 覆盖）`)
    }
    console.log()
  }

  console.log('下一步：')
  console.log('  1. 在支持 MCP 的 agent（Claude Code / Kimi Code / Cline / Cursor）中启动会话')
  console.log('  2. 数据默认存 ~/.proma-proactive/（用户级一份共享），用 PROACTIVE_DATA_DIR 可改')
  console.log('  3. 试试 memory_capture / memory_recall / suggest_now，或打开 http://127.0.0.1:8737/today')
  console.log('  更多：https://github.com/ConradLu2740/ProactiveAgent')
}
