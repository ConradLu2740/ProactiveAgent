/**
 * Project Constraint 单元测试（纯函数 + LLM 解析）
 */

import { describe, expect, it } from 'vitest'
import {
  normalizeSubject,
  isOppositeSubject,
  detectConflicts,
  conflictKey,
  parseConstraintsResponse,
  buildExtractPrompt,
  type ProjectConstraint,
  type StoredConstraint,
} from './project-constraint'

describe('normalizeSubject', () => {
  it('小写去空白', () => {
    expect(normalizeSubject('pnpm')).toBe('pnpm')
    expect(normalizeSubject(' TypeScript ')).toBe('typescript')
    expect(normalizeSubject('node-js')).toBe('nodejs')
    expect(normalizeSubject('PostgreSQL')).toBe('postgresql')
  })
})

describe('isOppositeSubject', () => {
  it('对立词对命中（双向）', () => {
    expect(isOppositeSubject('pnpm', 'npm')).toBe(true)
    expect(isOppositeSubject('npm', 'pnpm')).toBe(true)
    expect(isOppositeSubject('bun', 'nodejs')).toBe(true)
    expect(isOppositeSubject('postgresql', 'mysql')).toBe(true)
  })
  it('非对立返回 false', () => {
    expect(isOppositeSubject('pnpm', 'bun')).toBe(false)
    expect(isOppositeSubject('typescript', 'pnpm')).toBe(false)
  })
})

describe('detectConflicts', () => {
  const ctx = { projectKey: 'path:abc', projectName: 'Demo', at: 1000 }

  function stored(subject: string, action: 'use' | 'avoid'): StoredConstraint {
    return { subject, action, decidedAt: 100, atomId: `atom_${subject}_${action}` }
  }

  it('use pnpm（已有 use pnpm 约束，对立 use npm）→ 冲突', () => {
    const incoming: ProjectConstraint[] = [{ action: 'use', subject: 'npm', confidence: 0.9 }]
    const conflicts = detectConflicts(incoming, [stored('pnpm', 'use')], ctx)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.existing.subject).toBe('pnpm')
    expect(conflicts[0]?.incoming.subject).toBe('npm')
  })

  it('同一 subject 相反 action（use X vs avoid X）→ 冲突', () => {
    const incoming: ProjectConstraint[] = [{ action: 'use', subject: 'npm', confidence: 0.9 }]
    const conflicts = detectConflicts(incoming, [stored('npm', 'avoid')], ctx)
    expect(conflicts).toHaveLength(1)
  })

  it('avoid pnpm + use npm → 不强冲突（avoid 与对立 use 不阻止）', () => {
    const incoming: ProjectConstraint[] = [{ action: 'use', subject: 'npm', confidence: 0.9 }]
    const conflicts = detectConflicts(incoming, [stored('pnpm', 'avoid')], ctx)
    expect(conflicts).toHaveLength(0)
  })

  it('一致约束不冲突（use pnpm vs use pnpm）', () => {
    const incoming: ProjectConstraint[] = [{ action: 'use', subject: 'pnpm', confidence: 0.9 }]
    const conflicts = detectConflicts(incoming, [stored('pnpm', 'use')], ctx)
    expect(conflicts).toHaveLength(0)
  })
})

describe('conflictKey', () => {
  it('subject 对排序后 key 稳定：同一对立对（方向交换）是同一去重键', () => {
    const c1 = {
      projectKey: 'p', projectName: 'X',
      existing: { subject: 'pnpm', action: 'use' as const, decidedAt: 1, atomId: 'a' },
      incoming: { subject: 'npm', action: 'use' as const, at: 2 },
    }
    const c2 = {
      projectKey: 'p', projectName: 'X',
      existing: { subject: 'npm', action: 'use' as const, decidedAt: 1, atomId: 'b' },
      incoming: { subject: 'pnpm', action: 'use' as const, at: 2 },
    }
    // pnpm↔npm 对立对：方向交换是同一冲突类型 → 同一去重键（24h 不重复提醒）
    expect(conflictKey(c1)).toBe(conflictKey(c2))
    // 同一冲突 key 稳定
    expect(conflictKey(c1)).toBe(conflictKey(c1))
  })
})

describe('parseConstraintsResponse', () => {
  it('解析纯 JSON', () => {
    const r = parseConstraintsResponse(
      '{"relevant":true,"constraints":[{"action":"use","subject":"pnpm","confidence":0.9},{"action":"avoid","subject":"npm","confidence":0.8}]}',
    )
    expect(r?.relevant).toBe(true)
    expect(r?.constraints).toHaveLength(2)
    expect(r?.constraints[0]).toEqual({ action: 'use', subject: 'pnpm', confidence: 0.9 })
  })

  it('容忍 markdown fence 与多余文字', () => {
    const r = parseConstraintsResponse('```json\n{"relevant":true,"constraints":[{"action":"use","subject":"TypeScript","confidence":1}]}\n```')
    expect(r?.constraints[0]?.subject).toBe('typescript')
  })

  it('否定语义保留：avoid 不被吞', () => {
    const r = parseConstraintsResponse('{"relevant":true,"constraints":[{"action":"avoid","subject":"npm","confidence":0.95}]}')
    expect(r?.constraints[0]).toEqual({ action: 'avoid', subject: 'npm', confidence: 0.95 })
  })

  it('非法 action / 空 subject 过滤', () => {
    const r = parseConstraintsResponse(
      '{"relevant":true,"constraints":[{"action":"maybe","subject":"pnpm"},{"action":"use","subject":"  "},{"action":"use","subject":"bun"}]}',
    )
    expect(r?.constraints).toHaveLength(1)
    expect(r?.constraints[0]?.subject).toBe('bun')
  })

  it('坏 JSON 返回 null', () => {
    expect(parseConstraintsResponse('not json')).toBeNull()
  })

  it('relevant=false 保留', () => {
    const r = parseConstraintsResponse('{"relevant":false,"constraints":[]}')
    expect(r?.relevant).toBe(false)
  })

  it('buildExtractPrompt 含项目名与否定规则', () => {
    const p = buildExtractPrompt('ShopGo')
    expect(p).toContain('ShopGo')
    expect(p).toContain('不要用 npm')
    expect(p).toContain('avoid')
  })
})
