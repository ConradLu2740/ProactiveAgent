/**
 * Suggestion Service — 主动建议编排层
 *
 * 对外稳定 API，供 orchestrator 钩子、IPC、UI 使用。
 * 设计要点：
 * - 会话结束钩子：evaluateSessionSuggestions(messages, sessionId) 生成建议并持久化
 * - 去重来源：automation 标题 + pending corrections + 已有建议记录
 * - 频率学习：recordFeedback 驱动类型权重
 * - 误报控制：threshold + 预算 + 同会话去重 + 用户永久屏蔽
 */

import type { SuggestionsIndex } from './types'
import {
  persistSuggestion,
  recordFeedback,
  listSuggestions,
  getSuggestion,
  getSuggestionAcrossLayers,
  suggestionsEnabled,
  setSuggestionsEnabled,
  suggestionStats,
  isTypeSilenced,
  typeWeights,
  readSuggestionsIndex,
  deleteSuggestion,
  clearSuggestions,
  getHighIgnoreDuplicateKeys,
  getDndConfig,
  setDndConfig,
  isInDnd,
  getAnalysisState,
  setAnalysisState,
} from './feedback'
import { evaluateSuggestions, DEFAULT_SUGGEST_OPTIONS } from './engine'
import { getAutomationTitles, notifySuggestionsChangedProvider } from '../provider'
import { executeSuggestionAction, type ActionResult } from './actions'
import { corrections as memoryCorrections, recentAtoms, proposeCorrection, confirmCorrection } from '../memory/service'
import type {
  SuggestionRecord,
  SuggestionStats,
  SuggestionFeedback,
} from '../shared-types'

// ===== 基础状态 =====

export function suggestionsEnabledState(): boolean {
  return suggestionsEnabled()
}

export function setEnabledState(enabled: boolean): void {
  setSuggestionsEnabled(enabled)
}

// ===== 免打扰时段（DND） =====

/** 读取免打扰配置 */
export function getDnd(): ReturnType<typeof getDndConfig> {
  return getDndConfig()
}

/** 更新免打扰配置 */
export function updateDnd(cfg: Parameters<typeof setDndConfig>[0]): void {
  setDndConfig(cfg)
}

/** 当前是否处于免打扰时段（供 IPC/设置页展示） */
export function dndActive(now?: number): boolean {
  return isInDnd(now)
}

// ===== 统一评估入口（R1：主动推送闭环） =====

/** 评估触发点：会话开始/中/结束、手动、定时 */
export type EvaluateNowTrigger = 'session_start' | 'session_mid' | 'session_end' | 'manual' | 'timer'

export interface EvaluateNowContext {
  trigger: EvaluateNowTrigger
  sessionId?: string
  /** 最近对话消息（session_mid/session_end/manual 用） */
  messages?: Array<{ role: string; content: string }>
  /** 项目键提示（宿主注入，用于 scope 路由） */
  projectHint?: string
  /** 会话中推送默认降噪：弱信号不打扰 */
  suppressIfQuiet?: boolean
}

/**
 * 统一建议评估入口（R1）。
 * 支持 5 种触发点，内部按 trigger 应用不同抑制策略：
 * - session_start：只推存量待处理建议摘要（today-push 逻辑内聚进 core），不产生新建议
 * - session_mid：会话中推送，限 1 条 + 强信号门槛（correction/automation，raw ≥ 0.8）
 * - session_end：等同旧 evaluateSessionSuggestions（兼容转发）
 * - manual：等同 suggest_now
 * - timer：Today 面板轮询/定时触发，同 session_mid 抑制
 */
export async function evaluateNow(ctx: EvaluateNowContext): Promise<SuggestionRecord[]> {
  if (!suggestionsEnabled()) return []
  // 免打扰时段：不产生新建议（避免横幅打扰）。Proactive Today 列表不受影响。
  if (isInDnd()) return []

  try {
    // session_start：不评估新建议，只返回存量待处理（宿主注入会话上下文用）
    if (ctx.trigger === 'session_start') {
      return listSuggestions('suggested').slice(0, 5)
    }

    const messages = ctx.messages ?? []
    if (messages.length === 0) return []

    const existing = listSuggestions('suggested')
    const existingForSession = existing.filter((r) => r.sessionId === ctx.sessionId)
    // 同会话已达预算则不再建议
    if (existingForSession.length >= DEFAULT_SUGGEST_OPTIONS.maxPerSession) return []

    const input: Parameters<typeof evaluateSuggestions>[0] = {
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content })),
      sessionId: ctx.sessionId,
      existingSessionSuggestions: existingForSession,
      existingAutomationTitles: loadAutomationTitles(),
      existingCorrectionRules: loadCorrectionRules(),
      sopCandidateCount: loadSopCandidateCount(),
    }

    const isMid = ctx.trigger === 'session_mid' || ctx.trigger === 'timer'
    // 会话中/定时：单次限 1 条 + 更高置信门槛
    const opts: typeof DEFAULT_SUGGEST_OPTIONS = isMid
      ? { ...DEFAULT_SUGGEST_OPTIONS, maxPerEvaluation: 1, threshold: 0.8 }
      : DEFAULT_SUGGEST_OPTIONS

    const result = evaluateSuggestions(input, readSuggestionsIndex(), opts)
    if (result.candidates.length === 0) return []

    // 类型已连续忽略自动静默 → 跳过
    const candidate = result.candidates[0]
    if (!candidate) return []
    if (isTypeSilenced(candidate.kind)) return []

    // 会话中/定时：只推 correction / automation 强信号（避免 followup/todo 打断工作流）
    if (isMid && ctx.suppressIfQuiet !== false) {
      if (candidate.kind !== 'correction' && candidate.kind !== 'automation') return []
    }

    const record = persistSuggestion(candidate, ctx.sessionId)
    // 新建议生成后广播事件，让当前会话的 SuggestionBanner 实时刷新（不再等重新挂载）
    notifySuggestionsChanged()
    return [record]
  } catch (error) {
    console.warn('[Suggestion] evaluateNow 评估失败:', error instanceof Error ? error.message : error)
    return []
  }
}

// ===== 会话结束评估（orchestrator 钩子入口，兼容旧接口） =====

/**
 * 会话结束后评估是否产生建议（内部转发 evaluateNow，保持旧调用方兼容）。
 */
export async function evaluateSessionSuggestions(
  messages: Array<{ role: string; content: string }>,
  ctx: { sessionId?: string } = {},
): Promise<SuggestionRecord[]> {
  return evaluateNow({ trigger: 'session_end', messages, sessionId: ctx.sessionId })
}

// ===== 建议操作（IPC / UI） =====

export function listSuggestionsForUI(status?: 'suggested' | 'accepted' | 'ignored' | 'never'): SuggestionRecord[] {
  return listSuggestions(status)
}

export function getSuggestionById(id: string): SuggestionRecord | undefined {
  return getSuggestion(id)
}

/**
 * 用户反馈处理。
 * accepted 时：对建议动作统一走 Action Executor（M6：接受即执行）——
 * - memory_correction：写入纠正候选 + 确认（保持现有闭环）
 * - open_automation_create / open_todo_create：宿主注入执行器则真实创建，否则降级指令
 * 返回 { ok, result? }，result 为动作执行结果（供 MCP suggest_accept 返回给用户）。
 */
export async function handleSuggestionFeedback(
  id: string,
  feedback: SuggestionFeedback,
  ctx: { host?: string } = {},
): Promise<{ ok: boolean; error?: string; result?: ActionResult }> {
  if (!suggestionsEnabled()) return { ok: false, error: '主动建议已关闭' }
  // 🔴#3：跨层查找（当前层优先，global 兜底），反馈写回所在层
  const across = getSuggestionAcrossLayers(id)
  if (!across) return { ok: false, error: '建议不存在' }
  const { record, layer } = across

  let result: ActionResult | undefined

  // 接受 correction 动作：直接创建并立即生效（P0 修复：不再两步确认）。
  // 用户点"接受"= 明确认可这条规则，直接写入并回流 persona。
  if (feedback === 'accepted' && record.action.type === 'memory_correction') {
    try {
      const correction = proposeCorrection({ raw: record.action.raw, rule: record.action.rule, sessionId: record.sessionId })
      if (correction?.id) {
        confirmCorrection(correction.id)
        // 闭环确认：correction atom 已写入，persona 异步刷新已触发（confirmCorrection 内部 ensurePersona）
        console.log('[Suggestion] 反馈回流闭环: correction 建议已接受 → atom 写入 + persona 刷新')
      }
      result = { ok: true, executed: true, message: '纠正规则已写入长期记忆（包含用户画像回流）。' }
    } catch (error) {
      console.warn('[Suggestion] 写入纠正候选失败:', error instanceof Error ? error.message : error)
      result = { ok: false, executed: false, message: `写入纠正规则失败：${error instanceof Error ? error.message : String(error)}` }
    }
  } else if (feedback === 'accepted') {
    // M6：automation/todo 等动作 → Action Executor（宿主注入则真实创建，否则降级指令）
    result = await executeSuggestionAction(record.action, ctx)
  }

  // 反馈回流补充：高频 ignore/never 的 duplicateKey 将抑制对应记忆场景热度（供 P0-2 scene 计算读取）
  // 此处只需记录反馈（recordFeedback 已更新状态与类型权重），不需要额外写入。
  recordFeedback(id, feedback, layer)
  return { ok: true, result }
}

/**
 * 按类型分组的候选池（Proactive Today 多候选展示）。
 *
 * 借鉴 ProactiveAgent P8 pred@k：给用户“选择权”比单一打断更友好。
 * 会话内引擎保持 maxPerEvaluation=1（不打扰），这里把待展示建议按类型分组，
 * 便于用户在 Today 页扫读并选择接受哪一类。
 */
export function groupSuggestionsByKind(records: SuggestionRecord[]): Array<{
  kind: SuggestionRecord['kind']
  items: SuggestionRecord[]
}> {
  const order: SuggestionRecord['kind'][] = ['correction', 'followup', 'automation', 'skill', 'todo']
  const groups = new Map<SuggestionRecord['kind'], SuggestionRecord[]>()
  for (const r of records) {
    const list = groups.get(r.kind) ?? []
    list.push(r)
    groups.set(r.kind, list)
  }
  const result: Array<{ kind: SuggestionRecord['kind']; items: SuggestionRecord[] }> = []
  for (const kind of order) {
    const items = groups.get(kind)
    if (items && items.length > 0) result.push({ kind, items })
  }
  return result
}

/** 查询统计（UI） */
export function getSuggestionStats(): SuggestionStats {
  return suggestionStats()
}

/** 删除一条建议（用户控制） */
export function removeSuggestion(id: string): boolean {
  return deleteSuggestion(id)
}

/** 清空全部建议记录（用户控制） */
export function clearAllSuggestions(): void {
  clearSuggestions()
  notifySuggestionsChanged()
}

/** 当前类型权重（调试/UI） */
export function getTypeWeights() {
  return typeWeights()
}

/**
 * 反馈回流：被用户高频忽略/屏蔽的建议去重键。
 * 供记忆场景热度（scene.ts）抑制对应场景，避免"越关注越打扰"。
 */
export function getSuppressedSuggestionKeys(): string[] {
  return getHighIgnoreDuplicateKeys(2)
}

// ===== 工作模式分析（Phase B 方向 2） =====

export interface SuggestionAnalysisRunResult {
  status: 'succeeded' | 'empty' | 'unavailable' | 'failed'
  added: number
  message?: string
}

let analysisInFlight: Promise<SuggestionAnalysisRunResult> | null = null

/**
 * 运行工作模式分析并记录可供 UI 展示的状态。
 * 同一时刻复用一次在途调用，既避免重复收费，也避免用户看到相互矛盾的结果。
 */
export async function runAnalysisAndPersistDetailed(): Promise<SuggestionAnalysisRunResult> {
  if (analysisInFlight) return analysisInFlight
  const startedAt = Date.now()
  setAnalysisState({ status: 'running', startedAt })
  const run = (async () => {
    try {
      if (!suggestionsEnabled()) {
        const result = { status: 'unavailable' as const, added: 0, message: '主动建议已关闭' }
        setAnalysisState({ ...result, startedAt, completedAt: Date.now() })
        return result
      }
      const { runWorkPatternAnalysisDetailed } = await import('./analyst')
      const analysis = await runWorkPatternAnalysisDetailed()
      if (analysis.status === 'unavailable' || analysis.status === 'failed') {
        const result = { status: analysis.status, added: 0, message: analysis.error }
        setAnalysisState({ ...result, startedAt, completedAt: Date.now() })
        return result
      }
      if (analysis.status === 'empty') {
        const result = { status: 'empty' as const, added: 0, message: analysis.error }
        setAnalysisState({ ...result, startedAt, completedAt: Date.now() })
        return result
      }

      // 去重：已有 suggested/never 的 duplicateKey 跳过
      const existing = listSuggestions()
      const existingKeys = new Set(existing.map((r) => r.duplicateKey))
      let added = 0
      for (const candidate of analysis.candidates) {
        if (existingKeys.has(candidate.duplicateKey)) continue
        persistSuggestion(candidate, undefined)
        existingKeys.add(candidate.duplicateKey)
        added += 1
      }
      if (added > 0) notifySuggestionsChanged()
      const result = added > 0
        ? { status: 'succeeded' as const, added }
        : { status: 'empty' as const, added: 0, message: '没有发现新的可沉淀模式' }
      setAnalysisState({ ...result, startedAt, completedAt: Date.now() })
      console.log(`[Analyst] 工作模式分析完成: ${analysis.candidates.length} 候选, 新增 ${added} 条建议`)
      return result
    } catch (error) {
      const result = { status: 'failed' as const, added: 0, message: '分析服务暂时不可用，请稍后重试' }
      setAnalysisState({ ...result, startedAt, completedAt: Date.now() })
      console.warn('[Analyst] 分析持久化失败:', error instanceof Error ? error.message : error)
      return result
    }
  })()
  analysisInFlight = run
  void run.then(
    () => { if (analysisInFlight === run) analysisInFlight = null },
    () => { if (analysisInFlight === run) analysisInFlight = null },
  )
  return run
}

/** 兼容既有 Automation / Agent 工具，只返回新增建议数量。 */
export async function runAnalysisAndPersist(): Promise<number> {
  return (await runAnalysisAndPersistDetailed()).added
}

/** 最近一次分析结果，供主动中心在重新打开后仍可展示。 */
export function getSuggestionAnalysisState() {
  return getAnalysisState()
}

// ===== 内部：加载去重来源 =====

function loadAutomationTitles(): string[] {
  try {
    return getAutomationTitles()
  } catch {
    return []
  }
}

function loadCorrectionRules(): string[] {
  try {
    return memoryCorrections('pending').map((c) => c.rule)
  } catch {
    return []
  }
}

function loadSopCandidateCount(): number {
  try {
    return recentAtoms(100).filter((a) => a.type === 'sop').length
  } catch {
    return 0
  }
}

/**
 * 广播建议变更事件（main → renderer）。
 * 让当前会话的 SuggestionBanner 实时刷新（P1 修复：不再等组件重新挂载）。
 * 通过 provider 注入：Electron 在 ipc.ts 注册真实广播，外部宿主不注册则 no-op。
 * 注：不再直接 require('@proma/shared')——避免 MIT 发布的 bundle 内联 AGPL 实现（license 审查修复）。
 */
function notifySuggestionsChanged(): void {
  notifySuggestionsChangedProvider()
}

/** 公开索引读取（供 engine 使用，避免循环依赖） */
export type { SuggestionsIndex }
