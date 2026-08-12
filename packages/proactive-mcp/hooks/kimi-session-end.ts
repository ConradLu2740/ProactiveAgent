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

import { readFileSync } from 'node:fs'
import { memoryService, suggestService } from '@proactive-agent/core'
import { recordLifecycle, currentProjectKey } from '../src/event-store'
import { detectTool } from './common'
import { locateWireFile, extractWireMessages } from '@proactive-agent/adapters'

type SessionEndInput = Parameters<typeof locateWireFile>[0]
type WireMessage = ReturnType<typeof extractWireMessages>[number]

/** 会话定位与消息提取已收编至 kimi adapter（locateWireFile / extractWireMessages） */

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
