/**
 * /today Web 面板测试
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildTodayHtml, buildTodayPayload } from './today'
import { memoryService } from '@proactive-agent/core'

const TEST_DIR = '/tmp/proactive-today-test'
beforeAll(() => {
  process.env.PROACTIVE_DATA_DIR = TEST_DIR
  process.env.PROMA_MEMORY_LLM_DISABLED = '1'
  Bun.spawnSync(['rm', '-rf', TEST_DIR])
  Bun.spawnSync(['mkdir', '-p', TEST_DIR])
})
afterAll(() => {
  Bun.spawnSync(['rm', '-rf', TEST_DIR])
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
