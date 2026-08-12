/**
 * cli-init 测试：Kimi 用户级 mcp.json 写入 + Kimi 主动 Agent 模板生成。
 *
 * 用临时 HOME 隔离（vitest fileParallelism:false 串行执行，环境变量安全）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  KIMI_AGENT_TEMPLATE,
  kimiPermissionHint,
  writeKimiAgentFile,
  writeKimiUserMcp,
} from './cli-init'

const TEST_HOME = join(tmpdir(), `pa-cli-init-test-${process.pid}`)
const ORIG_HOME = process.env.HOME

beforeAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
  mkdirSync(TEST_HOME, { recursive: true })
  process.env.HOME = TEST_HOME
})

afterAll(() => {
  process.env.HOME = ORIG_HOME
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('writeKimiUserMcp', () => {
  it('首次写入：生成 ~/.kimi-code/mcp.json，server 名为 proactive-agent（node 入口）', () => {
    const res = writeKimiUserMcp(false, false)
    expect(res.wrote).toBe(true)
    expect(res.skipped).toBe(false)
    expect(res.error).toBeUndefined()

    const target = join(TEST_HOME, '.kimi-code', 'mcp.json')
    expect(existsSync(target)).toBe(true)
    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    const server = parsed.mcpServers['proactive-agent']
    expect(server).toBeDefined()
    expect(server.command).toBe('node')
    // 源码模式指向 cli-init.ts，发布 bundle 指向 dist/index.js——两者都是"当前模块自身"
    expect(server.args[0]).toMatch(/(dist\/index\.js|cli-init\.ts)$/)
    expect(existsSync(server.args[0])).toBe(true)
  })

  it('已存在且非 force → 跳过不覆盖', () => {
    const target = join(TEST_HOME, '.kimi-code', 'mcp.json')
    const before = readFileSync(target, 'utf-8')
    const res = writeKimiUserMcp(false, false)
    expect(res.wrote).toBe(false)
    expect(res.skipped).toBe(false)
    expect(readFileSync(target, 'utf-8')).toBe(before)
  })

  it('force → 覆盖', () => {
    const res = writeKimiUserMcp(false, true)
    expect(res.wrote).toBe(true)
  })

  it('dryRun → 零写盘且 reason=dry-run', () => {
    // 清掉已有条目：dry-run 在全新环境应报 dry-run（已存在则报 exists 优先）
    rmSync(join(TEST_HOME, '.kimi-code', 'mcp.json'))
    const res = writeKimiUserMcp(false, false, true)
    expect(res.wrote).toBe(false)
    expect(res.reason).toBe('dry-run')
    expect(existsSync(join(TEST_HOME, '.kimi-code', 'mcp.json'))).toBe(false)
  })

  it('合并保留用户已有的其他 server 条目', () => {
    const target = join(TEST_HOME, '.kimi-code', 'mcp.json')
    writeFileSync(
      target,
      JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['context7'] } } }),
      'utf-8',
    )
    const res = writeKimiUserMcp(false, true) // force 确保覆盖 proactive-agent 条目
    expect(res.wrote).toBe(true)
    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as { mcpServers: Record<string, unknown> }
    expect(parsed.mcpServers['context7']).toBeDefined() // 其他条目保留
    expect(parsed.mcpServers['proactive-agent']).toBeDefined()
    rmSync(target)
  })

  it('HOME 缺失 → skipped（不尝试写盘）', () => {
    const saved = process.env.HOME
    delete process.env.HOME
    try {
      const res = writeKimiUserMcp(false, false)
      expect(res.skipped).toBe(true)
      expect(res.wrote).toBe(false)
    } finally {
      process.env.HOME = saved
    }
  })

  it('损坏 JSON → 拒绝写盘并报错', () => {
    const target = join(TEST_HOME, '.kimi-code', 'mcp.json')
    writeFileSync(target, '{broken json', 'utf-8')
    const res = writeKimiUserMcp(false, true)
    expect(res.wrote).toBe(false)
    expect(res.error).toBeDefined()
    expect(res.error).toContain('不是合法 JSON')
    // 恢复
    rmSync(target)
  })
})

describe('writeKimiAgentFile', () => {
  it('首次写入：生成 ~/.kimi-code/agents/proactive.md，内容为模板', () => {
    const res = writeKimiAgentFile(false)
    expect(res.wrote).toBe(true)

    const target = join(TEST_HOME, '.kimi-code', 'agents', 'proactive.md')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe(KIMI_AGENT_TEMPLATE)
    // 模板关键要素
    expect(KIMI_AGENT_TEMPLATE).toContain('name: proactive')
    expect(KIMI_AGENT_TEMPLATE).toContain('memory_capture')
    expect(KIMI_AGENT_TEMPLATE).toContain('memory_recall')
    expect(KIMI_AGENT_TEMPLATE).toContain('否定词必须保留')
    expect(KIMI_AGENT_TEMPLATE).toContain('${base_prompt}')
  })

  it('已存在且非 force → 跳过', () => {
    const target = join(TEST_HOME, '.kimi-code', 'agents', 'proactive.md')
    writeFileSync(target, '# 用户自定义版本', 'utf-8')
    const res = writeKimiAgentFile(false)
    expect(res.wrote).toBe(false)
    expect(readFileSync(target, 'utf-8')).toBe('# 用户自定义版本')
  })

  it('force → 覆盖为模板', () => {
    const res = writeKimiAgentFile(true)
    expect(res.wrote).toBe(true)
    expect(readFileSync(join(TEST_HOME, '.kimi-code', 'agents', 'proactive.md'), 'utf-8')).toBe(KIMI_AGENT_TEMPLATE)
  })

  it('dryRun → 零写盘且 reason=dry-run', () => {
    rmSync(join(TEST_HOME, '.kimi-code', 'agents', 'proactive.md'))
    const res = writeKimiAgentFile(false, true)
    expect(res.wrote).toBe(false)
    expect(res.reason).toBe('dry-run')
    expect(existsSync(join(TEST_HOME, '.kimi-code', 'agents', 'proactive.md'))).toBe(false)
  })

  it('HOME 缺失 → skipped（不尝试写盘）', () => {
    const saved = process.env.HOME
    delete process.env.HOME
    try {
      const res = writeKimiAgentFile(false)
      expect(res.skipped).toBe(true)
      expect(res.wrote).toBe(false)
    } finally {
      process.env.HOME = saved
    }
  })
})

describe('kimiPermissionHint', () => {
  it('给出只读工具的 allow 规则（写类不在其中）', () => {
    const hint = kimiPermissionHint()
    expect(hint).toContain('[[permission.rules]]')
    expect(hint).toContain('decision = "allow"')
    expect(hint).toContain('mcp__proactive-agent__memory_recall')
    expect(hint).toContain('mcp__proactive-agent__persona_get')
    expect(hint).not.toContain('memory_capture')
  })
})
