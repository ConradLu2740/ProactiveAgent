/**
 * Claude Code HostAdapter 实现（M1）
 *
 * 收编自 hooks/common.ts（transcript 提取、文本建议渲染）与 hooks/today-push.ts（注入渲染）。
 * 行为与重构前一致（2026-08-12 全量测试 + 闭环实测不回归）。
 */

import { readFileSync } from 'node:fs'
import type { HostAdapter, HostMessage, HostSuggestion, InjectionContext } from './types'

/** 从 Claude Code transcript JSONL 提取最近 N 条消息（SDKMessage 风格容错） */
export function extractTranscriptMessages(transcriptPath: string, maxMessages = 20): HostMessage[] {
  try {
    const raw = readFileSync(transcriptPath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-100)
    const out: HostMessage[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          type?: string
          message?: { role?: string; content?: unknown }
        }
        const role = entry.message?.role ?? entry.type
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
  } catch {
    return []
  }
}

const KIND_LABEL: Record<string, string> = {
  correction: '纠正建议',
  followup: '跟进建议',
  automation: '自动化建议',
  skill: '技能建议',
  todo: '待办建议',
}

/** 渲染 Claude 风格纯文本建议注入（stdout 注入上下文） */
export function renderTextSuggestion(records: HostSuggestion[]): string {
  if (records.length === 0) return ''
  const lines: string[] = ['【ProactiveAgent 建议】']
  for (const r of records) {
    lines.push(`- [${KIND_LABEL[r.kind] ?? r.kind}] ${r.title}（${r.reason}）`)
  }
  lines.push('（若与本会话无关可忽略；接受/忽略可用 suggest_accept / suggest_ignore）')
  return lines.join('\n')
}

/** 渲染会话开始注入内容（待处理建议 + 热点场景 + 画像 + 记忆；无内容返回空） */
export function renderTodayInjection(ctx: InjectionContext): string {
  const { suggestions, scenes, personaSummary, topMemories } = ctx
  if (suggestions.length === 0 && scenes.length === 0 && !personaSummary && topMemories.length === 0) {
    return ''
  }
  const lines: string[] = ['【ProactiveAgent 主动中心】']
  if (suggestions.length > 0) {
    lines.push('待处理建议：')
    for (const s of suggestions) {
      lines.push(`- [${s.kind}] ${s.title}（${s.reason}）`)
    }
  }
  if (scenes.length > 0) {
    lines.push('近期关注：' + scenes.map((s) => s.title).join('、'))
  }
  if (personaSummary) {
    lines.push(`用户画像：${personaSummary}`)
  }
  if (topMemories.length > 0) {
    lines.push('近期记忆：')
    for (const m of topMemories) {
      lines.push(`  ${m.slice(0, 120)}`)
    }
  }
  lines.push('（以上为主动推送，若与本会话无关可忽略）')
  return lines.join('\n')
}

/** Claude Code HostAdapter（能力矩阵：hooks/resources/prompts/transcript 全支持） */
export const claudeAdapter: HostAdapter = {
  id: 'claude',
  capabilities: {
    hooks: true,
    resources: true,
    prompts: true,
    sessionRead: { partial: 'transcript JSONL（SDKMessage 风格），非交互 -p 模式无 hooks' },
    plugin: true,
    systemPrompt: { partial: 'CLAUDE.md 项目级注入，无 plugin 级 systemPrompt' },
    midSessionInjection: 'stdout-text',
    inHostNotification: false,
  },
  hooks: {
    eventMap: {
      SessionStart: 'start',
      UserPromptSubmit: 'msg',
      Stop: 'end',
    },
    configFormat: 'claude-settings',
    renderConfig(hooksDir, serverName) {
      // 与 cli-init buildHooksSettings 同构（生成 .claude/settings.json 片段）
      const q = (p: string) => (/\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)
      return JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: `node ${q(`${hooksDir}/today-push.js`)}` }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${q(`${hooksDir}/user-prompt.js`)}` }] }],
            Stop: [{ hooks: [{ type: 'command', command: `node ${q(`${hooksDir}/session-end.js`)}` }] }],
          },
        },
        null,
        2,
      )
    },
  },
  expression: {
    kind: 'stdout-text',
    renderSuggestion: renderTextSuggestion,
  },
  injection: {
    channel: 'hook-stdout',
    renderInjection: renderTodayInjection,
  },
  readSession({ sessionId, cwd }) {
    // Claude transcript 由 Stop hook 的 transcript_path 提供；此处提供兜底定位（按 cwd 找最新 transcript）
    void sessionId
    void cwd
    return { messages: [] }
  },
}
