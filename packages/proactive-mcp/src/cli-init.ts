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
 *   proactive-mcp init --dry-run  # 只打印将要生成的配置，不写盘（全链路零落盘）
 *
 * 输出：.mcp.json 内容 + 下一步指引。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve, dirname } from 'node:path'

const SERVER_NAME = 'proactive-agent'

/** shell 参数转义：路径含空格时用双引号包裹 */
function shellQuote(p: string): string {
  return /[\s'"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p
}

/**
 * 构建 server 配置。
 *
 * 三种模式：
 *  - local:       `--local`，开发中指向仓库源码（bun run <repo>/src/index.ts）
 *  - installed:   默认（从 npm tarball / npm 包安装后），指向当前 bundle 自身（node <self>/dist/index.js），
 *                 不依赖 bun、不依赖未发布的 npm 包引用
 */
function buildServerConfig(local: boolean): { config: Record<string, unknown>; entryExists: boolean } {
  if (local) {
    // 本地模式：指向当前仓库的入口（发布前验证用）
    const here = new URL('.', import.meta.url).pathname
    const entry = resolve(here, 'index.ts')
    return {
      config: {
        command: 'bun',
        args: ['run', entry],
      },
      entryExists: existsSync(entry),
    }
  }
  // 已安装模式：从 dist bundle 的自身位置推断 server 入口。
  // 无论全局安装还是项目级安装，import.meta.url 都指向真实安装路径。
  const self = fileURLToPath(import.meta.url)
  return {
    config: {
      command: 'node',
      args: [self],
    },
    entryExists: existsSync(self),
  }
}

/**
 * 推断 hooks 绝对路径。
 * dist bundle 自身位置 → dist/hooks/{today-push,session-end,user-prompt,event-capture}.js。
 * 返回 undefined 表示无法推断（源码 dev 模式），调用方据此跳过 hooks 配置。
 */
function inferHooksPaths(): { todayPush: string; sessionEnd: string; userPrompt: string; eventCapture: string } | undefined {
  const self = fileURLToPath(import.meta.url)
  const distDir = dirname(self)
  const hooksDir = join(distDir, 'hooks')
  const todayPush = join(hooksDir, 'today-push.js')
  const sessionEnd = join(hooksDir, 'session-end.js')
  const userPrompt = join(hooksDir, 'user-prompt.js')
  const eventCapture = join(hooksDir, 'event-capture.js')
  if (existsSync(todayPush) && existsSync(sessionEnd) && existsSync(userPrompt) && existsSync(eventCapture)) {
    return { todayPush, sessionEnd, userPrompt, eventCapture }
  }
  return undefined
}

/** 生成 Claude Code hooks 配置（.claude/settings.json 内容），路径经 shell 转义 */
function buildHooksSettings(hooks: { todayPush: string; sessionEnd: string; userPrompt: string }): Record<string, unknown> {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `node ${shellQuote(hooks.todayPush)}` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${shellQuote(hooks.userPrompt)}` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `node ${shellQuote(hooks.sessionEnd)}` }] }],
    },
  }
}

/** 读取 JSON 文件；损坏时返回 null（不静默当空覆盖） */
function readJsonSafe(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 打印跨工具接入指引（0.6 感知网）。
 * 注意：Cursor 官方原生支持加载 .claude/settings.json 的 Claude Code hooks 并自动映射
 * （SessionStart→sessionStart、UserPromptSubmit→beforeSubmitPrompt、Stop→stop），
 * 因此**不再**生成 .cursor/hooks.json（避免双写与 tool 标签失真），依赖官方兼容即可。
 */
function printToolGuide(): void {
  console.log('跨工具感知网（0.6）：')
  console.log('  • Claude Code / Kimi Code：hooks 已配置（会话事件写入统一事件流）')
  console.log('  • Cursor：官方支持加载 Claude Code hooks（.claude/settings.json 自动映射），开启第三方钩子兼容后自动接入，无需额外配置')
  console.log('  • Continue：官方 hooks 配置兼容 Claude Code 的 settings.json 位置与格式（事件名映射可能需按官方文档核对）')
  console.log('  • Codex：生命周期 hooks 需手动接入（Codex 官方 config 文档，命令指向 dist/hooks/event-capture.js）')
  console.log('  • Cline：hooks 走 SDK Plugins 机制（详见 cline 官方文档；或用任意支持命令回调的工具指向 event-capture.js）')
  console.log('  • 事件统一落盘：~/.proma-proactive/events/（仅当前用户可读写），daemon 定时评估自动消费（0.6）')
  console.log()
}


/**
 * 生成项目级 .mcp.json。
 * - 已存在 proactive-agent 条目且非 force → 跳过（保留用户配置）
 * - 其他 server 条目始终保留（合并）
 * - 损坏 JSON → 拒绝写盘，提示先修复（避免静默覆盖丢数据）
 * - dryRun → 零写盘
 */
export function writeProjectMcp(
  local: boolean,
  force: boolean,
  dryRun = false,
): { path: string; content: string; wrote: boolean; skipped: boolean; error?: string } {
  const target = join(process.cwd(), '.mcp.json')
  const existing = readJsonSafe(target)
  if (existing === null) {
    return { path: target, content: '', wrote: false, skipped: false, error: `${target} 不是合法 JSON，已拒绝覆盖。请先修复该文件再重试。` }
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>
  if (servers[SERVER_NAME] && !force) {
    return { path: target, content: JSON.stringify(existing, null, 2), wrote: false, skipped: true }
  }
  const { config, entryExists } = buildServerConfig(local)
  if (local && !entryExists) {
    const args = config.args as string[]
    return { path: target, content: '', wrote: false, skipped: false, error: `--local 指向的入口不存在（${args[1] ?? ''}）。npm 安装用户请去掉 --local 使用发布版入口。` }
  }
  servers[SERVER_NAME] = config
  const merged = { ...existing, mcpServers: servers }
  if (!dryRun) {
    writeFileSync(target, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  }
  return { path: target, content: JSON.stringify(merged, null, 2), wrote: !dryRun, skipped: false }
}

/**
 * Kimi 用户级配置（~/.kimi-code/mcp.json），--kimi 时尝试写入。
 * - 目录不存在时自动创建（防 ENOENT 崩溃）
 * - 损坏 JSON → 拒绝写盘
 * - dryRun → 零写盘
 */
export function writeKimiUserMcp(
  local: boolean,
  force: boolean,
  dryRun = false,
): { path?: string; wrote: boolean; skipped: boolean; error?: string } {
  const home = process.env.HOME ?? ''
  if (!home) return { wrote: false, skipped: true }
  const target = join(home, '.kimi-code', 'mcp.json')
  const existing = readJsonSafe(target)
  if (existing === null) {
    return { path: target, wrote: false, skipped: false, error: `${target} 不是合法 JSON，已拒绝覆盖。请先修复该文件再重试。` }
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>
  if (servers[SERVER_NAME] && !force) return { path: target, wrote: false, skipped: false }
  servers[SERVER_NAME] = buildServerConfig(local).config
  if (!dryRun) {
    mkdirSync(join(home, '.kimi-code'), { recursive: true })
    writeFileSync(target, JSON.stringify({ ...existing, mcpServers: servers }), 'utf-8')
  }
  return { path: target, wrote: !dryRun, skipped: false }
}

/**
 * 生成 Claude Code hooks 配置（.claude/settings.json）。
 * - 事件级合并：已有 SessionStart/Stop 时保留用户自己的钩子，追加 proactive-agent 钩子（不整段清空）
 * - 损坏 JSON → 拒绝写盘
 * - dryRun → 零写盘
 */
export function writeClaudeHooks(
  force: boolean,
  dryRun: boolean,
): { path?: string; wrote: boolean; skipped: boolean; reason?: string; error?: string } {
  const hooks = inferHooksPaths()
  if (!hooks) {
    return { wrote: false, skipped: true, reason: 'hooks 产物不存在（dev 模式或未构建）' }
  }
  const target = join(process.cwd(), '.claude', 'settings.json')
  const existing = readJsonSafe(target)
  if (existing === null) {
    return { path: target, wrote: false, skipped: false, error: `${target} 不是合法 JSON，已拒绝覆盖。请先修复该文件再重试。` }
  }
  const hooksConfig = buildHooksSettings(hooks)
  const existingHooks = (existing.hooks ?? {}) as Record<string, unknown>

  // 事件级合并：只更新我们管理的事件（SessionStart/Stop），
  // 保留用户自己配置的其他事件与钩子；已有 proactive-agent 钩子时跳过（除非 --force）。
  const mergedHooks: Record<string, unknown> = { ...existingHooks }
  const newHooks = hooksConfig.hooks as Record<string, unknown>
  let changed = false
  for (const [event, hookList] of Object.entries(newHooks)) {
    const existingList = (mergedHooks[event] ?? []) as Array<Record<string, unknown>>
    const mergedList = [...existingList]
    const isProactiveHook = (h: Record<string, unknown>) =>
      JSON.stringify(h).includes(SERVER_NAME) ||
      JSON.stringify(h).includes('today-push') ||
      JSON.stringify(h).includes('user-prompt') ||
      JSON.stringify(h).includes('session-end')
    const exists = mergedList.some(isProactiveHook)
    if (exists && !force) {
      continue
    }
    if (exists && force) {
      // --force：替换该事件里我们自己的钩子，保留用户的其他钩子
      const filtered = mergedList.filter((h) => !isProactiveHook(h))
      mergedHooks[event] = [...filtered, ...(hookList as Array<Record<string, unknown>>)]
    } else {
      mergedHooks[event] = [...mergedList, ...(hookList as Array<Record<string, unknown>>)]
    }
    changed = true
  }
  if (!changed && Object.keys(newHooks).length > 0) {
    return { path: target, wrote: false, skipped: false, reason: '已存在 proactive-agent hooks（用 --force 更新）' }
  }
  const merged = { ...existing, hooks: mergedHooks }
  if (!dryRun) {
    mkdirSync(join(process.cwd(), '.claude'), { recursive: true })
    writeFileSync(target, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  }
  return { path: target, wrote: !dryRun, skipped: false }
}

export function runInit(args: string[]): void {
  const local = args.includes('--local')
  const kimi = args.includes('--kimi')
  const force = args.includes('--force')
  const dryRun = args.includes('--dry-run')

  const previewLabel = dryRun ? '（dry-run 预览，未写盘）' : ''

  const project = writeProjectMcp(local, force, dryRun)
  if (project.error) {
    console.log(`❌ ${project.error}`)
    if (dryRun) console.log('   （dry-run 未做任何修改）')
    return
  }
  if (project.wrote) {
    console.log(`✅ 已写入项目级配置: ${project.path}${previewLabel}`)
  } else if (project.skipped) {
    console.log(`ℹ️  ${project.path} 已存在 proactive-agent 条目（用 --force 覆盖）:`)
  } else {
    console.log(`ℹ️  ${project.path}（dry-run 未写盘）:`)
  }
  console.log(project.content)
  console.log()

  if (kimi) {
    const km = writeKimiUserMcp(local, force, dryRun)
    if (km.error) {
      console.log(`❌ ${km.error}`)
      if (dryRun) console.log('   （dry-run 未做任何修改）')
    } else if (km.skipped) {
      console.log('ℹ️  未写入 Kimi 用户级配置（无法确定 HOME）')
    } else if (km.wrote) {
      console.log(`✅ 已写入 Kimi 用户级配置: ${km.path}${previewLabel}`)
    } else {
      console.log(`ℹ️  ${km.path} 已存在 proactive-agent 条目（用 --force 覆盖）`)
    }
    console.log()
  }

  // Claude Code hooks（发布包内置时自动生成）
  const hooks = writeClaudeHooks(force, dryRun)
  if (hooks.error) {
    console.log(`❌ ${hooks.error}`)
    if (dryRun) console.log('   （dry-run 未做任何修改）')
  } else if (dryRun) {
    console.log('🔍 dry-run：未写盘，以下是 hooks 配置预览')
    if (hooks.skipped) {
      console.log(`   ℹ️  ${hooks.reason ?? 'hooks 不可用'}`)
    } else {
      console.log(`   ${hooks.path} -> ${JSON.stringify(buildHooksSettings(inferHooksPaths()!), null, 2)}`)
    }
    console.log()
  } else if (hooks.skipped) {
    console.log(`ℹ️  未生成 Claude Code hooks 配置：${hooks.reason ?? ''}（构建发布包后自动可用）`)
    console.log()
  } else if (hooks.wrote) {
    console.log(`✅ 已写入 Claude Code hooks 配置: ${hooks.path}（会话级主动推送）`)
    console.log()
  } else {
    console.log(`ℹ️  ${hooks.path} 已存在 proactive-agent hooks（用 --force 更新）`)
    console.log()
  }

  printToolGuide()

  console.log('下一步：')
  console.log('  1. 在支持 MCP 的 agent（Claude Code / Kimi Code / Cline / Cursor）中启动会话')
  console.log('  2. 数据按项目隔离（~/.proma-proactive/projects/<key>/），显式共享用 global（0.3.0）')
  console.log('  3. 试试 memory_capture / memory_recall / suggest_now，或打开 http://127.0.0.1:8737/today')
  console.log('  4. 诊断: proactive-mcp doctor · 状态: proactive-mcp stats · 教学: proactive-mcp demo · 迁移: proactive-mcp migrate')
  console.log('  更多：https://github.com/ConradLu2740/ProactiveAgent')
}
