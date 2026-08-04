/**
 * ProactiveAgent MCP Server — Prompts + 共享文本
 *
 * 模板能力同时暴露为：
 * - MCP Prompts（daily_review / onboarding）——Claude Code 等支持 prompts 的宿主可用
 * - MCP Tools（daily_review / onboarding_guide）——Kimi Code 等只支持 tools 的宿主可用
 *
 * 文本生成抽为纯函数，prompts 与 tools 共用，保证跨宿主一致。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/** 每日复盘模板（纯函数，供 prompt 与 tool 共用） */
export function buildDailyReviewText(date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10)
  return `# 每日复盘（${d}）

请对今天的工作进行一次主动复盘，并按以下步骤执行：

1. 用 memory_recall 检索今天的相关记忆，了解近期上下文。
2. 回顾今天的会话，用 memory_extract 把值得长期记住的内容（事实/偏好/纠正/流程/事件）交给记忆引擎（自动提取默认待确认，用 memory_pending 查看后 memory_confirm 确认）。
3. 用 scene_summary 查看近期热点场景，判断当前工作主线。
4. 用 suggest_now 评估今天的对话，看是否有值得沉淀的建议。
5. 最后输出一份简短复盘：
   - 今天完成了什么
   - 有什么新的长期记忆/规则
   - 明天建议优先做什么

注意：保持克制，只记录真正稳定、跨会话有价值的内容。`
}

/** 冷启动说明（纯函数，供 prompt 与 tool 共用） */
export function buildOnboardingText(): string {
  return `# ProactiveAgent 使用说明

本会话挂载了 ProactiveAgent（主动记忆 + 主动建议）MCP Server。请遵守以下约定：

## 记忆
- 用户明确说"记住/以后要/我偏好/别再用"等时，调用 memory_capture 立即沉淀（type 选 preference/correction/fact 等）。
- 开始重要任务前，用 memory_recall 检索相关历史记忆，注入上下文；可用 persona_get 读取用户画像。
- 会话结束时，可调用 memory_extract 把本段对话交给引擎提取（提取结果默认待确认，需要用户确认才生效，不要自己批量确认）。
- 自动提取的记忆若明显错误或无关，用 memory_reject 拒绝。

## 建议
- 会话自然结束或阶段性收尾时，可调用 suggest_now 评估是否有值得提出的建议；只有确实有价值才展示，避免打扰。

## 克制原则
- "该沉默时沉默"也是能力：不要频繁调用记忆工具刷存在感。
- 不要把聊天流水账塞进记忆；只沉淀稳定、可复用、跨会话有价值的信息。`
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'daily_review',
    {
      description: '每日复盘：把今天的工作整理为长期记忆并生成改进建议。',
      argsSchema: { date: z.string().optional().describe('复盘日期（默认今天）') },
    },
    async (args) => {
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: buildDailyReviewText((args as { date?: string })?.date) },
          },
        ],
      }
    },
  )

  server.registerPrompt(
    'onboarding',
    {
      description: '冷启动说明：如何在这个会话中用好 ProactiveAgent 记忆与建议能力。',
    },
    async () => {
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: buildOnboardingText() },
          },
        ],
      }
    },
  )
}
