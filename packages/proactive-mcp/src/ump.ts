/**
 * UMP 兼容层（L0：文件导入/导出）——评估见 .context/pa-ump-compat-eval.md；
 * 2026-08-12 互操作实测修复：官方 @universalmemoryprotocol/core JsonFileStore/CLI 的
 * 文件格式为**记录数组**（每条自带 ump 版本字段），非 {ump, records} 包装；版本对齐官方 1.0（0.1 为 legacy）。
 *
 * Universal Memory Protocol（universalmemoryprotocol.io）：第三互操作层
 * （MCP 工具 / A2A 协调 / UMP 记忆）。本模块提供：
 * - MemoryAtom → UMP Record 映射（导出，记录数组）
 * - UMP Record → MemoryAtom 映射（导入，兼容数组与旧 {ump, records} 包装，默认 pending 防投毒）
 *
 * 数据格式：.ump/memory.ump.json（File binding），结构 = UmpRecord[]（官方 JsonFileStore 兼容）
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { memoryService, type MemoryAtom } from '@proactive-agent/core'

/** 对齐官方 @universalmemoryprotocol/core 当前版本 */
export const UMP_VERSION = '1.0'

/** 旧导出格式的 ump 版本（导入兼容） */
export const UMP_LEGACY_VERSIONS = ['0.1'] as const

/** UMP kind：semantic（描述性事实） / procedural（怎么做） */
export type UmpKind = 'semantic' | 'procedural'

export interface UmpRecord {
  ump: string
  id: string
  kind: UmpKind
  body: { text: string; structured?: Record<string, unknown> }
  scope: { owner: string; user?: string; project?: string; agent?: string; session?: string; visibility: 'private' | 'shared' | 'public' }
  time: { created: string; observed: string; valid_from: string; valid_to: string | null }
  lifecycle: { confidence: number; salience?: number; status: 'active' | 'candidate' | 'tombstoned' }
  provenance: { actor: string; actor_kind: 'user' | 'agent' | 'system'; method: string }
  metadata?: Record<string, unknown>
}

export interface UmpFile {
  ump: string
  records: UmpRecord[]
}

/** 兼容旧导出：{ump, records} 包装或裸记录数组均可；其他结构返回 undefined（非法） */
export function normalizeUmpFile(data: unknown): UmpRecord[] | undefined {
  if (Array.isArray(data)) return data as UmpRecord[]
  if (data && typeof data === 'object') {
    const wrapper = data as { records?: unknown }
    if (Array.isArray(wrapper.records)) return wrapper.records as UmpRecord[]
  }
  return undefined
}

export const UMP_OWNER = 'did:key:pa-local'

/** PA atom type → UMP kind */
export function atomTypeToUmpKind(type: MemoryAtom['type']): UmpKind {
  if (type === 'sop' || type === 'correction' || type === 'todo_context') return 'procedural'
  return 'semantic'
}

/** UMP kind → PA atom type（导入保守映射；semantic 事实为主） */
export function umpKindToAtomType(kind: string): MemoryAtom['type'] {
  return kind === 'procedural' ? 'sop' : 'fact'
}

/** MemoryAtom → UMP Record */
export function atomToUmpRecord(atom: MemoryAtom): UmpRecord {
  return {
    ump: UMP_VERSION,
    id: `urn:ump:pa-${atom.id}`,
    kind: atomTypeToUmpKind(atom.type),
    body: { text: atom.content },
    scope: {
      owner: UMP_OWNER,
      project: atom.workspaceSlug,
      agent: 'proactive-agent',
      session: atom.sessionId,
      visibility: 'private',
    },
    time: {
      created: new Date(atom.createdAt).toISOString(),
      observed: new Date(atom.createdAt).toISOString(),
      valid_from: new Date(atom.createdAt).toISOString(),
      valid_to: null,
    },
    lifecycle: {
      confidence: Math.min(1, Math.max(0, atom.priority / 100)),
      status: atom.confirmed ? 'active' : 'candidate',
    },
    provenance: { actor: UMP_OWNER, actor_kind: 'agent', method: 'pa-capture' },
    metadata: { paType: atom.type, paScope: atom.scope },
  }
}

/** 导入单条 text 长度上限（对齐事件 4000；防恶意 UMP 文件撑爆存储） */
export const UMP_IMPORT_TEXT_LIMIT = 4000
/** 导入单文件记录数上限 */
export const UMP_IMPORT_RECORD_LIMIT = 10_000

/** UMP Record → MemoryCandidate（导入；text 截断防注入放大） */
export function umpRecordToCandidate(rec: UmpRecord): { content: string; type: MemoryAtom['type']; priority: number } {
  const raw = rec?.body?.text ?? ''
  return {
    content: raw.slice(0, UMP_IMPORT_TEXT_LIMIT),
    type: umpKindToAtomType(rec?.kind ?? 'semantic'),
    priority: Math.round((rec?.lifecycle?.confidence ?? 0.5) * 100),
  }
}

/** 导出全部 atoms 为 UMP 文件（分页遍历；用实际 totalPages 终止，防 >100 条截断 P0-1） */
export function exportUmpFile(outPath: string, opts: { confirmed?: boolean } = {}): { count: number; path: string; truncated?: boolean } {
  const pageSize = 100
  const records: UmpRecord[] = []
  let page = 1
  let total = 0
  for (;;) {
    const batch = memoryService.atomsPaged({ page, pageSize, confirmed: opts.confirmed, sort: 'newest' })
    total = batch.total
    for (const atom of batch.atoms) records.push(atomToUmpRecord(atom))
    if (page >= batch.totalPages) break
    page += 1
  }
  // 官方 JsonFileStore 格式：记录数组（每条自带 ump 版本字段）
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(records, null, 2) + '\n', 'utf-8')
  const truncated = records.length !== total
  if (truncated) {
    console.warn(`[ump] 导出警告：读取 ${total} 条但仅导出 ${records.length} 条（数据异常，请检查记忆索引）`)
  }
  return { count: records.length, path: outPath, truncated }
}

/** 从 UMP 文件导入到 PA（默认 pending，防投毒；--confirm 即时生效；畸形记录跳过不阻断） */
export function importUmpFile(
  inPath: string,
  opts: { confirmed?: boolean } = {},
): { imported: number; deduplicated: number; pending: number; skipped: number; path: string } {
  const raw = readFileSync(inPath, 'utf-8')
  let records: UmpRecord[] | undefined
  try {
    records = normalizeUmpFile(JSON.parse(raw))
  } catch (error) {
    throw new Error(`${inPath} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!records) throw new Error(`${inPath} 不是合法的 UMP 文件（缺少 records 数组）`)
  let imported = 0
  let deduplicated = 0
  let skipped = 0
  const total = records.length
  for (let i = 0; i < Math.min(total, UMP_IMPORT_RECORD_LIMIT); i++) {
    const rec = records[i]
    // P0-3：畸形记录（null/非对象）跳过，不整批崩溃
    if (!rec || typeof rec !== 'object' || !rec.body?.text) {
      skipped += 1
      continue
    }
    const cand = umpRecordToCandidate(rec)
    try {
      const result = memoryService.captureCandidate(cand, { workspaceSlug: rec.scope?.project }, { confirmed: opts.confirmed ?? false })
      if (result.deduplicated) deduplicated += 1
      else imported += 1
    } catch {
      // 单条导入失败不阻断（记忆功能关闭等情况计入 skipped）
      skipped += 1
    }
  }
  if (total > UMP_IMPORT_RECORD_LIMIT) {
    console.warn(`[ump] 导入警告：文件共 ${total} 条，超过上限 ${UMP_IMPORT_RECORD_LIMIT}，仅导入前 ${UMP_IMPORT_RECORD_LIMIT} 条`)
  }
  return {
    imported,
    deduplicated,
    pending: opts.confirmed ? 0 : imported,
    skipped,
    path: inPath,
  }
}
