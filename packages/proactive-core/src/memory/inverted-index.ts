/**
 * Memory 倒排索引（M9）— 支撑上万条记忆的关键词检索
 *
 * 设计：
 * - postings: Map<term, Set<atomId>>，term 由 tokenize 产生（与 recall 同分词）
 * - 内存缓存 + 签名失效：签名 = 层 key + atoms 数量 + 首尾 atom id，
 *   数据文件变化（增删改）导致签名变化时自动重建
 * - 接入：recall 先用 query terms 查索引得到候选 atomId 集，只对候选打分（替代全量扫描）
 * - fail-open：索引无命中时调用方回退全量扫描，保证不漏召回
 */

import type { MemoryAtom } from '../shared-types'
import { tokenize } from './tokens'

export interface InvertedIndex {
  /** term -> atomIds（只索引 confirmed 且未归档的 atom） */
  postings: Map<string, Set<string>>
  /** 覆盖的 atomId 集合大小（用于签名失效判断） */
  coveredCount: number
  /** 首尾 atom id（append 场景快速失效判断） */
  firstId?: string
  lastId?: string
  builtAt: number
}

/** 索引签名：数量 + 首尾 id（append/删除/替换都能捕获变化） */
export function indexSignature(atoms: MemoryAtom[]): string {
  if (atoms.length === 0) return '0:'
  const first = atoms[0]?.id ?? ''
  const last = atoms[atoms.length - 1]?.id ?? ''
  return `${atoms.length}:${first}:${last}`
}

let cachedSignature: string | undefined
let cachedIndex: InvertedIndex | undefined

/** 构建倒排索引（纯函数，可单测） */
export function buildInvertedIndex(atoms: MemoryAtom[]): InvertedIndex {
  const postings = new Map<string, Set<string>>()
  for (const atom of atoms) {
    // 只索引已确认且非归档的记忆（pending 由确认流程管理，不进召回索引）
    if (!atom.confirmed || atom.metadata?.archived === true) continue
    const tokens = new Set(tokenize(`${atom.content} ${atom.type}`.toLowerCase()))
    for (const t of tokens) {
      if (t.length < 2) continue // 单字不索引（recall 查询侧也不参与单字强命中判定）
      let set = postings.get(t)
      if (!set) {
        set = new Set()
        postings.set(t, set)
      }
      set.add(atom.id)
    }
  }
  return {
    postings,
    coveredCount: atoms.length,
    firstId: atoms[0]?.id,
    lastId: atoms[atoms.length - 1]?.id,
    builtAt: Date.now(),
  }
}

/** 基于缓存取索引：签名变化时自动重建（线程安全由单线程 JS 保证） */
export function getIndexFor(atoms: MemoryAtom[]): InvertedIndex {
  const sig = indexSignature(atoms)
  if (cachedSignature !== sig || !cachedIndex) {
    cachedIndex = buildInvertedIndex(atoms)
    cachedSignature = sig
  }
  return cachedIndex
}

/** 测试/重置用 */
export function resetIndexCache(): void {
  cachedSignature = undefined
  cachedIndex = undefined
}

/** 查询：给定 terms，返回候选 atomId 集（所有命中 term 的并集） */
export function lookupCandidates(index: InvertedIndex, terms: string[]): Set<string> {
  const out = new Set<string>()
  for (const term of terms) {
    const ids = index.postings.get(term)
    if (ids) for (const id of ids) out.add(id)
  }
  return out
}
