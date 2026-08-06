/**
 * Suggestion Action Executor — 建议动作真实执行（M6）
 *
 * 目标：`suggest_accept` 时统一走 Executor，把建议真正落地：
 * - memory_correction：写入纠正候选 + 确认（已有闭环，保持）
 * - open_automation_create：宿主注入真实创建 API → 创建定时任务，返回 "已创建 #xxx"
 * - open_todo_create：宿主注入 todo 系统 → 创建待办
 * - 无宿主执行器时降级：返回"可执行指令"文本（Claude Code 宿主：可粘贴指令 + 用户确认）
 *
 * 设计原则：
 * - core 不依赖任何宿主 SDK，执行能力通过 provider.getActionExecutor() 注入
 * - 降级路径永远可用：没有执行器也能给出有意义的反馈
 */

import type { SuggestionAction } from '../shared-types'
import { getActionExecutor } from '../provider'

/** 动作执行结果（统一反馈给 UI / MCP 工具 / hook） */
export interface ActionResult {
  ok: boolean
  /** 是否真正创建了宿主资源（automation/todo），false = 降级指令 */
  executed: boolean
  /** 资源引用（如 automation id / todo id） */
  refId?: string
  /** 面向用户的反馈文本 */
  message: string
}

/**
 * 执行一个建议动作。
 * @param action 建议携带的 action
 * @param ctx 附加上下文（host 名，用于降级指令文案）
 */
export async function executeSuggestionAction(
  action: SuggestionAction,
  ctx: { host?: string } = {},
): Promise<ActionResult> {
  const host = ctx.host ?? 'agent'
  const executor = getActionExecutor()

  try {
    switch (action.type) {
      case 'memory_correction': {
        // 纠正写入闭环在 service.handleSuggestionFeedback 已处理（proposeCorrection + confirmCorrection）
        // 这里返回状态给 MCP 层，避免重复写入
        return {
          ok: true,
          executed: true,
          message: '纠正规则已写入长期记忆（包含用户画像回流）。',
        }
      }

      case 'open_automation_create': {
        if (executor?.createAutomation) {
          const result = await executor.createAutomation({
            title: action.automationTitle,
            prompt: action.suggestedPrompt,
            cron: action.cron,
            dueAt: action.dueAt,
          })
          return {
            ok: result.ok,
            executed: result.ok,
            refId: result.refId,
            message: result.ok ? `✅ 已创建定时任务${result.refId ? ` #${result.refId}` : ''}：${action.automationTitle}` : result.message,
          }
        }
        // 降级：返回可执行指令（宿主粘贴执行）
        const timeHint = action.cron ? `（周期 ${action.cron}）` : action.dueAt ? '（单次时间）' : ''
        return {
          ok: true,
          executed: false,
          message: `建议创建定时任务「${action.automationTitle}」${timeHint}。当前 ${host} 宿主未接入自动创建，请在宿主中执行：${action.suggestedPrompt}`,
        }
      }

      case 'open_todo_create': {
        if (executor?.createTodo) {
          const result = await executor.createTodo({
            title: action.title,
            notes: action.notes,
            dueAt: action.dueAt,
          })
          return {
            ok: result.ok,
            executed: result.ok,
            refId: result.refId,
            message: result.ok ? `✅ 已创建待办${result.refId ? ` #${result.refId}` : ''}：${action.title}` : result.message,
          }
        }
        return {
          ok: true,
          executed: false,
          message: `建议创建待办「${action.title}」。当前 ${host} 宿主未接入 Todo 系统，请在宿主中手动创建。`,
        }
      }

      case 'open_skill_creator': {
        return {
          ok: true,
          executed: false,
          message: `建议沉淀 Skill「${action.topic}」。请在宿主中打开 Skill 创建流程。`,
        }
      }

      case 'open_memory_board':
        return {
          ok: true,
          executed: false,
          message: '建议打开记忆面板查看/管理记忆。',
        }

      default:
        return { ok: false, executed: false, message: '未知建议动作' }
    }
  } catch (error) {
    return {
      ok: false,
      executed: false,
      message: `动作执行失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
