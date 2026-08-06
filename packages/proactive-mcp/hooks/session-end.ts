/**
 * Claude Code Stop hook — 会话结束记忆沉淀 + 建议评估
 *
 * 在 Claude Code 会话结束时运行：
 * 1. 从 transcript（JSONL，SDKMessage 风格）提取最近对话消息
 * 2. memory extractAndCapture：LLM/规则提取记忆（默认待确认，防投毒）
 * 3. evaluateSessionSuggestions：评估是否产生主动建议
 *
 * hook stdin 接收 JSON（含 transcript_path）。输出到 stderr（不注入上下文）。
 *
 * 安装（.claude/settings.json）：
 * ```json
 * { "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "bun run /abs/path/session-end.ts" }] }] } }
 * ```
 *
 * 运行：echo '{"transcript_path":"..."}' | bun run hooks/session-end.ts
 */

import { readFileSync } from 'node:fs'
import { memoryService, suggestService } from '@proactive-agent/core'

interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 从 Claude Code transcript JSONL 提取纯文本消息（SDKMessage 风格容错） */
function extractMessages(transcriptPath: string, maxMessages = 20): TranscriptMessage[] {
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
}

async function main(): Promise<void> {
  try {
    let transcriptPath = ''
    try {
      const input = JSON.parse(readFileSync(0, 'utf-8')) as { transcript_path?: string }
      transcriptPath = input.transcript_path ?? ''
    } catch {
      // stdin 不是 JSON 或为空：Claude Code Stop hook 会传入 transcript_path，取不到就跳过
    }
    if (!transcriptPath) {
      // 注意：CLAUDE_PROJECT_DIR 是项目目录不是 transcript 文件路径，不能作为兜底
      console.error('[session-end] 未找到 transcript_path，跳过')
      return
    }
    const messages = extractMessages(transcriptPath)
    if (messages.length === 0) {
      console.error('[session-end] transcript 无可提取消息，跳过')
      return
    }

    const extract = await memoryService.extractAndCapture(messages)
    console.error(
      `[session-end] 记忆沉淀完成: ${extract.storedCount} 条新增, ${extract.corrections} 条纠正, mode=${extract.mode}`,
    )

    const suggestions = await suggestService.evaluateSessionSuggestions(messages)
    if (suggestions.length > 0) {
      console.error(`[session-end] 产生 ${suggestions.length} 条主动建议: ${suggestions[0]?.title}`)
    } else {
      console.error('[session-end] 该沉默时沉默：无新建议')
    }
  } catch (error) {
    console.error('[session-end] hook 失败（已忽略）:', error instanceof Error ? error.message : error)
  }
}

main()
