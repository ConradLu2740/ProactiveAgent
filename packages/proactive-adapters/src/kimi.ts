/**
 * Kimi Code HostAdapter 实现（M1）
 *
 * 收编自 hooks/kimi-session-end.ts（wire.jsonl 定位与提取）与 hooks/common.ts（<notification> 渲染）。
 * 行为与重构前一致（2026-08-12 全量测试 + Kimi 闭环实测不回归）。
 * 版本漂移教训：0.34 hooks 不触发 → 0.35 恢复；capabilities.hooks 标注 partial。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { HostAdapter, HostHookInput, HostMessage, HostSuggestion } from './types'

/** Kimi 会话目录：~/.kimi-code/sessions 下 wd_* 目录内 /session_<id>/agents/main/wire.jsonl */
function kimiSessionsRoot(): string {
  return join(homedir(), '.kimi-code', 'sessions')
}

/** 按 session_id 定位 wire.jsonl；找不到时用 cwd 目录下最新修改的 wire.jsonl */
export function locateWireFile(input: HostHookInput): string | undefined {
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
export function extractWireMessages(wirePath: string, maxMessages = 20): HostMessage[] {
  const raw = readFileSync(wirePath, 'utf-8')
  const lines = raw.split('\n').filter(Boolean).slice(-200)
  const out: HostMessage[] = []
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

/** XML 属性转义（对齐 Kimi notificationXml） */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 渲染 Kimi 风格 <notification>（对齐 renderNotificationXml 结构：id/category/type/Title/Severity/body） */
export function renderKimiNotification(records: HostSuggestion[]): string {
  const first = records[0]
  if (!first) return ''
  const lines = [
    `<notification id="pa-${escapeXml(first.id)}" category="proactive" type="suggestion" source_kind="proactive_agent" source_id="suggest">`,
    `Title: ${escapeXml(first.title)}`,
    `Severity: info`,
    `${escapeXml(first.reason)}`,
    `建议 ID：${escapeXml(first.id)}（接受: suggest_accept，忽略: suggest_ignore）`,
    `</notification>`,
  ]
  return lines.join('\n')
}

/** Kimi Code HostAdapter（能力矩阵：0.35 hooks 恢复；Resources/Prompts 不支持） */
export const kimiAdapter: HostAdapter = {
  id: 'kimi',
  capabilities: {
    hooks: { partial: '0.35 恢复（SessionStart/UserPromptSubmit/SessionEnd 实测触发）；0.34 运行时缺陷不触发' },
    resources: false,
    prompts: false,
    sessionRead: { partial: 'wire.jsonl（context.append_message），仅交互 TUI 会话落盘' },
    plugin: true,
    systemPrompt: true,
    midSessionInjection: 'notification-xml',
    inHostNotification: false,
  },
  hooks: {
    eventMap: {
      SessionStart: 'start',
      UserPromptSubmit: 'msg',
      SessionEnd: 'end',
    },
    configFormat: 'toml',
    renderConfig(hooksDir, serverName) {
      // ~/.kimi-code/config.toml 的 [[hooks]] 片段（字段只允许 event/matcher/command/timeout）
      void serverName
      return [
        '[[hooks]]',
        'event = "SessionStart"',
        `command = "node ${hooksDir}/today-push.js"`,
        'timeout = 10',
        '',
        '[[hooks]]',
        'event = "UserPromptSubmit"',
        `command = "node ${hooksDir}/kimi-user-prompt.js"`,
        'timeout = 10',
        '',
        '[[hooks]]',
        'event = "SessionEnd"',
        `command = "node ${hooksDir}/kimi-session-end.js"`,
        'timeout = 20',
      ].join('\n')
    },
  },
  expression: {
    kind: 'notification-xml',
    renderSuggestion: renderKimiNotification,
  },
  injection: {
    channel: 'system-prompt',
    renderInjection() {
      // Kimi 的会话开始注入走 today-push hook（stdout）与 plugin systemPrompt（静态文件），
      // 动态注入渲染由 today-push 脚本共用 renderTodayInjection（见 claude.ts）
      return ''
    },
  },
  readSession({ sessionId, cwd }) {
    const wirePath = locateWireFile({ session_id: sessionId, cwd })
    if (!wirePath) return { messages: [] }
    try {
      return { messages: extractWireMessages(wirePath), path: wirePath }
    } catch {
      return { messages: [] }
    }
  },
}
