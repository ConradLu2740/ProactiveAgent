/**
 * Daemon 守护进程测试（mock 引擎与通知器，不弹真实通知）
 */

import { rmSync, mkdirSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireDaemonLock,
  releaseDaemonLock,
  daemonIntervalMs,
  isProcessAlive,
  pickNotifiable,
  markNotified,
  runEvaluationCycle,
  dailyNotifyLimit,
  cooldownMs,
  dailyNotifiedCount,
  bumpDailyNotified,
  todayDateString,
  personaDisturbCoefficient,
  DAEMON_INTERVAL_DEFAULT_MIN,
  NOTIFIED_HISTORY_LIMIT,
  type DaemonState,
} from './daemon'
import type { Notifier } from './notifier'
import { suggestService, memoryService } from '@proactive-agent/core'

const TEST_DIR = '/tmp/proactive-daemon-test'
beforeAll(() => {
  process.env.PROACTIVE_DATA_DIR = TEST_DIR
  process.env.PROMA_MEMORY_LLM_DISABLED = '1'
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})
afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env.PROACTIVE_DATA_DIR
  delete process.env.PROMA_MEMORY_LLM_DISABLED
})
beforeEach(() => {
  releaseDaemonLock()
  vi.restoreAllMocks()
  // 清理事件目录：避免用例间事件串扰（0.6.1 pk 分组用例会写事件）
  const { rmSync } = require('node:fs')
  try {
    rmSync(`${TEST_DIR}/events`, { recursive: true, force: true })
  } catch {
    // 忽略
  }
})

function fakeState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    version: 1,
    pid: process.pid,
    startedAt: Date.now(),
    notifiedIds: [],
    dailyNotified: 0,
    dailyNotifiedDate: '',
    ...overrides,
  }
}

function fakeNotifier(): { impl: Notifier; shown: Array<{ title: string; body: string; url?: string }> } {
  const shown: Array<{ title: string; body: string; url?: string }> = []
  const impl: Notifier = {
    platform: 'linux',
    async show(opts) {
      shown.push(opts)
      return { ok: true }
    },
  }
  return { impl, shown }
}

describe('单实例锁', () => {
  it('无状态文件时获取成功', () => {
    const lock = acquireDaemonLock()
    expect(lock.ok).toBe(true)
  })

  it('已有存活实例时拒绝二次启动', async () => {
    // 用真实子进程作为「存活实例」的 pid（当前进程会被实现特意放行）
    const { spawn } = require('node:child_process')
    const child = spawn('sleep', ['30'])
    const state = fakeState({ pid: child.pid ?? -1 })
    const { writeFileSync } = require('node:fs')
    writeFileSync(`${TEST_DIR}/daemon.json`, JSON.stringify(state), 'utf-8')
    try {
      const lock = acquireDaemonLock()
      expect(lock.ok).toBe(false)
      if (!lock.ok) expect(lock.reason ?? '').toContain('已在运行')
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('releaseDaemonLock 只删除属于当前进程的锁（P1-2）', () => {
    const { writeFileSync, existsSync, readFileSync } = require('node:fs')
    // 模拟锁属于另一个进程（比如已死亡的实例 B）
    writeFileSync(`${TEST_DIR}/daemon.json`, JSON.stringify(fakeState({ pid: 999999999 })), 'utf-8')
    releaseDaemonLock()
    // 不应被误删（pid 不匹配当前进程）
    expect(existsSync(`${TEST_DIR}/daemon.json`)).toBe(true)
    // 锁属于当前进程时正常删除
    acquireDaemonLock()
    releaseDaemonLock()
    expect(existsSync(`${TEST_DIR}/daemon.json`)).toBe(false)
  })

  it('陈旧 pid（进程已死）自动覆盖', () => {
    const state = fakeState({ pid: 999999999 })
    const { writeFileSync } = require('node:fs')
    writeFileSync(`${TEST_DIR}/daemon.json`, JSON.stringify(state), 'utf-8')
    const lock = acquireDaemonLock()
    expect(lock.ok).toBe(true)
  })
})

describe('isProcessAlive', () => {
  it('当前进程存活', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })
  it('不存在的 pid 判定为不存活', () => {
    expect(isProcessAlive(999999999)).toBe(false)
  })
  it('非正 pid 判定为不存活（P：kill(-1) POSIX 语义会探测所有进程）', () => {
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
  })
})

describe('0.8 通知疲劳控制', () => {
  it('每日上限默认 6，env 可覆盖，画像「少打扰」时减半', () => {
    delete process.env.PROACTIVE_DAEMON_DAILY_LIMIT
    expect(dailyNotifyLimit(1)).toBe(6)
    expect(dailyNotifyLimit(0.5)).toBe(3)
    process.env.PROACTIVE_DAEMON_DAILY_LIMIT = '10'
    expect(dailyNotifyLimit(1)).toBe(10)
    expect(dailyNotifyLimit(0.5)).toBe(5)
    delete process.env.PROACTIVE_DAEMON_DAILY_LIMIT
  })

  it('冷却窗口默认 15 分钟，env 可覆盖，画像「少打扰」时翻倍', () => {
    delete process.env.PROACTIVE_DAEMON_COOLDOWN_MIN
    expect(cooldownMs(1)).toBe(15 * 60_000)
    expect(cooldownMs(0.5)).toBe(30 * 60_000)
    process.env.PROACTIVE_DAEMON_COOLDOWN_MIN = '5'
    expect(cooldownMs(1)).toBe(5 * 60_000)
    delete process.env.PROACTIVE_DAEMON_COOLDOWN_MIN
  })

  it('当日计数跨天自动重置', () => {
    const state = fakeState({ dailyNotified: 3, dailyNotifiedDate: '2020-01-01' })
    expect(dailyNotifiedCount(state)).toBe(0)
    bumpDailyNotified(state)
    expect(state.dailyNotifiedDate).toBe(todayDateString())
    expect(state.dailyNotified).toBe(1)
    bumpDailyNotified(state)
    expect(dailyNotifiedCount(state)).toBe(2)
  })

  it('画像含「不要打扰」→ 打扰系数 0.5；无画像 → 1', () => {
    memoryService.savePersona('## 偏好\n- 不要打扰我\n', 'project')
    expect(personaDisturbCoefficient()).toBe(0.5)
    memoryService.savePersona('## 偏好\n- 喜欢简洁回复\n', 'project')
    expect(personaDisturbCoefficient()).toBe(1)
  })

  it('画像词表边界（P1 回归）：组合词命中、技术词/单项提醒不命中', () => {
    const cases: Array<[string, number]> = [
      ['使用 quiet mode 减少日志', 0.5],
      ['git 操作使用 --quiet 参数', 1],
      ['软件更新使用静默安装', 1],
      ['编译器 silent mode', 1],
      ['开启勿扰模式', 0.5],
      ['DND 时段别发消息', 0.5],
      ['免打扰', 0.5],
      ['别提醒我收快递', 1],
      ['需要提醒我吃药', 1],
      ['减少打扰：只在我工作时不要打扰', 0.5],
    ]
    for (const [markdown, expected] of cases) {
      memoryService.savePersona(`## 偏好\n- ${markdown}\n`, 'project')
      expect(personaDisturbCoefficient(), markdown).toBe(expected)
    }
  })

  it('limit=1 时画像命中不减半（Math.max(1) 防锁死，P2-2）', () => {
    process.env.PROACTIVE_DAEMON_DAILY_LIMIT = '1'
    expect(dailyNotifyLimit(0.5)).toBe(1)
    delete process.env.PROACTIVE_DAEMON_DAILY_LIMIT
  })

  it('COOLDOWN_MIN=0 显式禁用冷却（P2-4 边界）', () => {
    process.env.PROACTIVE_DAEMON_COOLDOWN_MIN = '0'
    expect(cooldownMs(1)).toBe(0)
    delete process.env.PROACTIVE_DAEMON_COOLDOWN_MIN
  })

  it('时钟回拨（lastNotifyAt 在未来）不触发永久冷却（P2-4 回归）', async () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([
      { id: 'future1', kind: 'todo', title: '时钟回拨建议', reason: 'r', status: 'suggested' } as never,
    ])
    vi.spyOn(suggestService, 'dndActive').mockReturnValue(false)
    delete process.env.PROACTIVE_DAEMON_DAILY_LIMIT
    delete process.env.PROACTIVE_DAEMON_COOLDOWN_MIN
    const { impl, shown } = fakeNotifier()
    const state = fakeState({ lastNotifyAt: Date.now() + 60_000 }) // 未来时间
    const res = await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(res.notified).toBe(true)
    expect(shown.length).toBe(1)
  })

  it('0.6.1：事件按 pk 分组评估——各项目事件只评估对应项目（不串味）', async () => {
    const evaluateMock = vi.spyOn(suggestService, 'evaluateNow').mockResolvedValue([] as never)
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([])
    vi.spyOn(suggestService, 'dndActive').mockReturnValue(false)
    delete process.env.PROACTIVE_DAEMON_DAILY_LIMIT
    delete process.env.PROACTIVE_DAEMON_COOLDOWN_MIN
    const { impl } = fakeNotifier()
    const state = fakeState()
    // 写两个项目的事件（含 pk），另有一条无 pk 事件
    const { recordMessage } = await import('./event-store')
    recordMessage('kimi', 'u', '以后都用 pnpm，不要用 npm', { sid: 's-a', pk: 'path:aaaa' })
    recordMessage('kimi', 'u', '以后都用 yarn，不要用 pnpm', { sid: 's-b', pk: 'path:bbbb' })
    recordMessage('kimi', 'u', '无项目身份的消息', { sid: 's-c' })

    const res = await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(res.evaluated).toBe(true)
    // 两个 pk 组 + 无 pk 组 = 3 次评估
    expect(evaluateMock).toHaveBeenCalledTimes(3)
    const hints = evaluateMock.mock.calls.map((c) => (c[0] as { projectHint?: string }).projectHint)
    expect(hints).toContain('path:aaaa')
    expect(hints).toContain('path:bbbb')
    expect(hints).toContain(undefined)
    // 每个组只带自己的消息
    const aCall = evaluateMock.mock.calls.find((c) => (c[0] as { projectHint?: string }).projectHint === 'path:aaaa')
    const aMsgs = (aCall?.[0] as { messages: Array<{ content: string }> }).messages
    expect(aMsgs.some((m) => m.content.includes('pnpm'))).toBe(true)
    expect(aMsgs.some((m) => m.content.includes('yarn'))).toBe(false)
  })

  it('老版本 daemon.json（无 dailyNotified 字段）兼容启动（P2 升级场景）', () => {
    const fs = require('node:fs')
    fs.writeFileSync(
      `${TEST_DIR}/daemon.json`,
      JSON.stringify({ version: 1, pid: 999999999, startedAt: Date.now(), notifiedIds: [] }),
      'utf-8',
    )
    const lock = acquireDaemonLock()
    expect(lock.ok).toBe(true)
    if (lock.ok && lock.state) {
      expect(lock.state.dailyNotified).toBe(0)
      expect(dailyNotifiedCount(lock.state)).toBe(0)
    }
    releaseDaemonLock()
  })

  it('达每日上限不通知且不标记（建议保留至明日）', async () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([
      { id: 'cap1', kind: 'todo', title: '达上限建议', reason: 'r', status: 'suggested' } as never,
    ])
    vi.spyOn(suggestService, 'dndActive').mockReturnValue(false)
    delete process.env.PROACTIVE_DAEMON_DAILY_LIMIT
    delete process.env.PROACTIVE_DAEMON_COOLDOWN_MIN
    const { impl, shown } = fakeNotifier()
    const state = fakeState({ dailyNotified: 6, dailyNotifiedDate: todayDateString(), lastNotifyAt: Date.now() - 60_000 })
    const res = await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(res.notified).toBe(false)
    expect(shown.length).toBe(0)
    expect(state.notifiedIds).not.toContain('cap1')
  })

  it('冷却窗口内不通知且不标记', async () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([
      { id: 'cool1', kind: 'followup', title: '冷却建议', reason: 'r', status: 'suggested' } as never,
    ])
    vi.spyOn(suggestService, 'dndActive').mockReturnValue(false)
    delete process.env.PROACTIVE_DAEMON_DAILY_LIMIT
    delete process.env.PROACTIVE_DAEMON_COOLDOWN_MIN
    const { impl, shown } = fakeNotifier()
    const state = fakeState({ lastNotifyAt: Date.now() })
    const res = await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(res.notified).toBe(false)
    expect(shown.length).toBe(0)
    expect(state.notifiedIds).not.toContain('cool1')
  })

  it('通知成功后累计当日计数', async () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([
      { id: 'ok1', kind: 'skill', title: '正常通知', reason: 'r', status: 'suggested' } as never,
    ])
    vi.spyOn(suggestService, 'dndActive').mockReturnValue(false)
    delete process.env.PROACTIVE_DAEMON_DAILY_LIMIT
    delete process.env.PROACTIVE_DAEMON_COOLDOWN_MIN
    const { impl } = fakeNotifier()
    const state = fakeState()
    await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(dailyNotifiedCount(state)).toBe(1)
    expect(state.dailyNotifiedDate).toBe(todayDateString())
  })
})

describe('评估间隔', () => {
  it('默认 60 分钟', () => {
    delete process.env.PROACTIVE_DAEMON_INTERVAL_MIN
    expect(daemonIntervalMs()).toBe(DAEMON_INTERVAL_DEFAULT_MIN * 60_000)
  })
  it('env 覆盖生效', () => {
    process.env.PROACTIVE_DAEMON_INTERVAL_MIN = '30'
    expect(daemonIntervalMs()).toBe(30 * 60_000)
    delete process.env.PROACTIVE_DAEMON_INTERVAL_MIN
  })
  it('非法值兜底到默认', () => {
    process.env.PROACTIVE_DAEMON_INTERVAL_MIN = 'abc'
    expect(daemonIntervalMs()).toBe(DAEMON_INTERVAL_DEFAULT_MIN * 60_000)
    delete process.env.PROACTIVE_DAEMON_INTERVAL_MIN
  })
})

describe('通知候选挑选', () => {
  it('无 suggested 建议返回 undefined', () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([])
    expect(pickNotifiable(fakeState())).toBeUndefined()
  })

  it('取未通知过的最新一条', () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([
      { id: 'a', kind: 'followup', title: '跟进 A', reason: 'r', status: 'suggested' } as never,
      { id: 'b', kind: 'todo', title: '待办 B', reason: 'r', status: 'suggested' } as never,
    ])
    const picked = pickNotifiable(fakeState({ notifiedIds: ['b'] }))
    expect(picked?.id).toBe('a')
    expect(picked?.title).toBe('跟进 A')
  })

  it('全部已通知返回 undefined（不重复打扰）', () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([
      { id: 'a', kind: 'followup', title: '跟进 A', reason: 'r', status: 'suggested' } as never,
    ])
    expect(pickNotifiable(fakeState({ notifiedIds: ['a'] }))).toBeUndefined()
  })
})

describe('通知记录', () => {
  it('记录去重 + 容量上限', () => {
    const state = fakeState()
    markNotified(state, 'x')
    markNotified(state, 'x')
    expect(state.notifiedIds).toEqual(['x'])
    // 容量上限：只保留最近 N 条
    for (let i = 0; i < NOTIFIED_HISTORY_LIMIT + 20; i++) markNotified(state, `id-${i}`)
    expect(state.notifiedIds.length).toBeLessThanOrEqual(NOTIFIED_HISTORY_LIMIT)
    expect(state.notifiedIds).toContain(`id-${NOTIFIED_HISTORY_LIMIT + 19}`)
  })
})

describe('评估循环', () => {
  it('有新建议时通知并标记（无事件时纯巡检，不空转 evaluateNow）', async () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([
      { id: 's1', kind: 'automation', title: '建议自动化测试', reason: 'r', status: 'suggested' } as never,
    ])
    vi.spyOn(suggestService, 'dndActive').mockReturnValue(false)
    const evaluateSpy = vi.spyOn(suggestService, 'evaluateNow').mockResolvedValue([])
    const { impl, shown } = fakeNotifier()
    const state = fakeState()
    const res = await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(res.evaluated).toBe(true)
    expect(res.notified).toBe(true)
    expect(shown.length).toBe(1)
    expect(shown[0].title).toContain('自动化建议')
    expect(shown[0].url).toContain('8737')
    expect(state.notifiedIds).toContain('s1')
    expect(state.lastNotifyAt).toBeTruthy()
    // 无事件：纯巡检开口通道，不空转 evaluateNow
    expect(evaluateSpy).not.toHaveBeenCalled()
  })

  it('有跨工具事件时真定时评估（0.6：evaluateNow 被调用，P0-1 完成）', async () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const dir = path.join(TEST_DIR, 'events')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      [
        JSON.stringify({ v: 1, t: 'start', tool: 'claude', at: Date.now() - 2000, sid: 'sid1' }),
        JSON.stringify({ v: 1, t: 'msg', tool: 'claude', at: Date.now() - 1000, sid: 'sid1', role: 'u', text: '以后都用 pnpm 安装' }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const evaluateSpy = vi.spyOn(suggestService, 'evaluateNow').mockResolvedValue([])
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([])
    vi.spyOn(suggestService, 'dndActive').mockReturnValue(false)
    const { impl } = fakeNotifier()
    const state = fakeState()
    await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(evaluateSpy).toHaveBeenCalledTimes(1)
    const arg = evaluateSpy.mock.calls[0][0]
    expect(arg.trigger).toBe('timer')
    expect(arg.messages).toEqual([{ role: 'user', content: '以后都用 pnpm 安装' }])
    expect(arg.sessionId).toBe('sid1')
  })

  it('DND 时段不通知且不标记（建议保留待通知，P1-1）', async () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([
      { id: 's2', kind: 'todo', title: '待办 DND', reason: 'r', status: 'suggested' } as never,
    ])
    vi.spyOn(suggestService, 'dndActive').mockReturnValue(true)
    const { impl, shown } = fakeNotifier()
    const state = fakeState()
    const res = await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(res.evaluated).toBe(true)
    expect(res.notified).toBe(false)
    expect(shown.length).toBe(0)
    expect(state.notifiedIds).not.toContain('s2')
  })

  it('无新建议不通知', async () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([])
    const { impl, shown } = fakeNotifier()
    const state = fakeState()
    const res = await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(res.notified).toBe(false)
    expect(shown.length).toBe(0)
    expect(state.lastRunAt).toBeTruthy()
  })

  it('通知失败不标记（下轮重试，P2-3）', async () => {
    vi.spyOn(suggestService, 'listSuggestionsForUI').mockReturnValue([
      { id: 's3', kind: 'followup', title: '跟进失败重试', reason: 'r', status: 'suggested' } as never,
    ])
    vi.spyOn(suggestService, 'dndActive').mockReturnValue(false)
    const impl: Notifier = { platform: 'linux', async show() { return { ok: false, error: 'notify-send missing' } } }
    const state = fakeState()
    const res = await runEvaluationCycle(state, { port: 8737, notifierImpl: impl })
    expect(res.notified).toBe(false)
    expect(state.notifiedIds).not.toContain('s3')
    expect(state.lastNotifyAt).toBeUndefined()
  })
})
