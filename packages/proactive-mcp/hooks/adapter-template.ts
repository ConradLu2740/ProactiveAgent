/**
 * adapter-template — 新工具事件捕获 adapter 脚手架（方式 B：event-capture 同构）
 *
 * 复制本文件为 hooks/<tool>-adapter.ts，改 tool 名与字段适配即可接入新工具。
 * 构建：在 packages/proactive-mcp 下执行 bash ../../scripts/build-hooks.sh
 *       （build-hooks.sh 的 for 循环里加上 <tool>-adapter）
 * 接入：工具在事件点执行 node dist/hooks/<tool>-adapter.js，stdin 传 JSON。
 *
 * 事件协议见 docs/developers/adapter-guide.md。
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { recordMessage, recordLifecycle, writeAgentEvent, currentProjectKey, type AgentTool } from '../src/event-store'

/** ⚠️ 改成你的工具名（白名单：claude/cursor/codex/kimi/cline/continue）。保持默认会打印警告 */
const TOOL: AgentTool = 'cline'
if (TOOL === 'cline' && !process.env.PA_ADAPTER_TOOL_CONFIRMED) {
  console.warn('[adapter-template] 请把 TOOL 改成你的工具名（当前为占位 cline，事件会记到 cline）')
}

interface AdapterInput {
  event?: string
  /** 工具自己的事件名（示例映射在 normalizeEvent 里） */
  toolEvent?: string
  role?: string
  text?: string
  message?: string
  session_id?: string
  sessionId?: string
  cwd?: string
}

/** 把工具自己的事件字段归一化（示例：按需扩展；start/end 用精确词避免误匹配 restart） */
function normalize(input: AdapterInput): { event: string; text?: string; sid?: string } {
  const raw = input.event ?? input.toolEvent ?? ''
  const e = raw.toLowerCase()
  if (e === 'session_start' || e === 'start' || e === 'sessionstart') return { event: 'start', sid: input.sessionId ?? input.session_id }
  if (e === 'session_end' || e === 'end' || e === 'stop' || e === 'sessionend') return { event: 'end', sid: input.sessionId ?? input.session_id }
  if (e.includes('commit')) return { event: 'commit', text: input.message, sid: input.sessionId ?? input.session_id }
  if (e === 'message' || e === 'msg' || e.includes('prompt')) return { event: 'message', text: input.text, sid: input.sessionId ?? input.session_id }
  return { event: e, text: input.text, sid: input.sessionId ?? input.session_id }
}

/** 用 stdin 的 cwd 解析项目身份（hook 进程短命，chdir 无副作用；与 event-capture 一致） */
function resolvePk(cwd?: string): string | undefined {
  if (!cwd) return currentProjectKey()
  const prev = process.cwd()
  try {
    process.chdir(cwd)
    return currentProjectKey()
  } catch {
    return currentProjectKey()
  } finally {
    try {
      process.chdir(prev)
    } catch {
      // 恢复失败不阻断
    }
  }
}

function main(): void {
  let input: AdapterInput = {}
  try {
    const raw = readFileSync(0, 'utf-8')
    if (raw.trim()) input = JSON.parse(raw) as AdapterInput
  } catch {
    return
  }
  const norm = normalize(input)
  const opts = { sid: norm.sid, pk: resolvePk(input.cwd) }
  switch (norm.event) {
    case 'start':
      recordLifecycle(TOOL, 'start', opts)
      return
    case 'end':
      recordLifecycle(TOOL, 'end', opts)
      return
    case 'commit':
      if (norm.text) writeAgentEvent({ t: 'commit', tool: TOOL, msg: norm.text.slice(0, 500), ...opts })
      return
    case 'message': {
      const role = input.role === 'assistant' || input.role === 'a' ? 'a' : 'u'
      if (norm.text) recordMessage(TOOL, role, norm.text, opts)
      return
    }
    default:
      return
  }
}

// 仅直接运行时执行（被测试 import 时不读 stdin）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
