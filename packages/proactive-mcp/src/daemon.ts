/**
 * Daemon — ProactiveAgent 守护进程（0.5「主动出口」）
 *
 * 常驻后台，巡检建议并通过桌面通知主动开口：
 * - 单实例锁：PROACTIVE_DATA_DIR/daemon.json（pid + 状态），进程存活时拒绝二次启动
 * - 内置主动中心：复用 startTodayServer（/api/today、/api/evaluate、面板）
 * - 定时巡检循环：默认每 60 分钟（PROACTIVE_DAEMON_INTERVAL_MIN 覆盖）：
 *   DND 时段跳过通知但保留建议（不吞掉）；每次最多通知 1 条最新建议（克制信条延续）
 * - 通知去重：notifiedIds 记录已通知建议，避免同一条建议反复打扰；通知失败不标记（下轮重试）
 * - 优雅关闭：SIGTERM/SIGINT → 清理 pid → 退出
 *
 * ⚠️ 0.5 巡检语义（P0-1 修复）：建议生成来源是 hooks（UserPromptSubmit/Stop）与宿主
 * push（/api/evaluate）——引擎 evaluateNow 在无 messages 时直接返回空（core service.ts:113），
 * 因此 daemon 不空转调用 evaluateNow，只负责「开口通道」：把已生成的 suggested 建议主动通知用户。
 * 真·定时评估（基于跨工具会话读取）随 0.6 感知网接入。
 *
 * 数据目录由 PROACTIVE_DATA_DIR（或 PROMA_MEMORY_DIR）决定，与引擎一致。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { suggestService, memoryService, getConfigDir } from '@proactive-agent/core'
import { startTodayServer } from './today'
import { notifier, createNotifier, type Notifier } from './notifier'
import { readRecentAgentEvents, eventsToMessages, type AgentEvent } from './event-store'

export const DAEMON_INTERVAL_DEFAULT_MIN = 60
export const NOTIFIED_HISTORY_LIMIT = 200
export const DAILY_NOTIFY_LIMIT_DEFAULT = 6
export const COOLDOWN_MIN_DEFAULT = 15

export interface DaemonState {
  version: 1
  pid: number
  startedAt: number
  lastRunAt?: number
  lastNotifyAt?: number
  notifiedIds: string[]
  /** 0.8：当日已通知计数（跨天自动重置） */
  dailyNotified: number
  dailyNotifiedDate: string
}

function statePath(): string {
  return join(getConfigDir(), 'daemon.json')
}

function readState(): DaemonState | undefined {
  try {
    const p = statePath()
    if (!existsSync(p)) return undefined
    const data = JSON.parse(readFileSync(p, 'utf-8')) as DaemonState
    if (typeof data.pid !== 'number' || !Array.isArray(data.notifiedIds)) {
      backupCorruptState()
      return undefined
    }
    return data
  } catch {
    backupCorruptState()
    return undefined
  }
}

function writeState(state: DaemonState): void {
  try {
    const p = statePath()
    mkdirSync(getConfigDir(), { recursive: true })
    writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8')
  } catch (error) {
    console.warn('[daemon] 写入状态失败:', error instanceof Error ? error.message : error)
  }
}

/** 读取状态失败（损坏）时保留损坏文件备份，避免静默丢失已通知记录 */
function backupCorruptState(): void {
  try {
    const p = statePath()
    if (!existsSync(p)) return
    const bak = `${p}.bak`
    if (!existsSync(bak)) {
      writeFileSync(bak, readFileSync(p, 'utf-8'), 'utf-8')
    }
  } catch {
    // 备份失败不阻断
  }
}

/** 进程是否存活（pid 存在且可信号探测；非正 pid 一律视为不存活——kill(-1) 在 POSIX 会探测所有进程） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 单实例锁：已运行则返回 false（不重复启动）
 * 陈旧 pid（进程已死）自动覆盖，保证崩溃后能重启。
 * 写入后重读校验（pid 仍为自己），捕捉并发 TOCTOU 覆盖。
 * 注：用统一结构（非判别联合）避免无 strict 构建下 narrowing 失效。
 */
export function acquireDaemonLock(): { ok: boolean; state?: DaemonState; reason?: string } {
  const existing = readState()
  if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
    return { ok: false, reason: `daemon 已在运行（pid=${existing.pid}，启动于 ${new Date(existing.startedAt).toLocaleString()}）` }
  }
  const state: DaemonState = {
    version: 1,
    pid: process.pid,
    startedAt: Date.now(),
    notifiedIds: existing?.notifiedIds ?? [],
    dailyNotified: existing?.dailyNotified ?? 0,
    dailyNotifiedDate: existing?.dailyNotifiedDate ?? '',
  }
  writeState(state)
  const verify = readState()
  if (verify && verify.pid !== process.pid) {
    return { ok: false, reason: '锁竞争：另一实例刚刚启动，请稍后重试' }
  }
  return { ok: true, state }
}

/** 释放锁：仅当锁属于当前进程才删除（防止 A 退出误删 B 的锁，P1-2） */
export function releaseDaemonLock(): void {
  try {
    const state = readState()
    if (state && state.pid === process.pid) {
      rmSync(statePath(), { force: true })
    }
  } catch {
    // 忽略清理失败
  }
}

/** 计算下一次评估的间隔毫秒（env 可覆盖，1~1440 分钟） */
export function daemonIntervalMs(): number {
  const raw = Number(process.env.PROACTIVE_DAEMON_INTERVAL_MIN ?? DAEMON_INTERVAL_DEFAULT_MIN)
  if (!Number.isFinite(raw) || raw < 1) return DAEMON_INTERVAL_DEFAULT_MIN * 60_000
  return Math.min(1440, Math.max(1, Math.floor(raw))) * 60_000
}

/** 本地日期（YYYY-MM-DD） */
export function todayDateString(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 0.8：画像驱动的打扰系数——画像含「减少打扰」类**全局**表达时降为 0.5
 * （每日上限减半 + 冷却翻倍）。词表设计约束（子代理审查 P1-1/2/3 后修正）：
 * - 只信任「全局/频率/时段」语境，避免单项提醒（如「别提醒我收快递」）误伤全局
 * - 技术词（--quiet / quiet 模式 / 静默安装）不命中；组合形态（quiet mode / 静默模式）才命中
 * - 补常见漏报（勿扰 / 免打扰 / dnd / 不想被打扰）
 */
export function personaDisturbCoefficient(): number {
  try {
    const raw = memoryService.personaRaw()
    if (!raw) return 1
    const text = raw.toLowerCase()
    const quiet = [
      // 全局频率/时段（中文；含「我」的全局语气，排除单事项提醒）
      '减少打扰', '降低打扰', '不想被打扰', '不喜欢被打扰', '少打扰',
      '不要打扰我', '别打扰我', '不要打扰', '别打扰',
      '少提醒', '别总是提醒', '不要总是提醒', '减少提醒', '降低提醒频率',
      '勿扰', '免打扰', '安静模式', '静默模式',
      // 全局（英文/缩写）
      'do not disturb', "don't disturb", 'dnd',
      'quiet mode', 'quiet hours', 'quiet time', 'no notifications', 'no push',
    ]
    if (quiet.some((k) => text.includes(k))) return 0.5
  } catch {
    // 画像读取失败按 1.0
  }
  return 1
}

/** 每日通知上限（env 可覆盖；画像「少打扰」时减半） */
export function dailyNotifyLimit(coeff = personaDisturbCoefficient()): number {
  const raw = Number(process.env.PROACTIVE_DAEMON_DAILY_LIMIT ?? DAILY_NOTIFY_LIMIT_DEFAULT)
  const base = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DAILY_NOTIFY_LIMIT_DEFAULT
  return Math.max(1, Math.floor(base * coeff))
}

/** 通知冷却窗口毫秒（env 可覆盖；画像「少打扰」时翻倍——档位：coeff 0.5 → ×2，1.0 → ×1） */
export function cooldownMs(coeff = personaDisturbCoefficient()): number {
  const raw = Number(process.env.PROACTIVE_DAEMON_COOLDOWN_MIN ?? COOLDOWN_MIN_DEFAULT)
  const base = Number.isFinite(raw) && raw >= 0 ? raw : COOLDOWN_MIN_DEFAULT
  // 显式乘法语义：1/coeff 为倍率（0.5 → 2 倍），避免除法随档位漂移（P2-3）
  const multiplier = 1 / Math.max(0.1, coeff)
  return Math.round(base * multiplier * 60_000)
}

/** 当日已通知数（跨天自动清零；接受宽松状态以兼容 doctor 读取；字符串防御 P2-1） */
export function dailyNotifiedCount(state: Pick<DaemonState, 'dailyNotified' | 'dailyNotifiedDate'>): number {
  if (state.dailyNotifiedDate !== todayDateString()) return 0
  const n = Number(state.dailyNotified)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 通知成功后累加当日计数（跨天重置；字符串防御 P2-1） */
export function bumpDailyNotified(state: DaemonState): void {
  const today = todayDateString()
  if (state.dailyNotifiedDate !== today) {
    state.dailyNotifiedDate = today
    state.dailyNotified = 0
  }
  const current = Number(state.dailyNotified)
  state.dailyNotified = (Number.isFinite(current) && current > 0 ? Math.floor(current) : 0) + 1
}

const KIND_LABEL: Record<string, string> = {
  correction: '纠正建议',
  followup: '跟进建议',
  automation: '自动化建议',
  skill: '技能建议',
  todo: '待办建议',
}

/** 找一条值得通知的建议：suggested 且未通知过，取最新一条 */
export function pickNotifiable(state: DaemonState): { id: string; kind: string; title: string; reason: string } | undefined {
  const candidates = suggestService.listSuggestionsForUI('suggested')
  const notified = new Set(state.notifiedIds)
  const fresh = candidates.filter((s) => !notified.has(s.id))
  if (fresh.length === 0) return undefined
  // 取最新一条（克制信条：单次最多 1 条）
  const top = fresh[0]
  return { id: top.id, kind: top.kind, title: top.title, reason: top.reason }
}

/** 记录已通知建议（保留最近 N 条防膨胀） */
export function markNotified(state: DaemonState, id: string): void {
  if (!state.notifiedIds.includes(id)) state.notifiedIds.push(id)
  if (state.notifiedIds.length > NOTIFIED_HISTORY_LIMIT) {
    state.notifiedIds = state.notifiedIds.slice(-NOTIFIED_HISTORY_LIMIT)
  }
  writeState(state)
}

export interface DaemonRunOptions {
  port?: number
  notifierOverride?: Notifier
  /** 单次评估循环，测试用 */
  runOnce?: boolean
}

/**
 * 执行一轮巡检 + 通知（0.6：真定时评估，完成 P0-1 遗留）：
 * - 读取最近跨工具事件（events/）构造 messages → evaluateNow(trigger:'timer')
 * - 有事件则真评估；无事件（新装/无 hooks）则纯巡检 suggested 池（0.5 兜底）
 * - DND 时段跳过通知但**不标记**（建议保留，DND 结束后下一轮弹出，不吞建议）
 * - 无新建议不通知（该沉默时沉默）
 * - 通知失败不标记（下轮重试；防重复打扰只在成功发送后才生效）
 */
export async function runEvaluationCycle(
  state: DaemonState,
  options: { port: number; notifierImpl: Notifier },
): Promise<{ notified: boolean; evaluated: boolean }> {
  state.lastRunAt = Date.now()
  // 0.6.1：事件按 pk 分组评估——各项目会话只产生各自项目的建议（不串味）
  try {
    const events = readRecentAgentEvents(60)
    const withPk = events.filter((e) => !!e.pk)
    const withoutPk = events.filter((e) => !e.pk)
    // 有 pk 的事件按项目分组，每组分别评估并写入对应项目层
    const groups = new Map<string, AgentEvent[]>()
    for (const e of withPk) {
      const pk = e.pk as string
      const list = groups.get(pk)
      if (list) list.push(e)
      else groups.set(pk, [e])
    }
    for (const [pk, group] of groups) {
      const messages = eventsToMessages(group)
      if (messages.length === 0) continue
      const lastMsg = [...group].reverse().find((e) => e.t === 'msg')
      await suggestService.evaluateNow({ trigger: 'timer', messages, sessionId: lastMsg?.sid, projectHint: pk })
    }
    // 无 pk 的事件（老 hooks/未知来源）：保持原行为（daemon 当前层评估）
    const messages = eventsToMessages(withoutPk)
    if (messages.length > 0) {
      const lastMsg = [...withoutPk].reverse().find((e) => e.t === 'msg')
      await suggestService.evaluateNow({ trigger: 'timer', messages, sessionId: lastMsg?.sid })
    }
  } catch (error) {
    console.warn('[daemon] 事件评估失败（降级为纯巡检）:', error instanceof Error ? error.message : error)
  }
  const candidate = pickNotifiable(state)
  if (!candidate) {
    writeState(state)
    return { notified: false, evaluated: true }
  }
  // DND：不打扰，但保留建议待通知（不写 notifiedIds）
  if (suggestService.dndActive()) {
    console.error(`[daemon] DND 时段，跳过通知（保留待通知）：${candidate.title}`)
    writeState(state)
    return { notified: false, evaluated: true }
  }
  // 0.8：冷却窗口（避免短时间内连弹；画像「少打扰」时翻倍；时钟回拨钳制 P2-4）
  const coeff = personaDisturbCoefficient()
  const cool = cooldownMs(coeff)
  const sinceLast = state.lastNotifyAt ? Date.now() - state.lastNotifyAt : Infinity
  if (sinceLast >= 0 && sinceLast < cool) {
    console.error(`[daemon] 冷却中（距上次通知 ${Math.round(sinceLast / 1000)}s < ${Math.round(cool / 1000)}s），跳过（建议保留）`)
    writeState(state)
    return { notified: false, evaluated: true }
  }
  // 0.8：每日上限（达上限当日不再打扰；建议保留不吞，次日继续）
  const limit = dailyNotifyLimit(coeff)
  const used = dailyNotifiedCount(state)
  if (used >= limit) {
    console.error(`[daemon] 今日已通知 ${used}/${limit} 条，达上限，跳过（建议保留至明日）`)
    writeState(state)
    return { notified: false, evaluated: true }
  }
  const res = await options.notifierImpl.show({
    title: `主动建议 · ${KIND_LABEL[candidate.kind] ?? candidate.kind}`,
    body: candidate.title,
    url: `http://127.0.0.1:${options.port}/today`,
  })
  if (!res.ok) {
    // 通知失败：不标记，下一轮重试（P2-3）
    console.error(`[daemon] 通知发送失败（下轮重试）: ${res.error ?? 'unknown'}`)
    writeState(state)
    return { notified: false, evaluated: true }
  }
  state.lastNotifyAt = Date.now()
  bumpDailyNotified(state)
  markNotified(state, candidate.id)
  console.error(`[daemon] 已通知建议: ${candidate.title}`)
  return { notified: true, evaluated: true }
}

/** 常驻主循环（前台运行；自启用 launchd/systemd 托管） */
export async function runDaemon(options: DaemonRunOptions = {}): Promise<void> {
  const lock = acquireDaemonLock()
  if (!lock.ok || !lock.state) {
    console.error(`[daemon] ${lock.reason ?? '未知错误'}`)
    process.exit(1)
  }
  const state = lock.state
  const port = options.port ?? Number(process.env.PROACTIVE_TODAY_PORT ?? 8737)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[daemon] 无效端口: ${port}（需 1-65535 的整数）`)
    releaseDaemonLock()
    process.exit(1)
  }
  const notifierImpl = options.notifierOverride ?? notifier

  // 主动中心控制面（/api/today、/api/evaluate、面板）
  startTodayServer(port)

  console.error(`[daemon] ProactiveAgent daemon 已启动（pid=${process.pid}，评估间隔 ${Math.round(daemonIntervalMs() / 60000)} 分钟，面板 http://127.0.0.1:${port}/today）`)

  // 优雅关闭：清理 pid 锁再退出
  const shutdown = (signal: NodeJS.Signals) => {
    console.error(`[daemon] 收到 ${signal}，正在关闭`)
    releaseDaemonLock()
    process.exit(0)
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  const loop = async (): Promise<void> => {
    await runEvaluationCycle(state, { port, notifierImpl })
    if (options.runOnce) return
    setTimeout(loop, daemonIntervalMs()).unref()
  }
  await loop()
}
