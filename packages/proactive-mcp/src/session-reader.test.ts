/**
 * Session Reader 单元测试（临时目录，不碰真实 ~/.proma）
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseSessionLine,
  readSessionDeltas,
  resetSessionCursor,
  type SessionReaderOptions,
} from './session-reader'

const TEST_DIR = '/tmp/pa-session-reader-test'
let sessionsDir: string

beforeAll(() => {
  process.env.PROACTIVE_DATA_DIR = TEST_DIR
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  sessionsDir = join(TEST_DIR, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
})
afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env.PROACTIVE_DATA_DIR
})

function opts(): SessionReaderOptions {
  return { sessionsDir, maxSessions: 10, initialFiles: 10 }
}

function sdkLine(type: 'user' | 'assistant', text: string): string {
  return JSON.stringify({ type, message: { content: [{ type: 'text', text }] } })
}

describe('parseSessionLine', () => {
  it('解析 user/assistant SDKMessage 文本', () => {
    expect(parseSessionLine(sdkLine('user', '用 pnpm'))).toEqual({ role: 'user', content: '用 pnpm' })
    expect(parseSessionLine(sdkLine('assistant', '好的，用 pnpm'))).toEqual({ role: 'assistant', content: '好的，用 pnpm' })
  })

  it('非 user/assistant（tool_use 等）跳过', () => {
    expect(parseSessionLine(JSON.stringify({ type: 'tool_use', message: { content: 'x' } }))).toBeNull()
  })

  it('损坏 JSON 跳过', () => {
    expect(parseSessionLine('{bad json')).toBeNull()
  })

  it('空消息跳过', () => {
    expect(parseSessionLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '   ' }] } }))).toBeNull()
  })
})

describe('readSessionDeltas 增量读取', () => {
  it('首次读取最近会话，追加内容后只读增量', () => {
    resetSessionCursor()
    const f1 = join(sessionsDir, 'aaa.jsonl')
    const f2 = join(sessionsDir, 'bbb.jsonl')
    writeFileSync(f1, sdkLine('user', '项目统一用 pnpm') + '\n' + sdkLine('assistant', '好的') + '\n', 'utf-8')
    // f2 更新（mtime 更新）使其在首次选择中排前
    writeFileSync(f2, sdkLine('user', '用 TypeScript') + '\n', 'utf-8')

    const r1 = readSessionDeltas(opts())
    const total1 = r1.deltas.reduce((n, d) => n + d.messages.length, 0)
    // 首次最多读 initialFiles=10 个文件；这里 2 个文件全读
    expect(total1).toBeGreaterThanOrEqual(3)

    // 追加到 f2 → 第二次只读新增行
    appendFileSync(f2, sdkLine('user', '不要用 npm') + '\n', 'utf-8')
    const r2 = readSessionDeltas(opts())
    const f2Delta = r2.deltas.find((d) => d.sessionId === 'bbb')
    expect(f2Delta?.messages).toContainEqual({ role: 'user', content: '不要用 npm' })
    // 无变化文件不重复返回
    expect(r2.deltas.filter((d) => d.sessionId === 'aaa').length).toBe(0)
  })

  it('无变化时返回空', () => {
    const r = readSessionDeltas(opts())
    expect(r.deltas).toEqual([])
  })
})
