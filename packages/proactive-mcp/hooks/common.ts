/**
 * hooks 共享工具 — UserPromptSubmit（会话中）建议评估公共逻辑
 *
 * 供 Claude Code / Kimi Code 的会话中 hook 复用：
 * 从 stdin 的 UserPromptSubmit JSON 取最近用户消息 → evaluateNow(session_mid)
 * → 有建议则输出注入文本；无建议输出空（该沉默时沉默）。
 *
 * 输出约定：
 * - stdout 输出注入文本（宿主会注入会话上下文 / 通知）
 * - 无建议时 stdout 必须输出空字符串（防污染上下文）
 * - 错误只写 stderr，不注入
 */

import { readFileSync } from 'node:fs'
import { suggestService } from '@proactive-agent/core'

export interface UserPromptInput {
  prompt?: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
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
    const records = await suggestService.evaluateNow({
      trigger: 'session_mid',
      sessionId: input.session_id,
      messages: [{ role: 'user', content: prompt }],
      projectHint: projectHint ?? input.cwd,
    })

    if (records.length === 0) {
      console.log('')
      return
    }

    const lines: string[] = ['【ProactiveAgent 建议】']
    for (const r of records) {
      lines.push(`- [${r.kind}] ${r.title}（${r.reason}）`)
    }
    lines.push('（若与本会话无关可忽略；接受/忽略可用 suggest_accept / suggest_ignore）')
    console.log(lines.join('\n'))
  } catch (error) {
    console.error('[user-prompt] 评估失败（已忽略）:', error instanceof Error ? error.message : error)
    console.log('')
  }
}
