/**
 * Kimi Code SessionEnd hook — 会话结束记忆沉淀（0.35 hooks 恢复后补全）
 *
 * 在 Kimi Code 会话结束时运行：
 * 1. 定位本次会话的 wire.jsonl（~/.kimi-code/sessions 下 wd_* 目录内 /session_<id>/agents/main/wire.jsonl）
 * 2. 解析 context.append_message 提取 user/assistant 文本消息
 * 3. memory extractAndCapture：LLM/规则提取记忆（默认待确认，防投毒）
 * 4. evaluateSessionSuggestions：评估是否产生主动建议
 *
 * 安装（~/.kimi-code/config.toml）：
 * ```toml
 * [[hooks]]
 * event = "SessionEnd"
 * command = "node /abs/path/dist/hooks/kimi-session-end.js"
 * timeout = 20
 * ```
 * SessionEnd 是 observation-only 事件，输出到 stderr（不注入上下文）。
 *
 * 本地测试：
 * echo '{"session_id":"session_xxx","client_type":"kimi_code_cli","cwd":"/path"}' | node dist/hooks/kimi-session-end.js
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { memoryService, suggestService } from '@proactive-agent/core'
import { recordLifecycle, currentProjectKey } from '../src/event-store'
import { detectTool } from './common'

interface SessionEndInput {
  session_id?: string
  sessionId?: string
  cwd?: string
  client_type?: string
  hook_event_name?: string
}

interface WireMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Kimi 会话目录：~/.kimi-code/sessions 下 wd_* 目录内 /session_<id>/agents/main/wire.jsonl */
function kimiSessionsRoot(): string {
  return join(homedir(), '.kimi-code', 'sessions')
}

/** 按 session_id 定位 wire.jsonl；找不到时用 cwd 目录下最新修改的 wire.jsonl */
function locateWireFile(input: SessionEndInput): string | undefined {
  const root = kimiSessionsRoot()
  if (!existsSync(root)) return undefined
  const wdDirs = readdirSync(root).filter((d) => d.startsWith('wd_'))
  if (wdDirs.length === 0) return undefined

  // 1) session_id 精确匹配
  const sid = input.session_id ?? input.sessionId
  if (sid) {
    for (const wd of wdDirs) {
      const candidate = join(root, wd, sid, 'agents', 'main', 'wire.jsonl')
      if (existsSync(candidate)) return candidate
    }
  }
  // 2) 优先 cwd 对应目录（wd_<base>_<hash> 基名与 cwd 基名一致时）
  const cwdBase = input.cwd ? input.cwd.split('/').filter(Boolean).pop() ?? '' : ''
  let bestDir: string | undefined
  let bestMtime = 0
  for (const wd of wdDirs) {
    const dir = join(root, wd)
    let mtime = 0
    try {
      mtime = statSync(dir).mtimeMs
    } catch {
      continue
    }
    if (cwdBase && wd.includes(cwdBase) && mtime > bestMtime) {
      bestDir = dir
      bestMtime = mtime
    }
  }
  // 3) 兜底：整个 sessions 下最新修改的 wire.jsonl
  if (!bestDir) {
    for (const wd of wdDirs) {
      const dir = join(root, wd)
      let mtime = 0
      try {
        mtime = statSync(dir).mtimeMs
      } catch {
        continue
      }
      if (mtime > bestMtime) {
        bestDir = dir
        bestMtime = mtime
      }
    }
  }
  if (!bestDir) return undefined
  const sessions = readdirSync(bestDir).filter((d) => d.startsWith('session_'))
  let bestFile: string | undefined
  let bestFileMtime = 0
  for (const s of sessions) {
    const candidate = join(bestDir, s, 'agents', 'main', 'wire.jsonl')
    if (!existsSync(candidate)) continue
    try {
      const m = statSync(candidate).mtimeMs
      if (m > bestFileMtime) {
        bestFile = candidate
        bestFileMtime = m
      }
    } catch {
      // 忽略
    }
  }
  return bestFile
}

/** 从 Kimi wire.jsonl 提取纯文本消息（context.append_message 类型，Kimi 消息格式容错） */
function extractMessages(wirePath: string, maxMessages = 20): WireMessage[] {
  const raw = readFileSync(wirePath, 'utf-8')
  const lines = raw.split('\n').filter(Boolean).slice(-200)
  const out: WireMessage[] = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        type?: string
        message?: { role?: string; content?: unknown }
      }
      if (entry.type !== 'context.append_message') continue
      const role = entry.message?.role
      if (role !== 'user' && role !== 'assistant') continue
      const content = entry.message?.content
      if (typeof content === 'string' && content.trim()) {
        out.push({ role, content })
      } else if (Array.isArray(content)) {
        const texts = content
          .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
          .map((b) => ((b as { text?: string }).text ?? '').trim())
          .filter(Boolean)
        if (texts.length > 0) out.push({ role, content: texts.join('\n') })
      }
    } catch {
      // 跳过无法解析的行
    }
    if (out.length >= maxMessages) break
  }
  return out
}

async function main(): Promise<void> {
  try {
    let input: SessionEndInput = {}
    try {
      input = JSON.parse(readFileSync(0, 'utf-8')) as SessionEndInput
    } catch {
      // stdin 不是 JSON 或为空：无事件 payload，尝试用 cwd 兜底
    }
    // 0.6：跨工具事件感知——会话结束事件（工具自适应）
    try {
      recordLifecycle(detectTool(input as never), 'end', {
        sid: input.session_id ?? input.sessionId,
        pk: currentProjectKey(),
      })
    } catch {
      // 事件写入失败不阻断
    }
    const wirePath = locateWireFile(input)
    if (!wirePath) {
      console.error('[kimi-session-end] 未定位到 Kimi 会话 wire.jsonl，跳过')
      return
    }
    const messages = extractMessages(wirePath)
    if (messages.length === 0) {
      console.error('[kimi-session-end] wire 无可提取消息，跳过')
      return
    }
    const extract = await memoryService.extractAndCapture(messages)
    console.error(
      `[kimi-session-end] 记忆沉淀完成: ${extract.storedCount} 条新增, ${extract.corrections} 条纠正, mode=${extract.mode}`,
    )
    const suggestions = await suggestService.evaluateSessionSuggestions(messages)
    if (suggestions.length > 0) {
      console.error(`[kimi-session-end] 产生 ${suggestions.length} 条主动建议: ${suggestions[0]?.title}`)
    } else {
      console.error('[kimi-session-end] 该沉默时沉默：无新建议')
    }
  } catch (error) {
    console.error('[kimi-session-end] hook 失败（已忽略）:', error instanceof Error ? error.message : error)
  }
}

main()
