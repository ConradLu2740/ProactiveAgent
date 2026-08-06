/**
 * ProactiveAgent MCP Server 端到端冒烟测试
 *
 * 用 InMemoryTransport 连接真实 server，验证：
 * - tools 注册完整
 * - memory_capture → memory_recall 闭环
 * - memory_stats
 * - suggest_now（无 LLM 也应有确定性输出或安全降级）
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './index'

let client: Client
let server: ReturnType<typeof createServer>

// 隔离数据目录
const TEST_DIR = '/tmp/proactive-mcp-test'

/** 从 CallToolResult 安全提取文本（避免 content 类型推断问题） */
function toolText(res: unknown): string {
  const c = (res as { content?: unknown })?.content
  if (Array.isArray(c) && c.length > 0) {
    const first = c[0] as { text?: string }
    return typeof first?.text === 'string' ? first.text : ''
  }
  return ''
}
beforeAll(() => {
  process.env.PROACTIVE_DATA_DIR = TEST_DIR
  // 固定项目身份：防止测试从 cwd 解析 git remote 导致身份漂移（0.3.0 测试策略）
  process.env.PROACTIVE_PROJECT = 'test'
  // 强制规则模式：memory_extract 走 corrections.json 通道（验证 correction 防投毒闭环）
  process.env.PROMA_MEMORY_LLM_DISABLED = '1'
  Bun.spawnSync(['rm', '-rf', TEST_DIR])
  Bun.spawnSync(['mkdir', '-p', TEST_DIR])
})
afterAll(() => {
  Bun.spawnSync(['rm', '-rf', TEST_DIR])
  delete process.env.PROACTIVE_DATA_DIR
  delete process.env.PROACTIVE_PROJECT
  delete process.env.PROMA_MEMORY_LLM_DISABLED
})

beforeAll(async () => {
  server = createServer()
  const pair = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'proactive-mcp-test', version: '0.0.1' })
  await Promise.all([server.connect(pair[0]), client.connect(pair[1])])
})

describe('MCP server 冒烟', () => {
  it('listTools 注册了核心工具', async () => {
    const res = await client.listTools()
    const names = res.tools.map((t) => t.name)
    expect(names).toContain('memory_capture')
    expect(names).toContain('memory_recall')
    expect(names).toContain('memory_extract')
    expect(names).toContain('memory_pending')
    expect(names).toContain('persona_get')
    expect(names).toContain('scene_summary')
    expect(names).toContain('memory_stats')
    expect(names).toContain('suggest_now')
    expect(names).toContain('suggest_list')
    expect(names).toContain('suggest_accept')
    expect(names).toContain('suggest_ignore')
    expect(names).toContain('daily_review')
    expect(names).toContain('onboarding_guide')
    expect(names).toContain('correction_confirm')
    expect(names).toContain('correction_reject')
  })

  it('memory_capture 写入后 memory_recall 可召回', async () => {
    await client.callTool({
      name: 'memory_capture',
      arguments: { content: '用户偏好用中文交流', type: 'preference', priority: 80 },
    })
    const res = await client.callTool({
      name: 'memory_recall',
      arguments: { query: '中文交流偏好', limit: 5 },
    })
    const text = toolText(res)
    expect(text).toContain('中文交流')
  })

  it('memory_stats 返回统计', async () => {
    const res = await client.callTool({ name: 'memory_stats', arguments: {} })
    const text = toolText(res)
    expect(text).toContain('atomCount')
  })

  it('memory_pending 初始为空（capture 即时生效非 pending）', async () => {
    const res = await client.callTool({ name: 'memory_pending', arguments: {} })
    expect(toolText(res)).toContain('没有待确认')
  })

  it('suggest_now 在隔离空库上安全执行（返回或降级，不抛错）', async () => {
    const res = await client.callTool({
      name: 'suggest_now',
      arguments: {
        messages: [
          { role: 'user', content: '帮我整理一下今天的工作记录' },
          { role: 'assistant', content: '好的，我来整理' },
        ],
        sessionId: 'test-session-1',
      },
    })
    const text = toolText(res)
    // 无 automation/correction 上下文时应沉默，或给出建议；两者都算安全
    expect(text.length).toBeGreaterThan(0)
  })

  it('resources 可读 memory://today', async () => {
    const res = await client.readResource({ uri: 'memory://today' })
    expect(res.contents.length).toBeGreaterThan(0)
  })

  it('prompts 注册了 daily_review', async () => {
    const res = await client.listPrompts()
    const names = res.prompts.map((p) => p.name)
    expect(names).toContain('daily_review')
    expect(names).toContain('onboarding')
  })

  it('daily_review 工具返回复盘模板', async () => {
    const res = await client.callTool({ name: 'daily_review', arguments: {} })
    expect(toolText(res)).toContain('每日复盘')
  })

  it('onboarding_guide 工具返回使用说明', async () => {
    const res = await client.callTool({ name: 'onboarding_guide', arguments: {} })
    expect(toolText(res)).toContain('ProactiveAgent 使用说明')
  })

  it('memory_pending 同时列出待确认纠正（correction 通道防投毒闭环）', async () => {
    // 模拟规则模式提取：memory_extract 传含"以后/别再"的消息 → 产生 correction 候选
    await client.callTool({
      name: 'memory_extract',
      arguments: {
        messages: [{ role: 'user', content: '以后别再直接改生产数据库，先走审批流程' }],
        sessionId: 'correction-closed-loop-test',
      },
    })
    const res = await client.callTool({ name: 'memory_pending', arguments: {} })
    const text = toolText(res)
    expect(text).toContain('待确认行为纠正')
    expect(text).toContain('correction_')
  })

  it('correction_reject 拒绝 pending 纠正后不再列出', async () => {
    const pending = await client.callTool({ name: 'memory_pending', arguments: {} })
    const match = toolText(pending).match(/correction (corr_[\w]+)/)
    expect(match).not.toBeNull()
    const correctionId = match![1]
    const res = await client.callTool({ name: 'correction_reject', arguments: { id: correctionId } })
    expect(toolText(res)).toContain('已拒绝')
    const after = await client.callTool({ name: 'memory_pending', arguments: {} })
    expect(toolText(after)).not.toContain(correctionId)
  })
})
