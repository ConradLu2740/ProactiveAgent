/**
 * Memory Activity + Review Opportunity 测试（v0.8.0：对标 Proma v0.17.0 watcher/refresh）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureCandidate, memoryActivity, memoryReviewOpportunity, daysSinceLastMemoryUpdate } from '../memory/service'
import { appendMemoryLog, getMemoryActivity, readMemoryLogRecent } from '../memory/store'
import { getMemoryLogDir } from '../paths'

let dir: string
let oldDataDir: string | undefined
let oldMemDir: string | undefined
let oldConfigDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-activity-'))
  oldDataDir = process.env.PROACTIVE_DATA_DIR
  oldMemDir = process.env.PROMA_MEMORY_DIR
  oldConfigDir = process.env.PROMA_CONFIG_DIR
  process.env.PROACTIVE_DATA_DIR = dir
  delete process.env.PROMA_MEMORY_DIR
  delete process.env.PROMA_CONFIG_DIR
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (oldDataDir === undefined) delete process.env.PROACTIVE_DATA_DIR
  if (oldMemDir === undefined) delete process.env.PROMA_MEMORY_DIR
  if (oldConfigDir === undefined) delete process.env.PROMA_CONFIG_DIR
})

describe('memory/activity 记忆动态', () => {
  it('无记忆时返回空活动', () => {
    const a = getMemoryActivity()
    expect(a.lastUpdatedAt).toBe(0)
    expect(a.daysSinceLastUpdate).toBe(0)
    expect(a.todayEntries).toBe(0)
    expect(a.recentEntries).toEqual([])
  })

  it('appendMemoryLog 后能读到最近条目与今日计数', () => {
    appendMemoryLog('测试动态: 手动沉淀')
    const a = getMemoryActivity()
    expect(a.lastUpdatedAt).toBeGreaterThan(0)
    expect(a.todayEntries).toBe(1)
    expect(a.recentEntries[0]?.text).toContain('测试动态')
  })

  it('captureCandidate 写入后今日计数增加', () => {
    captureCandidate({ type: 'fact', content: 'Conrad 喜欢 TypeScript', priority: 1 }, {}, { confirmed: true })
    const a = memoryActivity()
    expect(a.todayEntries).toBeGreaterThan(0)
    expect(daysSinceLastMemoryUpdate()).toBe(0)
  })

  it('readMemoryLogRecent 限制天数与条数', () => {
    appendMemoryLog('第一条')
    appendMemoryLog('第二条')
    const entries = readMemoryLogRecent(7, 1)
    expect(entries.length).toBeLessThanOrEqual(1)
  })
})

describe('memory/review 复查邀请', () => {
  it('从未更新时无复查邀请', () => {
    expect(memoryReviewOpportunity()).toBeUndefined()
  })

  it('今天有更新时无复查邀请', () => {
    appendMemoryLog('今天有更新')
    expect(memoryReviewOpportunity()).toBeUndefined()
  })

  it('超过间隔天数返回邀请对象', () => {
    // 直接写入旧日志文件（模拟 5 天前），绕过 appendMemoryLog 的当天路径；
    // 用引擎自身的 getMemoryLogDir 解析（项目隔离模式下路径在 projects/ 下）
    const logDir = getMemoryLogDir()
    mkdirSync(logDir, { recursive: true })
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    const y = oldDate.getFullYear()
    const m = String(oldDate.getMonth() + 1).padStart(2, '0')
    const d = String(oldDate.getDate()).padStart(2, '0')
    writeFileSync(
      join(logDir, `${y}-${m}-${d}.md`),
      `- ${oldDate.toISOString()} 旧动态\n`,
      'utf-8',
    )
    const r = memoryReviewOpportunity()
    expect(r).toBeDefined()
    expect(r?.daysSince).toBeGreaterThanOrEqual(5)
    expect(r?.reviewDue).toBe(true)
    expect(r?.message).toContain('复查')
  })
})
