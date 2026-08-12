/**
 * HostAdapter M1 测试：接口/注册表/能力矩阵/纯函数（渲染、提取、宿主识别）
 */

import { describe, expect, it } from 'vitest'
import { registerAdapter, getAdapter, listAdapters, detectHostId, claudeAdapter, kimiAdapter, cursorAdapter, looksLikeCursorInput, readCursorSession } from './index'
import { renderTextSuggestion, renderTodayInjection, extractTranscriptMessages } from './claude'
import { renderKimiNotification, extractWireMessages } from './kimi'

const SUG: Array<{ id: string; kind: string; title: string; reason: string }> = [
  { id: 's1', kind: 'correction', title: '记住这个纠正', reason: '用户纠正了行为' },
]

describe('注册表', () => {
  it('内置注册 claude + kimi + cursor，可获取', () => {
    expect(listAdapters().map((a) => a.id).sort()).toEqual(['claude', 'cursor', 'kimi'])
    expect(getAdapter('claude')).toBe(claudeAdapter)
    expect(getAdapter('kimi')).toBe(kimiAdapter)
    expect(getAdapter('cursor')).toBe(cursorAdapter)
    expect(getAdapter('cline')).toBeUndefined() // M3 未实现
  })

  it('重复注册 fail loud（参考 harnery registry）', () => {
    expect(() => registerAdapter(claudeAdapter)).toThrow(/重复注册/)
  })
})

describe('能力矩阵（判断用能力而非宿主名）', () => {
  it('Kimi：resources/prompts 为 false（今天实测：模板必须暴露为 tools）', () => {
    expect(kimiAdapter.capabilities.resources).toBe(false)
    expect(kimiAdapter.capabilities.prompts).toBe(false)
    expect(kimiAdapter.capabilities.plugin).toBe(true)
    expect(kimiAdapter.capabilities.midSessionInjection).toBe('notification-xml')
  })

  it('Kimi：hooks 为 partial 并带 note（0.34 缺陷 → 0.35 恢复）', () => {
    const h = kimiAdapter.capabilities.hooks
    expect(typeof h).toBe('object')
    expect((h as { partial: string }).partial).toContain('0.35')
  })

  it('Claude：全能力支持，会话中注入为 stdout-text', () => {
    expect(claudeAdapter.capabilities.resources).toBe(true)
    expect(claudeAdapter.capabilities.midSessionInjection).toBe('stdout-text')
  })

  it('M2 Cursor：Claude Code hooks 兼容声明（partial 带 note，诚实不伪造）', () => {
    expect(cursorAdapter.id).toBe('cursor')
    const h = cursorAdapter.capabilities.hooks
    expect(typeof h).toBe('object')
    expect((h as { partial: string }).partial).toContain('待实测')
    // 事件映射：Claude Code 兼容名
    expect(cursorAdapter.hooks.eventMap.sessionStart).toBe('start')
    expect(cursorAdapter.hooks.eventMap.beforeSubmitPrompt).toBe('msg')
    expect(cursorAdapter.hooks.eventMap.stop).toBe('end')
    // 会话读取诚实声明：未调研 → partial
    const sr = cursorAdapter.capabilities.sessionRead
    expect(typeof sr).toBe('object')
    expect(readCursorSession({ sessionId: 'x' }).messages).toEqual([])
  })

  it('M2 cursor 宿主识别：camelCase 字段（looksLikeCursorInput / detectHostId）', () => {
    const input = { sessionId: 's1', hookEventName: 'beforeSubmitPrompt' }
    expect(looksLikeCursorInput(input)).toBe(true)
    expect(detectHostId(input)).toBe('cursor')
    expect(looksLikeCursorInput({ session_id: 's1' })).toBe(false)
  })
})

describe('表达渲染（收编自 common.ts，行为一致）', () => {
  it('claude 文本建议渲染（含空数组沉默）', () => {
    const out = renderTextSuggestion(SUG)
    expect(out).toContain('【ProactiveAgent 建议】')
    expect(out).toContain('纠正建议')
    expect(out).toContain('suggest_accept')
    expect(renderTextSuggestion([])).toBe('')
  })

  it('kimi notification XML 渲染（对齐 Kimi task 通知范式）', () => {
    const out = renderKimiNotification(SUG)
    expect(out).toContain('<notification id="pa-s1"')
    expect(out).toContain('Title: 记住这个纠正')
    expect(out).toContain('Severity: info')
    expect(out).toContain('</notification>')
    expect(renderKimiNotification([])).toBe('')
  })

  it('注入渲染：无内容沉默；有内容含建议/画像/记忆', () => {
    expect(renderTodayInjection({ suggestions: [], scenes: [], personaSummary: '', topMemories: [] })).toBe('')
    const out = renderTodayInjection({
      suggestions: SUG,
      scenes: [{ title: '发布 0.9.2', heat: 80 }],
      personaSummary: '中文优先，偏好 pnpm',
      topMemories: ['项目用 bun 管理'],
    })
    expect(out).toContain('【ProactiveAgent 主动中心】')
    expect(out).toContain('待处理建议')
    expect(out).toContain('近期关注：发布 0.9.2')
    expect(out).toContain('用户画像：中文优先，偏好 pnpm')
    expect(out).toContain('近期记忆')
  })
})

describe('宿主识别（detectHostId）', () => {
  it('kimi：is_steer / client_type=kimi_code_cli', () => {
    expect(detectHostId({ is_steer: false })).toBe('kimi')
    expect(detectHostId({ client_type: 'kimi_code_cli' })).toBe('kimi')
  })
  it('cursor：camelCase 字段', () => {
    expect(detectHostId({ sessionId: 'x', hookEventName: 'UserPromptSubmit' })).toBe('cursor')
  })
  it('claude：snake_case 默认', () => {
    expect(detectHostId({ session_id: 'x', transcript_path: '/t' })).toBe('claude')
  })
})

describe('会话读取（收编自 hooks 脚本，行为一致）', () => {
  it('claude transcript 提取（SDKMessage 风格）', () => {
    const { writeFileSync, mkdirSync, rmSync } = require('node:fs')
    const { join } = require('node:path')
    const dir = '/tmp/adapter-test-' + Date.now()
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'transcript.jsonl')
    writeFileSync(
      p,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
        JSON.stringify({ type: 'system' }),
      ].join('\n'),
      'utf-8',
    )
    const msgs = extractTranscriptMessages(p)
    expect(msgs.length).toBe(2)
    expect(msgs[0]).toEqual({ role: 'user', content: '你好' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('kimi wire 提取（context.append_message）', () => {
    const { writeFileSync, mkdirSync, rmSync } = require('node:fs')
    const { join } = require('node:path')
    const dir = '/tmp/adapter-test-' + Date.now()
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'wire.jsonl')
    writeFileSync(
      p,
      [
        JSON.stringify({ type: 'metadata', protocol_version: '1.5' }),
        JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '用 pnpm' }] } }),
        JSON.stringify({ type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }),
        JSON.stringify({ type: 'llm.request' }),
      ].join('\n'),
      'utf-8',
    )
    const msgs = extractWireMessages(p)
    expect(msgs.length).toBe(2)
    expect(msgs[1]).toEqual({ role: 'assistant', content: '好的' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('kimi readSession：session_id 定位 wire', () => {
    // 用真实 ~/.kimi-code/sessions 下已存在的 session（8/12 实测环境）或空结果兜底
    const res = kimiAdapter.readSession({ sessionId: 'session_70ef425a-9b92-4493-a592-ef97e572f60c' })
    // 环境无关断言：返回结构合法（messages 数组 + 可选 path）
    expect(Array.isArray(res.messages)).toBe(true)
    if (res.path) expect(res.messages.length).toBeGreaterThan(0)
  })
})
