/**
 * UMP 兼容层测试（0.7 L0）
 */

import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { atomToUmpRecord, atomTypeToUmpKind, umpKindToAtomType, exportUmpFile, importUmpFile } from './ump'
import type { UmpRecord } from './ump'
import { runUmpCli } from './cli/ump'
import { memoryService } from '@proactive-agent/core'

const TEST_DIR = '/tmp/proactive-ump-test'
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

describe('类型映射', () => {
  it('atom type → UMP kind', () => {
    expect(atomTypeToUmpKind('fact')).toBe('semantic')
    expect(atomTypeToUmpKind('preference')).toBe('semantic')
    expect(atomTypeToUmpKind('event')).toBe('semantic')
    expect(atomTypeToUmpKind('sop')).toBe('procedural')
    expect(atomTypeToUmpKind('correction')).toBe('procedural')
    expect(atomTypeToUmpKind('todo_context')).toBe('procedural')
  })
  it('UMP kind → atom type（保守映射）', () => {
    expect(umpKindToAtomType('semantic')).toBe('fact')
    expect(umpKindToAtomType('procedural')).toBe('sop')
    expect(umpKindToAtomType('unknown')).toBe('fact')
  })
})

describe('Record 映射', () => {
  it('atom → UMP record 字段正确', () => {
    const atom = {
      id: 'a1',
      content: '用户偏好 TypeScript',
      type: 'preference' as const,
      priority: 80,
      sessionId: 's1',
      workspaceSlug: 'proj-x',
      scope: 'project' as const,
      createdAt: Date.now(),
      confirmed: true,
    }
    const rec = atomToUmpRecord(atom as never)
    expect(rec.ump).toBe('0.1')
    expect(rec.id).toBe('urn:ump:pa-a1')
    expect(rec.kind).toBe('semantic')
    expect(rec.body.text).toBe('用户偏好 TypeScript')
    expect(rec.scope.project).toBe('proj-x')
    expect(rec.scope.visibility).toBe('private')
    expect(rec.lifecycle.confidence).toBe(0.8)
    expect(rec.lifecycle.status).toBe('active')
    expect(rec.time.valid_to).toBeNull()
  })

  it('pending atom → status candidate', () => {
    const rec = atomToUmpRecord({
      id: 'a2',
      content: 'x',
      type: 'fact',
      priority: 50,
      createdAt: Date.now(),
      confirmed: false,
    } as never)
    expect(rec.lifecycle.status).toBe('candidate')
  })
})

describe('导出/导入闭环', () => {
  it('导出确认记忆 → 导入到新实例为 pending 候选（防投毒，跨实例互操作）', () => {
    memoryService.captureCandidate(
      { content: '以后都用 pnpm 安装', type: 'preference', priority: 80 },
      {},
      { confirmed: true },
    )
    const outPath = join(TEST_DIR, '.ump', 'memory.ump.json')
    const exported = exportUmpFile(outPath, { confirmed: true })
    expect(exported.count).toBeGreaterThanOrEqual(1)
    expect(existsSync(outPath)).toBe(true)

    // 导入到「另一个 PA 实例」：临时切换数据目录（验证 UMP 文件跨实例互操作）
    const importDir = '/tmp/proactive-ump-import'
    rmSync(importDir, { recursive: true, force: true })
    mkdirSync(importDir, { recursive: true })
    const prev = process.env.PROACTIVE_DATA_DIR
    process.env.PROACTIVE_DATA_DIR = importDir
    try {
      const res = importUmpFile(outPath, { confirmed: false })
      expect(res.imported).toBeGreaterThanOrEqual(1)
      expect(res.pending).toBe(res.imported)
      // pending 项存在且未确认
      const pendings = memoryService.pendingAtoms() as unknown as Array<{ content: string; confirmed: boolean }>
      expect(pendings.some((p) => p.content === '以后都用 pnpm 安装' && !p.confirmed)).toBe(true)
    } finally {
      process.env.PROACTIVE_DATA_DIR = prev
      rmSync(importDir, { recursive: true, force: true })
    }
  })

  it('导入非法文件报错', () => {
    const bad = join(TEST_DIR, 'bad.json')
    const fs = require('node:fs')
    fs.writeFileSync(bad, '{"ump":"0.1"}', 'utf-8')
    expect(() => importUmpFile(bad)).toThrow()
  })

  it('导出 >100 条不截断（P0-1 回归：分页终止条件用 totalPages）', () => {
    // 批量写入 120 条确认记忆
    for (let i = 0; i < 120; i++) {
      memoryService.captureCandidate({ content: `事实 ${i} 号`, type: 'fact', priority: 50 }, {}, { confirmed: true })
    }
    const outPath = join(TEST_DIR, 'big.ump.json')
    const exported = exportUmpFile(outPath, { confirmed: true })
    expect(exported.count).toBeGreaterThanOrEqual(120)
    expect(exported.truncated).toBeFalsy()
  })

  it('导入含 null/畸形记录不整批崩溃（P0-3 回归）', () => {
    const fs = require('node:fs')
    const bad = join(TEST_DIR, 'mixed.json')
    fs.writeFileSync(
      bad,
      JSON.stringify({ ump: '0.1', records: [null, { body: { text: '合法记录' } }, 'not-object', { body: {} }] }),
      'utf-8',
    )
    const res = importUmpFile(bad, { confirmed: false })
    expect(res.imported).toBe(1)
    expect(res.skipped).toBe(3)
  })

  it('导入超长 text 截断到 4000（P1-1 回归）', () => {
    const fs = require('node:fs')
    const long = join(TEST_DIR, 'long.json')
    fs.writeFileSync(
      long,
      JSON.stringify({ ump: '0.1', records: [{ body: { text: 'x'.repeat(10_000) } }] }),
      'utf-8',
    )
    const res = importUmpFile(long, { confirmed: true })
    expect(res.imported).toBe(1)
    const atoms = memoryService.recentAtoms(5) as unknown as Array<{ content: string }>
    expect(atoms[0].content.length).toBe(4000)
  })

  it('CLI 冒烟：ump-export / ump-import 可执行（P0-2 回归）', () => {
    const fs = require('node:fs')
    memoryService.captureCandidate({ content: 'CLI 冒烟记忆', type: 'fact', priority: 50 }, {}, { confirmed: true })
    const outPath = join(TEST_DIR, 'cli.ump.json')
    const code = runUmpCli(['ump-export', '--path', outPath])
    expect(code).toBe(0)
    expect(existsSync(outPath)).toBe(true)
    const code2 = runUmpCli(['ump-import', outPath, '--confirm'])
    expect(code2).toBe(0)
  })
})
