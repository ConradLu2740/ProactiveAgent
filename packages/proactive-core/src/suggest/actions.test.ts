/**
 * M6 Action Executor 测试 — 建议接受即执行
 *
 * - correction：accept → 写入纠正 + 确认（现有闭环保持）
 * - automation/todo：宿主注入执行器 → 真实创建返回 #id；无宿主 → 降级指令
 * - suggest_accept MCP 返回执行结果
 */

import { describe, expect, it, beforeEach } from 'vitest'
import * as service from './service'
import { executeSuggestionAction } from './actions'
import { setActionExecutorProvider, type HostActionExecutor } from '../provider'

const TEST_DIR = '/tmp/proactive-m6-test-' + Math.random().toString(36).slice(2)
beforeEach(() => {
  process.env.PROACTIVE_DATA_DIR = TEST_DIR
  process.env.PROMA_MEMORY_DIR = TEST_DIR + '/memory'
})

describe('Action Executor（M6）', () => {
  it('无宿主执行器时降级返回可执行指令（不崩溃）', async () => {
    setActionExecutorProvider(null)
    const result = await executeSuggestionAction(
      { type: 'open_automation_create', automationTitle: '每日备份', suggestedPrompt: '每天备份数据库', cron: '9 0 * * *' },
      { host: 'test-host' },
    )
    expect(result.ok).toBe(true)
    expect(result.executed).toBe(false)
    expect(result.message).toContain('每日备份')
    expect(result.message).toContain('9 0 * * *')
  })

  it('宿主注入 createAutomation → 真实创建返回 refId', async () => {
    const fake: HostActionExecutor = {
      createAutomation: async (input) => {
        expect(input.cron).toBe('0 17 * * *')
        return { ok: true, refId: 'auto-42', message: 'created' }
      },
    }
    setActionExecutorProvider(() => fake)
    const result = await executeSuggestionAction(
      { type: 'open_automation_create', automationTitle: '检查发布', suggestedPrompt: '每天下午5点检查发布', cron: '0 17 * * *' },
    )
    expect(result.ok).toBe(true)
    expect(result.executed).toBe(true)
    expect(result.refId).toBe('auto-42')
    expect(result.message).toContain('auto-42')
  })

  it('宿主注入 createTodo → 创建待办', async () => {
    const fake: HostActionExecutor = {
      createTodo: async (input) => {
        expect(input.title).toBe('提交报告')
        return { ok: true, refId: 'todo-7', message: 'created' }
      },
    }
    setActionExecutorProvider(() => fake)
    const result = await executeSuggestionAction(
      { type: 'open_todo_create', title: '提交报告', notes: '明天截止' },
    )
    expect(result.executed).toBe(true)
    expect(result.refId).toBe('todo-7')
  })

  it('host 执行器异常 → 返回 ok:false 不崩溃', async () => {
    const fake: HostActionExecutor = {
      createAutomation: async () => {
        throw new Error('API down')
      },
    }
    setActionExecutorProvider(() => fake)
    const result = await executeSuggestionAction(
      { type: 'open_automation_create', automationTitle: 'X', suggestedPrompt: 'Y' },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('API down')
  })

  it('memory_correction 走现有闭环（accept 后规则已确认）', async () => {
    setActionExecutorProvider(null)
    // 先产生 correction 建议
    const records = await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'm6-1',
      messages: [{ role: 'user', content: '以后都用 pnpm 安装' }],
    })
    expect(records.length).toBe(1)
    // 接受
    const res = await service.handleSuggestionFeedback(records[0]!.id, 'accepted')
    expect(res.ok).toBe(true)
    expect(res.result?.message).toContain('长期记忆')
  })

  it('accept automation 建议（无宿主）返回降级指令消息', async () => {
    setActionExecutorProvider(null)
    const records = await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'm6-2',
      messages: [{ role: 'user', content: '每天下午5点检查发布状态' }],
    })
    expect(records.length).toBe(1)
    const res = await service.handleSuggestionFeedback(records[0]!.id, 'accepted', { host: 'test' })
    expect(res.ok).toBe(true)
    expect(res.result?.executed).toBe(false)
    expect(res.result?.message).toContain('定时任务')
  })
})
