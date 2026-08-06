/**
 * Kimi Code UserPromptSubmit hook — 会话中主动建议推送（R1/M2-M3）
 *
 * 在 Kimi Code 每次用户提交提示词时运行：如果消息含强信号
 * （correction/automation，conf ≥ 0.8），输出对齐 Kimi task 通知范式的
 * `<notification>` XML（模型可见 → 主动向用户转述建议）；无建议输出空。
 *
 * 安装（Kimi hooks 是 TOML，不是 JSON；写在 ~/.kimi-code/config.toml）：
 * ```toml
 * [[hooks]]
 * event = "UserPromptSubmit"
 * command = "node /abs/path/dist/hooks/kimi-user-prompt.js"
 * ```
 * 说明：
 * - UserPromptSubmit：用户发送消息时触发；hook stdout 会被附加到会话上下文，
 *   模型看到 `<notification>` 后主动向用户转述建议
 * - 不设 matcher = 匹配全部用户消息（弱信号由引擎静默，不打扰）
 * - 字段只允许 event/matcher/command/timeout，多写会导致配置加载失败
 * - timeout 默认 30s，建议设 10（hook 是轻量本地评估）
 *
 * 本地测试：
 * echo '{"prompt":"以后都用 pnpm 安装","session_id":"x","is_steer":false}' | bun run hooks/kimi-user-prompt.ts
 */

import { evaluateAndEmit } from './common'

async function main(): Promise<void> {
  await evaluateAndEmit()
}

main()
