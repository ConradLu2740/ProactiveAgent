/**
 * Notifier 跨平台通知 adapter 测试（mock runner，不真弹系统通知）
 */

import { describe, expect, it } from 'vitest'
import { createNotifier, escapeAppleScript, escapePowerShell } from './notifier'
import type { NotifyResult, NotifyRunner } from './notifier'

/** 记录调用的 mock runner：默认全部成功；可用 fail 集合控制失败命令 */
function mockRunner(records: Array<{ cmd: string; args: string[] }>, fail = new Set<string>()): NotifyRunner {
  return async (cmd: string, args: string[]) => {
    records.push({ cmd, args })
    return fail.has(cmd) ? { ok: false, error: `mock fail: ${cmd}` } : { ok: true }
  }
}

describe('notifier 平台路由', () => {
  it('macOS：优先 terminal-notifier 并带 -open URL', async () => {
    const records: Array<{ cmd: string; args: string[] }> = []
    const n = createNotifier('darwin', mockRunner(records))
    const res = await n.show({ title: 'T', body: 'B', url: 'http://127.0.0.1:8737/today' })
    expect(res.ok).toBe(true)
    expect(records[0]).toEqual({ cmd: 'which', args: ['terminal-notifier'] })
    expect(records[1].cmd).toBe('terminal-notifier')
    expect(records[1].args).toContain('-open')
    expect(records[1].args).toContain('http://127.0.0.1:8737/today')
  })

  it('macOS：terminal-notifier 缺失时降级 osascript', async () => {
    const records: Array<{ cmd: string; args: string[] }> = []
    const n = createNotifier('darwin', mockRunner(records, new Set(['which'])))
    const res = await n.show({ title: '标题', body: '正文' })
    expect(res.ok).toBe(true)
    expect(records[0].cmd).toBe('which')
    expect(records[1].cmd).toBe('osascript')
    const script = records[1].args[1] ?? ''
    expect(script).toContain('display notification "正文" with title "标题"')
  })

  it('osascript 正确转义双引号与反斜杠', async () => {
    const records: Array<{ cmd: string; args: string[] }> = []
    const n = createNotifier('darwin', mockRunner(records, new Set(['which'])))
    await n.show({ title: 'T', body: '他说"你好" \\ 结尾' })
    const script = records[1]?.args[1] ?? ''
    expect(script).toContain('他说\\"你好\\"')
    expect(script).toContain('\\\\ 结尾')
  })

  it('Linux：调用 notify-send', async () => {
    const records: Array<{ cmd: string; args: string[] }> = []
    const n = createNotifier('linux', mockRunner(records))
    const res = await n.show({ title: 'T', body: 'B' })
    expect(res.ok).toBe(true)
    expect(records[0]).toEqual({ cmd: 'notify-send', args: ['-a', 'ProactiveAgent', '-u', 'normal', 'T', 'B'] })
  })

  it('Windows：调用 PowerShell 托盘气泡并转义单引号', async () => {
    const records: Array<{ cmd: string; args: string[] }> = []
    const n = createNotifier('win32', mockRunner(records))
    const res = await n.show({ title: 'Task"s', body: "it's ok" })
    expect(res.ok).toBe(true)
    expect(records[0].cmd).toBe('powershell')
    const ps = records[0].args.join(' ')
    expect(ps).toContain("BalloonTipTitle = 'Task\"s'")
    expect(ps).toContain("it''s ok")
  })

  it('不支持平台返回 ok:false', async () => {
    const n = createNotifier('freebsd', mockRunner([]))
    const res = await n.show({ title: 'T', body: 'B' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不支持')
  })

  it('系统命令失败时静默降级（不抛错）', async () => {
    const n = createNotifier('linux', mockRunner([], new Set(['notify-send'])))
    const res = await n.show({ title: 'T', body: 'B' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('mock fail')
  })

  it('runner 抛异常时 show 不抛出', async () => {
    const boom: NotifyRunner = async () => {
      throw new Error('boom')
    }
    const n = createNotifier('linux', boom)
    const res: NotifyResult = await n.show({ title: 'T', body: 'B' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('boom')
  })
})

describe('转义工具函数', () => {
  it('escapeAppleScript 转义反斜杠与双引号', () => {
    expect(escapeAppleScript('a"b\\c')).toBe('a\\"b\\\\c')
  })
  it('escapePowerShell 转义单引号', () => {
    expect(escapePowerShell("it's")).toBe("it''s")
  })
  it('控制字符/换行替换为空格（P1-7：防 osascript 语法错误）', () => {
    expect(escapeAppleScript('a\nb\rc\td\u0000e')).toBe('a b c d e')
    expect(escapePowerShell('a\nb\rc')).toBe('a b c')
  })
})
