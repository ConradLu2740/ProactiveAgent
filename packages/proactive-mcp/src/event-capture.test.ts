/**
 * event-capture 事件归一化测试（0.6 感知网）
 */

import { describe, expect, it } from 'vitest'
import { normalizeEvent, normalizeTool } from '../hooks/event-capture'

describe('normalizeTool 白名单', () => {
  it('识别各工具名与别名', () => {
    expect(normalizeTool('cursor')).toBe('cursor')
    expect(normalizeTool('Claude-Code')).toBe('claude')
    expect(normalizeTool('kimi')).toBe('kimi')
    expect(normalizeTool('kimi-code')).toBe('kimi')
    expect(normalizeTool('cline')).toBe('cline')
    expect(normalizeTool('continue')).toBe('continue')
    expect(normalizeTool('codex')).toBe('codex')
  })
  it('未知工具返回 undefined', () => {
    expect(normalizeTool('vscode')).toBeUndefined()
    expect(normalizeTool(undefined)).toBeUndefined()
  })
})

describe('normalizeEvent 各工具事件名映射', () => {
  it('Cursor camelCase 事件名', () => {
    expect(normalizeEvent({ hookEventName: 'sessionStart', sessionId: 'c1' })).toEqual({ event: 'start', sid: 'c1' })
    expect(normalizeEvent({ hookEventName: 'beforeSubmitPrompt', prompt: '用 pnpm', sessionId: 'c1' })).toEqual({
      event: 'message',
      text: '用 pnpm',
      sid: 'c1',
    })
    expect(normalizeEvent({ hookEventName: 'sessionEnd', sessionId: 'c1' })).toEqual({ event: 'end', sid: 'c1' })
  })

  it('Claude snake_case 事件名', () => {
    expect(normalizeEvent({ event: 'session_start', session_id: 's1' })).toEqual({ event: 'start', sid: 's1' })
    expect(normalizeEvent({ event: 'user_prompt', text: 'x', session_id: 's1' })).toEqual({ event: 'message', text: 'x', sid: 's1' })
    expect(normalizeEvent({ event: 'stop', session_id: 's1' })).toEqual({ event: 'end', sid: 's1' })
  })

  it('commit 优先于 message（commit_message 不误分类）', () => {
    expect(normalizeEvent({ event: 'commit_message', message: 'fix: x' })).toEqual({ event: 'commit', text: 'fix: x', sid: undefined })
    expect(normalizeEvent({ event: 'git_commit', message: 'feat: y' })).toEqual({ event: 'commit', text: 'feat: y', sid: undefined })
  })

  it('text 取值优先级 prompt > text > input', () => {
    expect(normalizeEvent({ event: 'message', prompt: 'p', text: 't', input: 'i' })).toEqual({ event: 'message', text: 'p', sid: undefined })
    expect(normalizeEvent({ event: 'message', text: 't', input: 'i' })).toEqual({ event: 'message', text: 't', sid: undefined })
    expect(normalizeEvent({ event: 'message', input: 'i' })).toEqual({ event: 'message', text: 'i', sid: undefined })
  })

  it('未知事件保持原样（调用方静默）', () => {
    expect(normalizeEvent({ event: 'weird_event' }).event).toBe('weird_event')
  })
})
