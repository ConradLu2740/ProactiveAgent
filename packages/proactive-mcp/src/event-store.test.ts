/**
 * Event Store 跨工具事件协议测试
 */

import { rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  writeAgentEvent,
  readRecentAgentEvents,
  eventsToMessages,
  recordMessage,
  recordLifecycle,
  eventsDir,
} from './event-store'

const TEST_DIR = '/tmp/proactive-events-test'
beforeAll(() => {
  process.env.PROACTIVE_DATA_DIR = TEST_DIR
  process.env.PROMA_MEMORY_LLM_DISABLED = '1'
})
beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})
afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env.PROACTIVE_DATA_DIR
  delete process.env.PROMA_MEMORY_LLM_DISABLED
})

describe('事件写入与读取', () => {
  it('写入后按时间升序读取，字段归一化', () => {
    recordMessage('claude', 'u', '第一条', { sid: 's1' })
    recordMessage('kimi', 'u', '第二条', { sid: 's2' })
    recordLifecycle('claude', 'end', { sid: 's1' })
    writeAgentEvent({ t: 'commit', tool: 'cursor', msg: 'fix: bug', sid: 's3' })
    const events = readRecentAgentEvents()
    expect(events.length).toBe(4)
    expect(events[0].text).toBe('第一条')
    expect(events[1].text).toBe('第二条')
    expect(events[2].t).toBe('end')
    expect(events[3].t).toBe('commit')
    expect(events[3].msg).toBe('fix: bug')
    expect(events[0].tool).toBe('claude')
    expect(events[1].tool).toBe('kimi')
  })

  it('eventsToMessages 只取 msg 事件且角色映射正确', () => {
    recordMessage('claude', 'u', '你好')
    recordMessage('claude', 'a', '回复')
    recordLifecycle('claude', 'start')
    const msgs = eventsToMessages(readRecentAgentEvents())
    expect(msgs).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '回复' },
    ])
  })

  it('空文本消息不写入', () => {
    recordMessage('claude', 'u', '   ')
    expect(readRecentAgentEvents().length).toBe(0)
  })

  it('损坏行跳过不影响其他事件', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const dir = eventsDir()
    mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), '{bad json}\n', 'utf-8')
    recordMessage('cline', 'u', '正常消息')
    const events = readRecentAgentEvents()
    expect(events.length).toBe(1)
    expect(events[0].text).toBe('正常消息')
    expect(events[0].tool).toBe('cline')
  })

  it('事件文件按天落盘 events/ 目录', () => {
    recordMessage('continue', 'u', 'x')
    const dir = eventsDir()
    expect(existsSync(dir)).toBe(true)
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBe(1)
  })

  it('并发多进程写入无丢失无损坏（P0-1 回归：锁 + 原子替换）', async () => {
    const { execFile } = require('node:child_process')
    const { promisify } = require('node:util')
    const os = require('node:os')
    const path = require('node:path')
    const execFileAsync = promisify(execFile)
    const root = process.cwd()
    // esbuild 预编译 event-store 到临时 bundle（裸 node 无法解析 TS 相对导入）
    const esbuild = require('esbuild')
    const tmpBundle = path.join(os.tmpdir(), `pa-events-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mjs`)
    esbuild.buildSync({
      entryPoints: [path.join(root, 'packages/proactive-mcp/src/event-store.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: tmpBundle,
      logLevel: 'silent',
    })
    try {
      const code = `
        import { pathToFileURL } from 'node:url'
        const m = await import(pathToFileURL('${tmpBundle}').href)
        for (let i = 0; i < 20; i++) {
          m.writeAgentEvent({ t: 'msg', tool: 'claude', role: 'u', text: 'conc-' + process.pid + '-' + i })
        }
      `
      const jobs = Array.from({ length: 4 }, () =>
        execFileAsync('node', ['--input-type=module', '-e', code], {
          cwd: root,
          env: { ...process.env, PROACTIVE_DATA_DIR: TEST_DIR },
          timeout: 30000,
        }),
      )
      await Promise.all(jobs)
      // 全部写入成功：行数 = 4 × 20，且每行都是合法 JSON（无损坏字节）
      const fs = require('node:fs')
      const dir = eventsDir()
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      const lines = files.flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').filter(Boolean))
      expect(lines.length).toBe(80)
      for (const line of lines) {
        const e = JSON.parse(line)
        expect(e.t).toBe('msg')
        expect(e.text).toMatch(/^conc-/)
      }
    } finally {
      require('node:fs').rmSync(tmpBundle, { force: true })
    }
  })

  it('事件文件权限收紧（P1-6：仅当前用户可读写）', () => {
    const { statSync } = require('node:fs')
    const { join: pjoin } = require('node:path')
    recordMessage('claude', 'u', '权限测试')
    const dir = eventsDir()
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)
    // macOS/Linux 下校验权限位（Windows 无此概念，跳过）
    if (process.platform !== 'win32') {
      const mode = statSync(pjoin(dir, files[0])).mode & 0o777
      expect(mode & 0o077).toBe(0) // 组/其他用户不可读写
    }
  })
})
