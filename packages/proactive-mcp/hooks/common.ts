/**
 * hooks 共享工具 — UserPromptSubmit（会话中）建议评估公共逻辑
 *
 * 供 Claude Code / Kimi Code 的会话中 hook 复用：
 * 从 stdin 的 UserPromptSubmit JSON 取最近用户消息 → evaluateNow(session_mid)
 * → 有建议则输出注入文本；无建议输出空（该沉默时沉默）。
 *
 * 输出约定：
 * - Claude：stdout 输出建议文本（Claude 会注入上下文并主动告知用户）
 * - Kimi：stdout 输出对齐 Kimi task 通知范式的 <notification> XML
 *   （Kimi externalHooks 的 UserPromptSubmit stdout 会被渲染为 <hook_result>
 *   注入上下文；<notification> 结构让模型明确识别为待转述的通知，主动向用户开口）
 * - 无建议时 stdout 必须输出空字符串（防污染上下文）
 * - 错误只写 stderr，不注入
 */

import { readFileSync } from 'node:fs'
import { suggestService } from '@proactive-agent/core'

interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 从 Claude Code transcript JSONL 提取最近 N 条消息（SDKMessage 风格容错） */
function extractMessages(transcriptPath: string, maxMessages = 20): TranscriptMessage[] {
  try {
    const raw = readFileSync(transcriptPath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-100)
    const out: TranscriptMessage[] = []
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

export interface UserPromptInput {
  prompt?: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  /** Kimi 注入的会话事实（snake_case：is_steer 存在 = Kimi externalHooks） */
  is_steer?: boolean
  session_title?: string
}

/** 从 stdin 读取 UserPromptSubmit 输入（容错：不是 JSON 或为空时返回空） */
export function readStdinInput(): UserPromptInput {
  try {
    const raw = readFileSync(0, 'utf-8')
    if (!raw.trim()) return {}
    return JSON.parse(raw) as UserPromptInput
  } catch {
    return {}
  }
}

/** XML 属性转义（对齐 Kimi notificationXml） */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const KIND_LABEL: Record<string, string> = {
  correction: '纠正建议',
  followup: '跟进建议',
  automation: '自动化建议',
  skill: '技能建议',
  todo: '待办建议',
}

/** 渲染 Kimi 风格 <notification>（对齐 renderNotificationXml 结构：id/category/type/Title/Severity/body） */
function renderKimiNotification(records: Array<{ id: string; kind: string; title: string; reason: string }>): string {
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

/**
 * 评估会话中建议并输出。
 * 只有强信号（correction/automation）才注入；其余静默。
 */
export async function evaluateAndEmit(projectHint?: string): Promise<void> {
  const input = readStdinInput()
  const prompt = input.prompt?.trim()
  if (!prompt) {
    console.log('')
    return
  }

  try {
    // P2-2：优先从 transcript 取最近 N 条消息（repeat 信号需要跨消息），
    // 取不到再退化为只有当前 prompt（单消息）。
    let messages: Array<{ role: string; content: string }> = [{ role: 'user', content: prompt }]
    if (input.transcript_path) {
      const history = extractMessages(input.transcript_path)
      if (history.length > 0) {
        // 追加当前 prompt（transcript 可能不含最新一条），并保留最近的用户消息
        messages = [...history, { role: 'user', content: prompt }].filter((m) => m.role === 'user').slice(-8)
      }
    }

    const records = await suggestService.evaluateNow({
      trigger: 'session_mid',
      sessionId: input.session_id,
      messages,
      projectHint: projectHint ?? input.cwd,
    })

    if (records.length === 0) {
      console.log('')
      return
    }

    // Kimi 宿主：输出 <notification> 通知范式（模型可见 → 主动转述）
    // 判断依据：is_steer 字段存在（Kimi externalHooks 注入的会话事实，snake_case）
    if (input.is_steer !== undefined) {
      const notif = renderKimiNotification(
        records.map((r) => ({ id: r.id, kind: r.kind, title: r.title, reason: r.reason })),
      )
      console.log(notif)
      return
    }

    // Claude / 通用：纯文本注入
    const lines: string[] = ['【ProactiveAgent 建议】']
    for (const r of records) {
      lines.push(`- [${KIND_LABEL[r.kind] ?? r.kind}] ${r.title}（${r.reason}）`)
    }
    lines.push('（若与本会话无关可忽略；接受/忽略可用 suggest_accept / suggest_ignore）')
    console.log(lines.join('\n'))
  } catch (error) {
    console.error('[user-prompt] 评估失败（已忽略）:', error instanceof Error ? error.message : error)
    console.log('')
  }
}
