/**
 * proactive-mcp init — 一键生成挂载配置
 *
 * 在当前目录生成 .mcp.json（项目级），让 Claude Code / Kimi Code / Cline
 * 等宿主直接识别挂载 ProactiveAgent MCP server。
 *
 * 用法：
 *   proactive-mcp init            # 已安装模式：指向当前 bundle 自身（node <installed>/dist/index.js）
 *   proactive-mcp init --local    # 开发中：本地源码路径（bun run <repo>/src/index.ts）
 *   proactive-mcp init --kimi     # 同时写入 Kimi 专属 ~/.kimi-code/mcp.json + agents/proactive.md 主动 Agent 模板
 *   proactive-mcp init --dry-run  # 只打印将要生成的配置，不写盘（全链路零落盘）
 *
 * 输出：.mcp.json 内容 + 下一步指引。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve, dirname } from 'node:path'

const SERVER_NAME = 'proactive-agent'

/**
 * Kimi Code 主动 Agent 模板（~/.kimi-code/agents/proactive.md）。
 * Kimi 0.34 hooks 系统不可用（实测 SessionStart/UserPromptSubmit 均不触发），
 * 主动行为改为「提示词驱动」：模型按系统提示词主动调用 MCP 工具。
 * 使用：kimi --agent proactive（或 --agent-file 指定）。
 * 注意：${base_prompt} 是 Kimi 模板变量（嵌入默认系统提示词），此处转义防止 JS 插值。
 */
export const KIMI_AGENT_TEMPLATE = `---
name: proactive
description: Proactive Agent 模式：挂载主动记忆与主动建议系统（@proactive-agent/mcp）的日常编程助手，跨会话记住用户偏好、纠正与流程，并在合适时机给出建议
whenToUse: 日常开发、需要长期记忆与主动建议的任何会话
override: false
---

# 你的身份

你是 Kimi Code 的主 Agent，已挂载 **ProactiveAgent 记忆系统**（MCP server: \`proactive-agent\`）。
除了正常编程能力，你要**主动**使用记忆工具：让每次会话都"记得"用户，也让知识跨工具共享。

# 主动记忆规则

## 1. 会话开始时（第一次与用户交互前）

按需调用以下工具注入上下文，避免让用户重复自己：

- \`persona_get\`：读取用户画像（语言偏好、工具栈、工作习惯）。**默认用中文回复**，除非画像显示用户偏好其他语言。
- \`scene_summary\`：查看近期热点场景（最近在做什么，判断当前任务是否有历史上下文）。
- \`daily_review\`：今日复盘模板（适合每日回顾场景；这是工具不是资源，直接调用）。
- \`onboarding_guide\`：用户首次使用系统时的引导说明（新用户场景才用）。

如果这些信息已经在当前上下文中，不要重复调用。

## 2. 对话过程中

- 用户明确表达**偏好、事实、约束、纠正**（如"以后都用 X"、"我不喜欢 Y"、"记得先写测试再提交"）→ 立即调用 \`memory_capture\` 写入长期记忆（type 参考：\`preference\` / \`fact\` / \`correction\` / \`sop\` / \`todo_context\`）。
- ⚠️ **否定词必须保留**："不要用 X" 必须记成"不要用 X"，绝不能删掉"不要"——这是核心语义。
- 需要回忆用户历史上下文（"我之前说过什么"、"这个项目有什么约定"）→ 调用 \`memory_recall\`，带 1-3 个关键词（如 \`pnpm\`、\`部署\`）。
- 不确定该不该主动开口/给建议时 → 调用 \`suggest_now\` 判断（**"该沉默时沉默"也是能力**，别打扰）。
- 系统给出建议时 → \`suggest_list\` 查看、\`suggest_accept\` / \`suggest_ignore\` 反馈（让建议越来越准）。

## 3. 会话收尾或重大节点

- 调用 \`memory_extract\` 把本会话值得长期记住的内容沉淀为记忆（默认待确认，用户确认后才生效——不要试图绕过确认）。
- 存在待确认记忆时 → 提醒用户用 \`memory_confirm\` / \`memory_reject\` 确认或拒绝。

# 记忆使用原则

- 记忆是**跨工具共享**的（Claude Code / Cline / Cursor / Kimi Code 读同一份数据），写入要中立、可复用、不泄露密钥。
- 记忆要简洁自包含（一句话，通常 10-60 字），不写流水账。
- 用户纠正你的行为时，优先理解为长期规则写入记忆，而不是只道歉。
- 不要编造记忆：只记对话中明确出现的信息。

# 行为基调

- 简洁直接，不啰嗦；中文优先（除非用户画像偏好其他语言）。
- 该记就记，不该记不硬记；该沉默时沉默。
- 一切仍按默认编程助手行为工作。

\${base_prompt}
`

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
  console.log('  • Claude Code：hooks 已配置（会话事件写入统一事件流）')
  console.log('  • Kimi Code：MCP 已配置；0.34 hooks 系统不可用（实测不触发），改用 agents/proactive.md 提示词驱动主动（kimi --agent proactive）')
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
): { path?: string; wrote: boolean; skipped: boolean; error?: string; reason?: 'exists' | 'dry-run' | 'wrote' } {
  const home = process.env.HOME ?? ''
  if (!home) return { wrote: false, skipped: true }
  const target = join(home, '.kimi-code', 'mcp.json')
  const existing = readJsonSafe(target)
  if (existing === null) {
    return { path: target, wrote: false, skipped: false, error: `${target} 不是合法 JSON，已拒绝覆盖。请先修复该文件再重试。` }
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>
  if (servers[SERVER_NAME] && !force) return { path: target, wrote: false, skipped: false, reason: 'exists' }
  servers[SERVER_NAME] = buildServerConfig(local).config
  if (dryRun) return { path: target, wrote: false, skipped: false, reason: 'dry-run' }
  mkdirSync(join(home, '.kimi-code'), { recursive: true })
  writeFileSync(target, JSON.stringify({ ...existing, mcpServers: servers }), 'utf-8')
  return { path: target, wrote: true, skipped: false, reason: 'wrote' }
}

/**
 * Kimi 主动 Agent 模板（~/.kimi-code/agents/proactive.md），--kimi 时写入。
 * - 目录不存在时自动创建
 * - 已存在且非 force → 跳过（保留用户自定义）
 * - dryRun → 零写盘
 */
export function writeKimiAgentFile(
  force: boolean,
  dryRun = false,
): { path?: string; wrote: boolean; skipped: boolean; reason?: 'exists' | 'dry-run' | 'wrote' } {
  const home = process.env.HOME ?? ''
  if (!home) return { wrote: false, skipped: true }
  const target = join(home, '.kimi-code', 'agents', 'proactive.md')
  if (existsSync(target) && !force) return { path: target, wrote: false, skipped: false, reason: 'exists' }
  if (dryRun) return { path: target, wrote: false, skipped: false, reason: 'dry-run' }
  mkdirSync(join(home, '.kimi-code', 'agents'), { recursive: true })
  writeFileSync(target, KIMI_AGENT_TEMPLATE, 'utf-8')
  return { path: target, wrote: true, skipped: false, reason: 'wrote' }
}

/** Kimi config.toml 权限预配置建议（打印给用户，不自动改文件） */
export function kimiPermissionHint(): string {
  return [
    '# ~/.kimi-code/config.toml 可选权限预配置（减少审批打扰；只读工具可全授，写类保留手动）',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__persona_get"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__memory_recall"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__scene_summary"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__memory_stats"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__suggest_now"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__daily_review"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__onboarding_guide"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__memory_pending"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__suggest_list"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__card_list"',
    '[[permission.rules]]',
    'decision = "allow"',
    'pattern = "mcp__proactive-agent__card_get"',
  ].join('\n')
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
    } else if (km.reason === 'exists') {
      console.log(`ℹ️  ${km.path} 已存在 proactive-agent 条目（用 --force 覆盖）`)
    } else if (km.reason === 'dry-run') {
      console.log(`ℹ️  将写入 Kimi 用户级配置: ${km.path}（dry-run 未写盘）`)
    } else {
      console.log(`✅ 已写入 Kimi 用户级配置: ${km.path}${previewLabel}`)
    }
    console.log()

    const ka = writeKimiAgentFile(force, dryRun)
    if (ka.skipped) {
      console.log('ℹ️  未写入 Kimi Agent 模板（无法确定 HOME）')
    } else if (ka.reason === 'exists') {
      console.log(`ℹ️  ${ka.path} 已存在（用 --force 覆盖；首次使用：kimi --agent proactive）`)
    } else if (ka.reason === 'dry-run') {
      console.log(`ℹ️  将写入 Kimi 主动 Agent 模板: ${ka.path}（dry-run 未写盘）`)
    } else {
      console.log(`✅ 已写入 Kimi 主动 Agent 模板: ${ka.path}${previewLabel}`)
    }
    console.log()
    console.log('Kimi 权限预配置建议（写入 ~/.kimi-code/config.toml，可选）：')
    console.log(kimiPermissionHint())
    console.log()
    console.log('Kimi 使用：kimi --agent proactive 启动会话（0.34 hooks 不可用，由提示词驱动主动记忆）')
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
