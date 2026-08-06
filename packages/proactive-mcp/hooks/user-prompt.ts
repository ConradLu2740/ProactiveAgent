/**
 * Claude Code UserPromptSubmit hook — 会话中主动建议推送（R1）
 *
 * 在 Claude Code 每次用户提交提示词时运行：如果消息含强信号
 * （correction/automation，conf ≥ 0.8），输出建议注入会话上下文；
 * 无建议输出空（不打扰）。
 *
 * 安装（.claude/settings.json，由 proactive-mcp init 自动生成）：
 * ```json
 * { "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /abs/path/user-prompt.js" }] }] } }
 * ```
 *
 * 运行（测试）：echo '{"prompt":"以后都用 pnpm 安装","session_id":"x"}' | bun run hooks/user-prompt.ts
 */

import { evaluateAndEmit } from './common'

async function main(): Promise<void> {
  await evaluateAndEmit()
}

main()
