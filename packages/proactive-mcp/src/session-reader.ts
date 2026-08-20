/**
 * Session Reader — 增量读取 Proma agent-sessions（只读，绝不改写 Proma 数据）
 *
 * 目标：daemon 高频巡检时只处理「新增的会话内容」，避免每次全量扫描。
 * - 数据源：~/.proma/agent-sessions/*.jsonl（SDKMessage 格式，扁平 JSONL）
 * - 游标：PROACTIVE_DATA_DIR/session-cursor.json，记录每个文件的 (size, mtimeMs, lines)
 * - 只处理 append 增量（size 增大）与新增文件；文件被重写/截断时重置游标重读
 * - 首次运行只读最近修改的 N 个文件（避免全量 200+ 会话一次灌入）
 *
 * 隐私：会话原文只在本机内存处理，不写日志/通知/镜像。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getConfigDir } from '@proactive-agent/core'

export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SessionDelta {
  sessionId: string
  messages: SessionMessage[]
  /** 会话文件最后修改时间（epoch ms） */
  at: number
}

export interface SessionReaderOptions {
  /** 会话目录（默认 ~/.proma/agent-sessions；env PROMA_SESSIONS_DIR 覆盖） */
  sessionsDir?: string
  /** 单轮最多处理文件数（默认 10） */
  maxSessions?: number
  /** 单会话最多提取消息数（默认 100） */
  maxMessagesPerSession?: number
  /** 单文件大小上限字节（默认 5MB，超过跳过） */
  maxFileBytes?: number
  /** 首次读取的最近文件数（默认 10） */
  initialFiles?: number
}

interface FileCursor {
  size: number
  mtimeMs: number
  lines: number
}

type CursorMap = Record<string, FileCursor>

function cursorPath(): string {
  return join(getConfigDir(), 'session-cursor.json')
}

function readCursor(): CursorMap {
  try {
    const p = cursorPath()
    if (!existsSync(p)) return {}
    const data = JSON.parse(readFileSync(p, 'utf-8')) as CursorMap
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeCursor(cursor: CursorMap): void {
  try {
    const p = cursorPath()
    mkdirSync(getConfigDir(), { recursive: true })
    writeFileSync(p, JSON.stringify(cursor, null, 2), 'utf-8')
  } catch (error) {
    console.warn('[session-reader] 写游标失败:', error instanceof Error ? error.message : error)
  }
}

/** 解析一行 SDKMessage JSON → { role, content }；非 user/assistant 或无效返回 null */
export function parseSessionLine(line: string): SessionMessage | null {
  if (!line?.trim()) return null
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  const m = msg as { type?: string; message?: { content?: unknown } }
  if (m.type !== 'user' && m.type !== 'assistant') return null
  const content = m.message?.content
  let text = ''
  if (Array.isArray(content)) {
    text = content
      .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
  } else if (typeof content === 'string') {
    text = content
  }
  const trimmed = text.trim()
  if (!trimmed) return null
  return { role: m.type as 'user' | 'assistant', content: trimmed }
}

/** 解析会话文件新增行（从 lineStart 到末尾），返回消息与总行数 */
export function parseSessionFileLines(
  filePath: string,
  lineStart: number,
  maxMessages: number,
  errors: string[],
): { messages: SessionMessage[]; totalLines: number } {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (error) {
    errors.push(`读取会话失败: ${filePath} (${error instanceof Error ? error.message : String(error)})`)
    return { messages: [], totalLines: 0 }
  }
  const lines = raw.split('\n')
  const messages: SessionMessage[] = []
  // 只处理新增行（lineStart 之后），跳过空行
  for (let i = Math.max(0, lineStart); i < lines.length; i++) {
    const parsed = parseSessionLine(lines[i] ?? '')
    if (parsed) messages.push(parsed)
    if (messages.length >= maxMessages) break
  }
  // 尾部空行不计入行数游标（JSONL 通常最后一行空）
  let totalLines = lines.length
  if (totalLines > 0 && lines[totalLines - 1]?.trim() === '') totalLines -= 1
  return { messages, totalLines }
}

/**
 * 增量读取会话（只读新增内容）。
 * 返回 delta 列表；同时更新游标（调用方无需再写）。
 */
export function readSessionDeltas(options: SessionReaderOptions = {}): { deltas: SessionDelta[]; errors: string[] } {
  const sessionsDir = options.sessionsDir ?? process.env.PROMA_SESSIONS_DIR ?? join(homedir(), '.proma', 'agent-sessions')
  const maxSessions = options.maxSessions ?? 10
  const maxMessagesPerSession = options.maxMessagesPerSession ?? 100
  const maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024
  const initialFiles = options.initialFiles ?? 10
  const errors: string[] = []
  const deltas: SessionDelta[] = []

  if (!existsSync(sessionsDir)) {
    return { deltas, errors: [] }
  }

  let files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'))
  if (files.length === 0) return { deltas, errors: [] }

  const cursor = readCursor()
  const isFirstRun = Object.keys(cursor).length === 0

  // 按修改时间降序（最近活跃优先）
  const withStat = files
    .map((f) => {
      const p = join(sessionsDir, f)
      try {
        const st = statSync(p)
        return { file: f, path: p, size: st.size, mtimeMs: st.mtimeMs }
      } catch {
        return undefined
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  // 首次运行：只读最近 initialFiles 个文件
  const candidates = isFirstRun ? withStat.slice(0, initialFiles) : withStat

  let processed = 0
  for (const c of candidates) {
    if (processed >= maxSessions) break
    const prev = cursor[c.file]
    // 超大文件跳过（防卡顿）
    if (c.size > maxFileBytes) {
      errors.push(`跳过超大会话: ${c.file} (${Math.round(c.size / 1024)}KB)`)
      continue
    }
    // 无游标：全新文件（或首次）→ 从头读
    let lineStart = 0
    if (prev && c.size === prev.size && c.mtimeMs === prev.mtimeMs) {
      continue // 无变化
    }
    if (prev && c.size >= prev.size) {
      // append 增量：从上次行数开始（若文件被重写导致行数减少，重置从头）
      lineStart = c.size === prev.size ? prev.lines : prev.lines
    }
    const { messages, totalLines } = parseSessionFileLines(c.path, lineStart, maxMessagesPerSession, errors)
    if (messages.length > 0) {
      deltas.push({ sessionId: c.file.replace(/\.jsonl$/, ''), messages, at: c.mtimeMs })
    }
    cursor[c.file] = { size: c.size, mtimeMs: c.mtimeMs, lines: totalLines }
    processed += 1
  }

  // 清理已不存在文件的游标
  const live = new Set(withStat.map((x) => x.file))
  for (const key of Object.keys(cursor)) {
    if (!live.has(key)) delete cursor[key]
  }

  writeCursor(cursor)
  return { deltas, errors }
}

/** 测试辅助：清空游标（模拟首次运行） */
export function resetSessionCursor(): void {
  const p = cursorPath()
  if (existsSync(p)) rmSync(p, { force: true })
}
