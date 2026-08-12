/**
 * /today Web 面板测试
 */

import { rmSync, mkdirSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTodayHtml, buildTodayPayload, startTodayServer, ensureTodayToken } from './today'
import { memoryService } from '@proactive-agent/core'

const TEST_DIR = '/tmp/proactive-today-test'
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

describe('/today 面板', () => {
  it('buildTodayPayload 返回完整结构', () => {
    const p = buildTodayPayload()
    expect(p.generatedAt).toBeTruthy()
    expect(p.dataDir).toBe(TEST_DIR)
    expect(Array.isArray(p.suggestions)).toBe(true)
    expect(Array.isArray(p.hotScenes)).toBe(true)
    expect(typeof p.stats.atomCount).toBe('number')
  })

  it('buildTodayHtml 渲染建议与场景', () => {
    // 先写入一条记忆 + 建议
    memoryService.captureCandidate(
      { content: '用户偏好 TypeScript', type: 'preference', priority: 80 },
      {},
      { confirmed: true },
    )
    const html = buildTodayHtml()
    expect(html).toContain('主动中心')
    expect(html).toContain('数据目录')
    expect(html).toContain('原子记忆')
    expect(html).toContain('用户画像')
  })

  it('HTML 转义安全（不注入 <script>）', () => {
    memoryService.captureCandidate(
      { content: '用户<script>alert(1)</script>偏好 X', type: 'fact', priority: 50 },
      {},
      { confirmed: true },
    )
    const html = buildTodayHtml()
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('页面带 15s 自动刷新（轮询 /api/today）', () => {
    const html = buildTodayHtml()
    expect(html).toContain('setInterval(refresh, 15000)')
    expect(html).toContain("fetch('/api/today')")
    // 数据区块都有可更新的 id
    expect(html).toContain('id="suggestions"')
    expect(html).toContain('id="scenes"')
    expect(html).toContain('id="stats-count"')
    expect(html).toContain('id="persona"')
  })
})

describe('ActionCard 闭环 API（0.5）', () => {
  it('accept/ignore 路由存在，带 token 对不存在建议返回 ok:false', async () => {
    const token = ensureTodayToken()
    const server = startTodayServer(0)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      for (const action of ['accept', 'ignore']) {
        const res = await fetch(`http://127.0.0.1:${port}/api/suggestions/nonexistent-id/${action}`, {
          method: 'POST',
          headers: { 'x-pa-token': token },
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { ok: boolean }
        expect(body.ok).toBe(false)
      }
    } finally {
      server.close()
    }
  })

  it('写接口无 token 被拒（401，P1-4）', async () => {
    ensureTodayToken()
    const server = startTodayServer(0)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/suggestions/x/accept`, { method: 'POST' })
      expect(res.status).toBe(401)
      const wrong = await fetch(`http://127.0.0.1:${port}/api/suggestions/x/accept`, {
        method: 'POST',
        headers: { 'x-pa-token': 'wrong-token' },
      })
      expect(wrong.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('畸形 URL 编码返回 400 而非 500（P2-5）', async () => {
    const token = ensureTodayToken()
    const server = startTodayServer(0)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/suggestions/%zz/accept`, {
        method: 'POST',
        headers: { 'x-pa-token': token },
      })
      expect(res.status).toBe(400)
    } finally {
      server.close()
    }
  })

  it('HTML 面板包含接受/忽略按钮与 token 注入', () => {
    const html = buildTodayHtml()
    expect(html).toContain('data-action="accept"')
    expect(html).toContain('data-action="ignore"')
    expect(html).toContain('const PA_TOKEN = ')
  })
})
