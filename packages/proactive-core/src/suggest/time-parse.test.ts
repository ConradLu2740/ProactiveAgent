/**
 * P2 时间解析器测试 — 中英文时间/周期表达 → cron / dueAt
 */

import { describe, expect, it } from 'vitest'
import { parseTimeExpression, parseChineseTime, parseEnglishTime } from './time-parse'

// 固定参考时间：2026-08-06 21:00（周四）
const NOW = new Date(2026, 7, 6, 21, 0, 0)

describe('中文时间解析', () => {
  it('每天下午5点 → cron 17点', () => {
    const r = parseChineseTime('每天下午5点检查发布状态', NOW)
    expect(r?.cron).toBe('17 0 * * *')
    expect(r?.label).toContain('17:00')
  })

  it('每天上午9点 → cron 9点', () => {
    const r = parseChineseTime('每天上午9点汇报进度', NOW)
    expect(r?.cron).toBe('9 0 * * *')
  })

  it('每天下午 5 点（数字前带空格）→ cron 17点', () => {
    const r = parseChineseTime('每天下午 5 点帮我检查发布状态', NOW)
    expect(r?.cron).toBe('17 0 * * *')
    expect(r?.label).toContain('17:00')
  })

  it('每天下午5点（无空格）→ cron 17点', () => {
    const r = parseChineseTime('每天下午5点检查发布状态', NOW)
    expect(r?.cron).toBe('17 0 * * *')
  })

  it('每周一上午 10 点（带空格）→ cron 周一10点', () => {
    const r = parseChineseTime('每周一上午 10 点开会', NOW)
    expect(r?.cron).toBe('10 0 * * 1')
  })

  it('明天下午 3 点（带空格）→ dueAt 明天15:00', () => {
    const r = parseChineseTime('明天下午 3 点提交报告', NOW)
    expect(r?.dueAt).toBe(new Date(2026, 7, 7, 15, 0, 0).getTime())
  })

  it('每天（无钟点）→ 默认 9点', () => {
    const r = parseChineseTime('每天都要备份数据库', NOW)
    expect(r?.cron).toBe('9 0 * * *')
  })

  it('每周一上午10点 → cron 周一10点', () => {
    const r = parseChineseTime('每周一上午10点开会', NOW)
    expect(r?.cron).toBe('10 0 * * 1')
  })

  it('每月1号 → cron 每月1日', () => {
    const r = parseChineseTime('每月1号生成月报', NOW)
    expect(r?.cron).toBe('9 0 1 * *')
  })

  it('明天下午3点 → dueAt 明天15:00', () => {
    const r = parseChineseTime('明天下午3点提交报告', NOW)
    expect(r?.dueAt).toBe(new Date(2026, 7, 7, 15, 0, 0).getTime())
  })

  it('明天（无钟点）→ 明天9点', () => {
    const r = parseChineseTime('明天继续做这个功能', NOW)
    expect(r?.dueAt).toBe(new Date(2026, 7, 7, 9, 0, 0).getTime())
  })

  it('下周一处 → 下周一（2026-08-10）9点', () => {
    const r = parseChineseTime('下周一处理这个任务', NOW)
    expect(r?.dueAt).toBe(new Date(2026, 7, 10, 9, 0, 0).getTime())
  })

  it('无法解析 → undefined', () => {
    expect(parseChineseTime('帮我看下这个报错', NOW)).toBeUndefined()
  })
})

describe('英文时间解析', () => {
  it('every day at 5pm → cron', () => {
    const r = parseEnglishTime('check status every day at 5pm', NOW)
    expect(r?.cron).toBe('17 0 * * *')
  })

  it('every monday → cron 周一', () => {
    const r = parseEnglishTime('meeting every monday', NOW)
    expect(r?.cron).toBe('9 0 * * 1')
  })

  it('weekly → 每周一默认', () => {
    const r = parseEnglishTime('send weekly report', NOW)
    expect(r?.cron).toBe('9 0 * * 1')
  })

  it('tomorrow at 10am → dueAt', () => {
    const r = parseEnglishTime('submit tomorrow at 10am', NOW)
    expect(r?.dueAt).toBe(new Date(2026, 7, 7, 10, 0, 0).getTime())
  })

  it('next monday → 下周一', () => {
    const r = parseEnglishTime('next monday', NOW)
    expect(r?.dueAt).toBe(new Date(2026, 7, 10, 9, 0, 0).getTime())
  })
})

describe('统一入口自动探测', () => {
  it('中文文本走中文解析', () => {
    const r = parseTimeExpression('每天下午5点跑测试', NOW)
    expect(r?.cron).toBe('17 0 * * *')
  })

  it('英文文本走英文解析', () => {
    const r = parseTimeExpression('every day at 9am', NOW)
    expect(r?.cron).toBe('9 0 * * *')
  })

  it('空/无时间表达 → undefined', () => {
    expect(parseTimeExpression('', NOW)).toBeUndefined()
    expect(parseTimeExpression('hello world', NOW)).toBeUndefined()
  })
})
