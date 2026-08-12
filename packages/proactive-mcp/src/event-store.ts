/**
 * Event Store — 跨工具统一事件协议（0.6 感知网）
 *
 * 各工具 hooks 把生命周期/消息事件归一化写入 PROACTIVE_DATA_DIR/events/{date}.jsonl，
 * daemon 巡检时读取最近事件构造 messages 做真定时评估（完成 0.5 P0-1 遗留）。
 *
 * 事件 schema（短字段，节省空间）：
 *   { v:1, t:'start'|'msg'|'end'|'commit', tool, at, sid?, pk?, role?, text?, msg? }
 *
 * 接入工具：claude / cursor / codex / kimi / cline / continue
 * 容量：单文件按字节裁剪（保留尾部新事件），目录只留最近 7 天。
 * 容错：任何失败静默（不阻断 hook 主流程）。
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir, getProjectIdentity } from '@proactive-agent/core'

/** 写入锁文件（并发防护） */
function withEventLock<T>(dir: string, fn: () => T): T {
  const lockPath = join(dir, '.lock')
  for (let attempt = 0; attempt < 20; attempt++) {
    let fd: number | undefined
    try {
      fd = openSync(lockPath, 'wx')
      try {
        return fn()
      } finally {
        if (fd !== undefined) {
          try {
            // 释放锁（unlink 由调用方完成）
            rmSync(lockPath, { force: true })
          } catch {
            // 忽略
          }
        }
      }
    } catch (error) {
      if (fd === undefined && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        // 锁被占用：等待后重试
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        continue
      }
      // 其他错误（无权限等）：放弃锁，直接执行（append 仍安全，只可能裁剪竞争）
      return fn()
    }
  }
  // 超时：放弃锁，仅追加（裁剪竞争可接受）
  return fn()
}

export type AgentTool = 'claude' | 'cursor' | 'codex' | 'kimi' | 'cline' | 'continue'
export type AgentEventType = 'start' | 'msg' | 'end' | 'commit'

export interface AgentEvent {
  v: 1
  t: AgentEventType
  tool: AgentTool
  at: number
  sid?: string
  /** 项目身份 key（core getProjectIdentity） */
  pk?: string
  /** msg 事件：u=user / a=assistant */
  role?: 'u' | 'a'
  /** msg 事件：消息文本 */
  text?: string
  /** commit 事件：提交信息 */
  msg?: string
}

/** 单文件字节上限（约 1MB；超出裁剪旧行） */
export const EVENT_FILE_MAX_BYTES = 1_000_000
/** 事件目录保留天数 */
export const EVENT_RETENTION_DAYS = 7
/** 读取时最多返回条数 */
export const EVENT_READ_LIMIT = 200

export function eventsDir(): string {
  return join(getConfigDir(), 'events')
}

/** 本地时区日期（YYYY-MM-DD，避免 UTC 日界导致文件日期与直觉不符） */
export function localDateString(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function eventsPathFor(date: string): string {
  return join(eventsDir(), `${date}.jsonl`)
}

export function todayEventsPath(): string {
  return eventsPathFor(localDateString())
}

/** 写入一条事件（失败静默；并发安全：锁内完成裁剪+追加） */
export function writeAgentEvent(
  e: Omit<AgentEvent, 'v' | 'at'> & { at?: number },
): void {
  try {
    const dir = eventsDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // P1-6：事件文件仅当前用户可读写（含用户消息明文）
    try {
      chmodSync(dir, 0o700)
    } catch {
      // 权限设置失败不阻断
    }
    const path = todayEventsPath()
    const line = JSON.stringify({ v: 1, ...e, at: e.at ?? Date.now() })
    const isNewDay = !existsSync(path)

    // 锁内执行「裁剪 + 追加」原子单元（P0-1 并发写竞态）
    withEventLock(dir, () => {
      try {
        if (existsSync(path) && statSync(path).size > EVENT_FILE_MAX_BYTES) {
          const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
          // 临时文件 + rename 原子替换，避免 truncate 覆盖与 append 交错
          const trimmed = lines.slice(Math.ceil(lines.length * 0.3)).join('\n') + '\n'
          const tmp = `${path}.tmp`
          writeFileSync(tmp, trimmed, 'utf-8')
          renameSync(tmp, path)
        }
      } catch {
        // 裁剪失败不阻断写入
      }
      appendFileSync(path, line + '\n', 'utf-8')
      try {
        chmodSync(path, 0o600)
      } catch {
        // 权限设置失败不阻断
      }
    })

    // 仅在新日期文件创建时清理旧事件（避免每条消息全目录扫描）
    if (isNewDay) cleanupOldEvents()
  } catch {
    // 事件写入失败静默（hook 主流程不受影响）
  }
}

/** 清理超过保留天数的旧事件文件（失败静默；本地时区日界） */
export function cleanupOldEvents(): void {
  try {
    const dir = eventsDir()
    if (!existsSync(dir)) return
    const cutoff = Date.now() - EVENT_RETENTION_DAYS * 86_400_000
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const date = name.slice(0, 10)
      const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/) // 本地时区
      if (!m) continue
      const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (!Number.isNaN(ts) && ts < cutoff) {
        rmSync(join(dir, name), { force: true })
      }
    }
  } catch {
    // 清理失败静默
  }
}

/** 读取最近事件（今天 + 昨天文件，按时间升序返回最近 limit 条） */
export function readRecentAgentEvents(limit = EVENT_READ_LIMIT): AgentEvent[] {
  try {
    const dir = eventsDir()
    if (!existsSync(dir)) return []
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .slice(-3) // 只读最近三天
    const events: AgentEvent[] = []
    for (const name of files) {
      try {
        for (const line of readFileSync(join(dir, name), 'utf-8').split('\n').filter(Boolean)) {
          try {
            const e = JSON.parse(line) as AgentEvent
            if (e && e.v === 1 && e.t && e.tool && typeof e.at === 'number') events.push(e)
          } catch {
            // 跳过损坏行
          }
        }
      } catch {
        // 跳过损坏文件
      }
    }
    events.sort((a, b) => a.at - b.at)
    return events.slice(-limit)
  } catch {
    return []
  }
}

/** 把事件消息转成 evaluateNow 的 messages（只取 msg 事件文本，最近 20 条） */
export function eventsToMessages(events: AgentEvent[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return events
    .filter((e) => e.t === 'msg' && e.text && typeof e.text === 'string')
    .map((e) => ({ role: e.role === 'a' ? ('assistant' as const) : ('user' as const), content: e.text as string }))
    .slice(-20)
}

/** 便捷：写入消息事件（hooks 调用） */
export function recordMessage(tool: AgentTool, role: 'u' | 'a', text: string, opts: { sid?: string; pk?: string } = {}): void {
  if (!text?.trim()) return
  writeAgentEvent({ t: 'msg', tool, role, text: text.trim().slice(0, 4000), sid: opts.sid, pk: opts.pk })
}

/** 便捷：写入会话生命周期事件 */
export function recordLifecycle(tool: AgentTool, t: 'start' | 'end', opts: { sid?: string; pk?: string } = {}): void {
  writeAgentEvent({ t, tool, sid: opts.sid, pk: opts.pk })
}

/** 便捷：当前项目身份 key（写事件时带上下文） */
export function currentProjectKey(): string | undefined {
  try {
    return getProjectIdentity().key
  } catch {
    return undefined
  }
}
