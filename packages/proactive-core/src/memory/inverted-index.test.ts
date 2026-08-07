/**
 * Memory 倒排索引测试（M9）
 */
import { describe, expect, it } from 'bun:test'
import { buildInvertedIndex, getIndexFor, lookupCandidates, resetIndexCache, indexSignature } from './inverted-index'
import { tokenize } from './tokens'
import type { MemoryAtom } from '../shared-types'

function atom(partial: Partial<MemoryAtom> & { id: string; content: string; type: MemoryAtom['type'] }): MemoryAtom {
  return {
    priority: 50,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    confirmed: true,
    ...partial,
  }
}

const atoms: MemoryAtom[] = [
  atom({ id: 'a1', content: '项目用 bun 构建，MCP Server 形态', type: 'fact' }),
  atom({ id: 'a2', content: 'UI 文案统一使用中文', type: 'preference' }),
  atom({ id: 'a3', content: '每天下午 5 点检查发布状态', type: 'sop' }),
  atom({ id: 'a4', content: 'bug 修复记录：排序算法边界', type: 'event' }),
]

describe('memory/inverted-index', () => {
  it('tokenize 提供中文 bigram 与英文单词', () => {
    expect(tokenize('bun 构建')).toContain('bun')
    expect(tokenize('bun 构建')).toContain('构建')
    expect(tokenize('bun 构建')).toContain('构建'.slice(0, 1))
  })

  it('buildInvertedIndex 建立 term -> atomIds 映射', () => {
    const idx = buildInvertedIndex(atoms)
    expect(idx.postings.get('bun')?.has('a1')).toBe(true)
    expect(idx.postings.get('构建')?.has('a1')).toBe(true)
    expect(idx.postings.get('中文')?.has('a2')).toBe(true)
  })

  it('lookupCandidates 返回命中词并集', () => {
    const idx = buildInvertedIndex(atoms)
    const hits = lookupCandidates(idx, ['bun', '发布'])
    expect(hits.has('a1')).toBe(true)
    expect(hits.has('a3')).toBe(true)
    expect(hits.size).toBe(2)
  })

  it('未命中词返回空集（调用方回退全量）', () => {
    const idx = buildInvertedIndex(atoms)
    const hits = lookupCandidates(idx, ['不存在的词xyz'])
    expect(hits.size).toBe(0)
  })

  it('pending（未确认）atom 不进索引', () => {
    const idx = buildInvertedIndex([atom({ id: 'p1', content: '待确认的记忆内容', type: 'fact', confirmed: false })])
    expect(idx.postings.get('确认')?.has('p1') ?? false).toBe(false)
  })

  it('archived atom 不进索引', () => {
    const idx = buildInvertedIndex([
      atom({ id: 'x1', content: '已归档内容', type: 'fact', metadata: { archived: true } }),
    ])
    expect(idx.postings.get('归档')?.has('x1') ?? false).toBe(false)
  })

  it('缓存签名：数量/首尾 id 变化触发重建', () => {
    resetIndexCache()
    const i1 = getIndexFor(atoms)
    expect(getIndexFor(atoms)).toBe(i1) // 相同签名复用缓存
    const more = [...atoms, atom({ id: 'a9', content: '新增记忆', type: 'fact' })]
    const i2 = getIndexFor(more)
    expect(i2).not.toBe(i1)
    expect(i2.postings.get('新增')?.has('a9')).toBe(true)
    resetIndexCache()
  })

  it('indexSignature 对空数组稳定', () => {
    expect(indexSignature([])).toBe('0:')
  })
})
