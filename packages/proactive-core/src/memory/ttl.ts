/**
 * TTL 记忆管理（M9）— 自动归档过期记忆
 *
 * 原则：
 * - 按类型默认 TTL：event 30 天 / todo_context 90 天 / fact 365 天；
 *   preference / correction / sop 永久保留（用户明确沉淀的规则不自动过期）
 * - env 覆盖：`PROACTIVE_TTL_DAYS=N` 统一覆盖非永久类型；`PROACTIVE_TTL_OFF=1` 完全禁用
 * - 归档即移除：过期 atom 写入 archive/archive.jsonl 并从 atoms 文件删除，自然不进召回
 * - 触发：recall 前懒执行（每天至多一次）+ `proactive-mcp archive` 手动触发
 * - dry-run 支持：只统计不删除（CLI 预览用）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryAtom, MemoryAtomType } from '../shared-types'
import { readAllAtoms, deleteAtom } from './store'
import { getMemoryRootDir } from '../paths'

// ===== 配置 =====

/** 各类型默认 TTL（天）；null = 永久 */
export const DEFAULT_TTL_DAYS: Record<MemoryAtomType, number | null> = {
  fact: 365,
  preference: null,
  correction: null,
  sop: null,
  todo_context: 90,
  event: 30,
}

/** 读取某类型的 TTL（天）；null = 永久 */
export function getTtlDays(type: MemoryAtomType): number | null {
  if (isTtlDisabled()) return null
  const override = Number(process.env.PROACTIVE_TTL_DAYS)
  if (Number.isFinite(override) && override > 0) return override
  return DEFAULT_TTL_DAYS[type] ?? null
}

/** TTL 是否被禁用（PROACTIVE_TTL_OFF=1/true） */
export function isTtlDisabled(): boolean {
  const v = process.env.PROACTIVE_TTL_OFF?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** atom 是否过期（相对 now；永久类型或禁用时永不过期） */
export function isExpired(atom: MemoryAtom, now: number = Date.now()): boolean {
  const days = getTtlDays(atom.type)
  if (!days || days <= 0) return false
  const base = atom.updatedAt || atom.createdAt
  return now - base > days * 24 * 3600_000
}

// ===== 归档存储 =====

function archivePath(): string {
  return join(getMemoryRootDir(), 'archive', 'archive.jsonl')
}

export interface ArchiveEntry {
  archivedAt: number
  atom: MemoryAtom
}

/** 追加一条归档记录 */
export function appendArchive(entry: ArchiveEntry): void {
  const p = archivePath()
  mkdirSync(join(getMemoryRootDir(), 'archive'), { recursive: true })
  const line = JSON.stringify(entry)
  const content = (existsSync(p) ? readFileSync(p, 'utf-8') : '') + line + '\n'
  writeFileSync(p, content, 'utf-8')
}

/** 归档记录数量 */
export function readArchivedCount(): number {
  try {
    const p = archivePath()
    if (!existsSync(p)) return 0
    return readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim()).length
  } catch {
    return 0
  }
}

// ===== 归档执行 =====

export interface ArchiveResult {
  /** 本次实际归档数 */
  archived: number
  /** 扫描发现的过期数（dryRun 时含未删除） */
  expiredCount: number
  dryRun: boolean
  at: number
}

/**
 * 归档过期 atom。
 * - dryRun=true：只统计不删除（预览）
 * - 返回 { archived, expiredCount }
 */
export function archiveExpiredAtoms(opts: { now?: number; dryRun?: boolean } = {}): ArchiveResult {
  const now = opts.now ?? Date.now()
  const dryRun = opts.dryRun ?? false
  const atoms = readAllAtoms({ includeUnconfirmed: false })
  let archived = 0
  let expiredCount = 0
  for (const atom of atoms) {
    if (!isExpired(atom, now)) continue
    expiredCount += 1
    if (!dryRun) {
      appendArchive({ archivedAt: now, atom })
      deleteAtom(atom.id)
      archived += 1
    }
  }
  if (!dryRun) writeLastArchiveAt(now)
  return { archived, expiredCount, dryRun, at: now }
}

// ===== 节流：每天至多自动归档一次 =====

function lastArchiveAtPath(): string {
  return join(getMemoryRootDir(), 'archive', '.last-archive')
}

function writeLastArchiveAt(ts: number): void {
  try {
    const p = lastArchiveAtPath()
    mkdirSync(join(getMemoryRootDir(), 'archive'), { recursive: true })
    writeFileSync(p, String(ts), 'utf-8')
  } catch {
    // 忽略：节流信息写入失败不影响主流程
  }
}

/** 今天是否已自动归档过 */
export function archivedToday(now: number = Date.now()): boolean {
  try {
    const p = lastArchiveAtPath()
    if (!existsSync(p)) return false
    const last = Number(readFileSync(p, 'utf-8'))
    if (!Number.isFinite(last)) return false
    const d = new Date(now)
    const l = new Date(last)
    return d.getFullYear() === l.getFullYear() && d.getMonth() === l.getMonth() && d.getDate() === l.getDate()
  } catch {
    return false
  }
}

/**
 * 懒归档入口：recall / MCP 启动时调用，每天至多执行一次。
 * 禁用 TTL 或已归档过 → 直接返回 0。
 */
export function maybeArchiveExpired(now: number = Date.now()): ArchiveResult {
  if (isTtlDisabled()) return { archived: 0, expiredCount: 0, dryRun: false, at: now }
  if (archivedToday(now)) return { archived: 0, expiredCount: 0, dryRun: false, at: now }
  return archiveExpiredAtoms({ now })
}
