/**
 * event-capture — 跨工具统一事件捕获入口（0.6 感知网）
 *
 * 任意工具只要能在生命周期事件（会话开始/消息/会话结束/commit）时执行本脚本
 * 并传入 JSON，就能把事件归一化写入 PROACTIVE_DATA_DIR/events/，供 daemon
 * 定时评估消费（真定时评估）。
 *
 * stdin JSON 格式：
 *   { "event": "start|message|end|commit",
 *     "tool": "cursor|codex|cline|continue|...",
 *     "role": "user|assistant"（message 用）,
 *     "text": "消息文本"（message 用）,
 *     "message": "commit 信息"（commit 用）,
 *     "session_id": "...",
 *     "cwd": "/path" }
 *
 * 无事件/失败时静默退出（不污染宿主 stdout/stderr 协议）。
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { recordMessage, recordLifecycle, writeAgentEvent, currentProjectKey, type AgentTool } from '../src/event-store'

interface CaptureInput {
  event?: string
  tool?: string
  role?: string
  text?: string
  message?: string
  session_id?: string
  sessionId?: string
  cwd?: string
  /** Cursor：hook 事件名（如 sessionStart / beforeSubmitPrompt） */
  hookEventName?: string
  hook_event_name?: string
  /** Cursor beforeSubmitPrompt：用户提示词 */
  prompt?: string
  /** Codex：消息文本 */
  input?: string
}

/** 把各工具的事件字段归一化（Cursor/Codex/Claude 差异适配；导出供测试） */
export function normalizeEvent(input: CaptureInput): { event: string; text?: string; sid?: string } {
  const raw = input.event ?? input.hookEventName ?? input.hook_event_name ?? ''
  const e = raw.toLowerCase()
  if (e.includes('sessionstart') || e === 'session_start' || e === 'start') return { event: 'start', sid: input.sessionId ?? input.session_id }
  if (e.includes('sessionend') || e === 'session_end' || e === 'stop' || e === 'end') return { event: 'end', sid: input.sessionId ?? input.session_id }
  // commit 优先于 message（避免 'commit_message' 被 message 分支抢占）
  if (e.includes('commit')) return { event: 'commit', text: input.message ?? input.text, sid: input.sessionId ?? input.session_id }
  if (
    e.includes('beforeprompt') ||
    (e.includes('before') && e.includes('prompt')) ||
    e.includes('submitprompt') ||
    e === 'user_prompt' ||
    e === 'message' ||
    e === 'msg'
  ) {
    return { event: 'message', text: input.prompt ?? input.text ?? input.input, sid: input.sessionId ?? input.session_id }
  }
  return { event: e, text: input.prompt ?? input.text ?? input.input, sid: input.sessionId ?? input.session_id }
}

/** 工具名白名单映射（导出供测试） */
export function normalizeTool(tool?: string): AgentTool | undefined {
  const t = (tool ?? '').toLowerCase().trim()
  if (t === 'claude' || t === 'claude-code') return 'claude'
  if (t === 'cursor') return 'cursor'
  if (t === 'codex') return 'codex'
  if (t === 'kimi' || t === 'kimi-code') return 'kimi'
  if (t === 'cline') return 'cline'
  if (t === 'continue') return 'continue'
  return undefined
}

/** 用 stdin 的 cwd 解析项目身份（hook 进程短命，chdir 无副作用；P1-5） */
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
  let input: CaptureInput = {}
  try {
    const raw = readFileSync(0, 'utf-8')
    if (raw.trim()) input = JSON.parse(raw) as CaptureInput
  } catch {
    return // stdin 不是合法 JSON：静默
  }
  const tool = normalizeTool(input.tool)
  if (!tool) return
  const opts = { sid: input.session_id, pk: resolvePk(input.cwd) }
  const norm = normalizeEvent(input)
  const event = norm.event
  opts.sid = norm.sid ?? opts.sid

  switch (event) {
    case 'start':
      recordLifecycle(tool, 'start', opts)
      return
    case 'end':
      recordLifecycle(tool, 'end', opts)
      return
    case 'commit':
      if (norm.text) writeAgentEvent({ t: 'commit', tool, msg: norm.text.slice(0, 500), ...opts })
      return
    case 'message': {
      const role = input.role === 'assistant' || input.role === 'a' ? 'a' : 'u'
      if (norm.text) recordMessage(tool, role, norm.text, opts)
      return
    }
    default:
      return // 未知事件：静默
  }
}

// 仅作为脚本直接运行时执行（node dist/hooks/event-capture.js）；
// 被测试 import 时不读 stdin（避免阻塞等待 EOF）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
