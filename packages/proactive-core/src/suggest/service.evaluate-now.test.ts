/**
 * R1 主动推送闭环 — evaluateNow 统一入口测试
 *
 * 覆盖 5 种 trigger：
 * - session_start：返回存量待处理建议，不产生新建议
 * - session_mid：会话中推送，限 1 条 + 强信号门槛（correction/automation）
 * - session_end：等同旧 evaluateSessionSuggestions（兼容）
 * - manual / timer：行为正确
 * - 防打扰：DND、会话预算、类型静默
 */

import { describe, expect, it, beforeEach } from 'bun:test'
import * as service from './service'
import * as feedback from './feedback'

// 隔离数据目录
const TEST_DIR = '/tmp/proactive-r1-test-' + Math.random().toString(36).slice(2)
beforeEach(() => {
  process.env.PROACTIVE_DATA_DIR = TEST_DIR
  process.env.PROMA_MEMORY_DIR = TEST_DIR + '/memory'
})

describe('evaluateNow 统一入口', () => {
  it('session_end trigger 兼容旧 evaluateSessionSuggestions 行为', async () => {
    const messages = [{ role: 'user' as const, content: '以后都用 pnpm 安装依赖' }]
    const records = await service.evaluateNow({ trigger: 'session_end', messages })
    expect(records.length).toBe(1)
    expect(records[0]?.kind).toBe('correction')

    const old = await service.evaluateSessionSuggestions(messages)
    // 同会话预算：第一次已建议 correction，第二次（无新消息但同 sessionId）不再建议
    expect(old.length).toBe(0)
  })

  it('session_mid 强信号（correction）产生建议', async () => {
    const records = await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'mid-1',
      messages: [{ role: 'user', content: '以后提交代码前记得跑测试' }],
    })
    expect(records.length).toBe(1)
    expect(records[0]?.kind).toBe('correction')
  })

  it('session_mid 弱信号（followup）被抑制（该沉默时沉默）', async () => {
    const records = await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'mid-2',
      messages: [{ role: 'user', content: '这个问题明天再看吧' }],
    })
    // followup 是弱信号：session_mid 只推 correction/automation
    expect(records.length).toBe(0)
  })

  it('session_mid automation 强信号产生建议（限 1 条）', async () => {
    const records = await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'mid-3',
      messages: [{ role: 'user', content: '每天下午5点帮我检查一下发布状态' }],
    })
    expect(records.length).toBe(1)
    expect(records[0]?.kind).toBe('automation')
  })

  it('session_start 只返回存量待处理建议，不产生新建议', async () => {
    // 先产生一条建议
    await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'start-1',
      messages: [{ role: 'user', content: '以后都用 bun 跑脚本' }],
    })
    const records = await service.evaluateNow({
      trigger: 'session_start',
      sessionId: 'start-2',
      messages: [{ role: 'user', content: '以后都用 pnpm 安装' }],
    })
    // session_start 只列出存量（≥1 条），且不新增（无新消息评估）
    expect(records.length).toBeGreaterThanOrEqual(1)
    const all = service.listSuggestionsForUI('suggested')
    expect(all.length).toBeGreaterThanOrEqual(1)
  })

  it('无消息时返回空（不评估空输入）', async () => {
    const records = await service.evaluateNow({ trigger: 'session_mid', messages: [] })
    expect(records.length).toBe(0)
  })

  it('DND 时段不产生建议', async () => {
    // 动态构造覆盖当前时间的 DND 窗口（当前时间 ±5 分钟，用分钟数）
    const now = new Date()
    const curMin = now.getHours() * 60 + now.getMinutes()
    const startMin = (curMin - 5 + 1440) % 1440
    const endMin = (curMin + 5) % 1440
    feedback.setDndConfig({ enabled: true, startMin, endMin })
    expect(feedback.isInDnd()).toBe(true)
    const records = await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'dnd-1',
      messages: [{ role: 'user', content: '以后都用 pnpm' }],
    })
    expect(records.length).toBe(0)
    feedback.setDndConfig({ enabled: false, startMin: 0, endMin: 0 })
  })

  it('同会话预算：session_mid 最多 2 条后不再建议', async () => {
    await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'budget-1',
      messages: [{ role: 'user', content: '以后都用 pnpm' }],
    })
    await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'budget-1',
      messages: [{ role: 'user', content: '以后都用 bun' }],
    })
    const third = await service.evaluateNow({
      trigger: 'session_mid',
      sessionId: 'budget-1',
      messages: [{ role: 'user', content: '以后都用 npm' }],
    })
    expect(third.length).toBe(0)
  })

  it('manual trigger 等同 suggest_now（产生建议）', async () => {
    const records = await service.evaluateNow({
      trigger: 'manual',
      sessionId: 'manual-1',
      messages: [{ role: 'user', content: '以后都用 pnpm 安装' }],
    })
    expect(records.length).toBe(1)
  })

  it('timer trigger 走 session_mid 同款抑制（弱信号不打扰）', async () => {
    const records = await service.evaluateNow({
      trigger: 'timer',
      sessionId: 'timer-1',
      messages: [{ role: 'user', content: '这个功能后面再优化' }],
    })
    expect(records.length).toBe(0)
  })
})
