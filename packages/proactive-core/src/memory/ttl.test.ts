/**
 * Memory TTL 归档测试（M9）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAtom, readAllAtoms, updateAtomById } from '../memory/store'
import {
  getTtlDays,
  isExpired,
  isTtlDisabled,
  archiveExpiredAtoms,
  maybeArchiveExpired,
  readArchivedCount,
} from '../memory/ttl'
import type { MemoryAtom } from '../shared-types'

let dir: string
let oldDataDir: string | undefined
let oldMemDir: string | undefined
let oldConfigDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-ttl-'))
  oldDataDir = process.env.PROACTIVE_DATA_DIR
  oldMemDir = process.env.PROMA_MEMORY_DIR
  oldConfigDir = process.env.PROMA_CONFIG_DIR
  // 注意：getMemoryRootDir 中 PROMA_MEMORY_DIR 优先级高于 PROACTIVE_DATA_DIR，
  // 全量串行下其他测试可能残留，必须先删除保证本文件完全隔离
  process.env.PROACTIVE_DATA_DIR = dir
  delete process.env.PROMA_MEMORY_DIR
  delete process.env.PROMA_CONFIG_DIR
  delete process.env.PROACTIVE_TTL_OFF
  delete process.env.PROACTIVE_TTL_DAYS
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (oldDataDir === undefined) delete process.env.PROACTIVE_DATA_DIR
  else process.env.PROACTIVE_DATA_DIR = oldDataDir
  if (oldMemDir === undefined) delete process.env.PROMA_MEMORY_DIR
  else process.env.PROMA_MEMORY_DIR = oldMemDir
  if (oldConfigDir === undefined) delete process.env.PROMA_CONFIG_DIR
  else process.env.PROMA_CONFIG_DIR = oldConfigDir
  delete process.env.PROACTIVE_TTL_OFF
  delete process.env.PROACTIVE_TTL_DAYS
})

describe('memory/ttl 配置', () => {
  it('默认 TTL：event 30 / todo_context 90 / fact 365 / preference·correction·sop 永久', () => {
    expect(getTtlDays('event')).toBe(30)
    expect(getTtlDays('todo_context')).toBe(90)
    expect(getTtlDays('fact')).toBe(365)
    expect(getTtlDays('preference')).toBeNull()
    expect(getTtlDays('correction')).toBeNull()
    expect(getTtlDays('sop')).toBeNull()
  })

  it('PROACTIVE_TTL_DAYS 覆盖非永久类型', () => {
    process.env.PROACTIVE_TTL_DAYS = '7'
    expect(getTtlDays('event')).toBe(7)
    expect(getTtlDays('fact')).toBe(7)
    expect(getTtlDays('preference')).toBe(7) // 统一覆盖
  })

  it('PROACTIVE_TTL_OFF 禁用 TTL', () => {
    process.env.PROACTIVE_TTL_OFF = '1'
    expect(isTtlDisabled()).toBe(true)
    expect(getTtlDays('event')).toBeNull()
  })

  it('isExpired：未过期 / 过期 / 永久类型', () => {
    const now = Date.now()
    const old = now - 60 * 24 * 3600_000 // 60 天前
    expect(isExpired({ type: 'event', updatedAt: old } as MemoryAtom, now)).toBe(true)
    expect(isExpired({ type: 'event', updatedAt: now } as MemoryAtom, now)).toBe(false)
    expect(isExpired({ type: 'preference', updatedAt: old } as MemoryAtom, now)).toBe(false)
  })
})

describe('memory/ttl 归档', () => {
  function makeAtom(type: MemoryAtom['type'], content: string, updatedAt: number): MemoryAtom {
    const a = writeAtom({ content, type, priority: 50 }, { scope: 'project' })
    // 把旧时间真正写回磁盘（writeAtom 默认 updatedAt=now）
    return updateAtomById(a.id, { ...a, updatedAt }, 'project')
  }

  it('归档过期 atom：写入 archive 并从 atoms 删除；未过期保留', () => {
    const now = Date.now()
    const old = now - 60 * 24 * 3600_000
    makeAtom('event', '过期的发布事件', old)
    makeAtom('fact', '长期事实保留', now)

    const result = archiveExpiredAtoms({ now })
    expect(result.expiredCount).toBe(1)
    expect(result.archived).toBe(1)

    const remaining = readAllAtoms({ includeUnconfirmed: true })
    expect(remaining.some((a) => a.content.includes('长期事实保留'))).toBe(true)
    expect(remaining.some((a) => a.content.includes('过期的发布事件'))).toBe(false)
    expect(readArchivedCount()).toBe(1)
  })

  it('dry-run 只统计不删除', () => {
    const now = Date.now()
    const old = now - 60 * 24 * 3600_000
    makeAtom('event', '过期的发布事件', old)

    const result = archiveExpiredAtoms({ now, dryRun: true })
    expect(result.expiredCount).toBe(1)
    expect(result.archived).toBe(0)
    expect(readArchivedCount()).toBe(0)
    expect(readAllAtoms({ includeUnconfirmed: true }).length).toBe(1)
  })

  it('maybeArchiveExpired 每天至多一次', () => {
    const now = Date.now()
    const old = now - 60 * 24 * 3600_000
    makeAtom('event', '过期的发布事件', old)

    const first = maybeArchiveExpired(now)
    expect(first.archived).toBe(1)
    // 同一天再次调用：已归档过，跳过
    const second = maybeArchiveExpired(now + 1000)
    expect(second.archived).toBe(0)
    expect(readArchivedCount()).toBe(1)
  })

  it('TTL 禁用时 maybeArchiveExpired 零操作', () => {
    process.env.PROACTIVE_TTL_OFF = '1'
    const now = Date.now()
    const old = now - 60 * 24 * 3600_000
    makeAtom('event', '过期的发布事件', old)
    const result = maybeArchiveExpired(now)
    expect(result.archived).toBe(0)
    expect(readAllAtoms({ includeUnconfirmed: true }).length).toBe(1)
  })
})
