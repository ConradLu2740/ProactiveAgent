/**
 * Kimi Code UserPromptSubmit hook — 会话中主动建议推送（R1，实验性）
 *
 * Kimi Code externalHooks 的 UserPromptSubmit 与 Claude Code 同构
 * （stdin JSON 含 prompt/session_id，stdout 输出注入会话上下文）。
 * 本 hook 复用同一评估逻辑；如 Kimi 版本差异导致不触发，见 README 回退
 * 到 SessionStart 推送（today-push）。
 *
 * 安装（~/.kimi-code/hooks.json）：
 * ```json
 * { "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /abs/path/kimi-user-prompt.js" }] }] } }
 * ```
 */

import { evaluateAndEmit } from './common'

async function main(): Promise<void> {
  await evaluateAndEmit()
}

main()
