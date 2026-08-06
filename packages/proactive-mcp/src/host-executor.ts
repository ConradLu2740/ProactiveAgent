/**
 * Host Executor — 建议动作的默认执行器注入（P0-1 修复）
 *
 * 在 MCP server 启动时注册本地任务执行器：
 * - suggest_accept 接受 automation/todo 建议 → 真正写入本地任务队列（tasks.json）
 * - 返回 "✅ 已创建定时任务 #xxx" / "✅ 已创建待办 #xxx"，不再只是降级指令文本
 * - 宿主（Proma Electron / Kimi 等）未来注入真实执行器时，仍可通过
 *   setActionExecutorProvider 覆盖本默认执行器
 */

import { setActionExecutorProvider, type HostActionExecutor } from '@proactive-agent/core'
import { addAutomation, addTodo } from './task-store'

/** 构建默认本地执行器（任务落到 PROACTIVE_DATA_DIR/tasks.json） */
function createLocalExecutor(): HostActionExecutor {
  return {
    async createAutomation(input) {
      const task = addAutomation({
        title: input.title,
        prompt: input.prompt,
        cron: input.cron,
        dueAt: input.dueAt,
      })
      const timeHint = input.cron ? `（周期 ${input.cron}）` : input.dueAt ? '（单次时间）' : ''
      return {
        ok: true,
        refId: task.id,
        message: `✅ 已创建定时任务 #${task.id}${timeHint}：${task.title}（本地任务队列，/today 可查看与完成）`,
      }
    },
    async createTodo(input) {
      const task = addTodo({
        title: input.title,
        notes: input.notes,
        dueAt: input.dueAt,
      })
      return {
        ok: true,
        refId: task.id,
        message: `✅ 已创建待办 #${task.id}：${task.title}（本地任务队列，/today 可查看与完成）`,
      }
    },
  }
}

/** 注册默认执行器（幂等；外部宿主已注册真实执行器时，本调用可被覆盖） */
export function registerLocalTaskExecutor(): void {
  setActionExecutorProvider(() => createLocalExecutor())
}
