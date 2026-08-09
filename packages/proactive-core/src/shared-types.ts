/**
 * Shared types for @proactive-agent/core
 *
 * 这些类型原本来自 Proma 的 @proma/shared 包（AGPL-3.0）。独立发布为
 * @proactive-agent/core 时复制为本地定义，避免对外依赖 AGPL 实现。
 * 接口定义本身与上游同构，方便 Electron dogfooding 时类型无感切换。
 */

// ===== Memory（长期记忆）类型 =====

/** 记忆条目类型 */
export type MemoryAtomType =
  | 'fact'
  | 'preference'
  | 'correction'
  | 'sop'
  | 'todo_context'
  | 'event'

/** L1 原子记忆条目（一行 JSONL） */
export interface MemoryAtom {
  id: string
  content: string
  type: MemoryAtomType
  priority: number
  sessionId?: string
  workspaceSlug?: string
  /** 0.3.0 新增：数据层来源（project/global），跨层合并后用于标注与过滤 */
  scope?: 'project' | 'global'
  createdAt: number
  updatedAt: number
  fingerprint?: string
  confirmed: boolean
  metadata?: Record<string, unknown>
}

/** L2 场景块元数据 */
export interface SceneBlock {
  id: string
  title: string
  atomIds: string[]
  heat: number
  createdAt: number
  updatedAt: number
}

/** L3 用户画像 */
export interface PersonaProfile {
  name?: string
  summary?: string
  preferences: string[]
  interactionRules: string[]
  evolution: string[]
  updatedAt: number
}

/** 行为纠正候选（需审批） */
export interface MemoryCorrection {
  id: string
  raw: string
  rule: string
  sessionId?: string
  createdAt: number
  status: 'pending' | 'active' | 'rejected' | 'superseded'
}

/** 记忆统计 */
export interface MemoryStats {
  atomCount: number
  byType: Record<MemoryAtomType, number>
  sceneCount: number
  pendingCorrections: number
  pendingAtoms: number
  personaExists: boolean
  rootDir: string
  lastExtractionAt: number
  /** M9：已归档记忆数（TTL 管理） */
  archivedCount: number
}

/** 记忆检索请求 */
export interface MemorySearchRequest {
  query: string
  limit?: number
  type?: MemoryAtomType
  includeUnconfirmed?: boolean
  /** 0.3.0 新增：读取层（默认 auto=项目+全局合并） */
  scope?: 'project' | 'global' | 'auto'
}

/** 记忆检索命中 */
export interface MemorySearchHit {
  atom: MemoryAtom
  score: number
  rawScore?: number
  matchedTerms: string[]
  /** 0.3.0 新增：来源层 */
  scope?: 'project' | 'global'
}

/** 记忆检索结果 */
export interface MemorySearchResult {
  query: string
  hits: MemorySearchHit[]
  strategy: 'keyword' | 'latest' | 'fallback' | 'hybrid'
  durationMs: number
}

/** 主动记忆捕获请求 */
export interface MemoryCaptureInput {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  sessionId?: string
  workspaceSlug?: string
  withCorrections?: boolean
  /** 0.3.0：提取候选写入层（默认 project） */
  scope?: 'project' | 'global'
}

/** 提取器对单条消息的可选记忆候选 */
export interface MemoryCandidate {
  content: string
  type: MemoryAtomType
  priority?: number
}

// ===== Suggestion（主动建议）类型 =====

/** 建议类型 */
export type SuggestionKind =
  | 'correction'
  | 'followup'
  | 'automation'
  | 'skill'
  | 'todo'

/** 建议可执行动作 */
export type SuggestionAction =
  | { type: 'memory_correction'; raw: string; rule: string }
  | {
      type: 'open_automation_create'
      automationTitle: string
      suggestedPrompt: string
      /** 预填 cron（时间解析器生成，v0 可选） */
      cron?: string
      /** 预填截止时间戳（时间解析器生成，v0 可选） */
      dueAt?: number
    }
  | { type: 'open_todo_create'; title: string; notes?: string; dueAt?: number }
  | { type: 'open_memory_board' }
  | { type: 'open_skill_creator'; topic: string }

/** 主动建议候选（引擎生成，未持久化） */
export interface SuggestionCandidate {
  duplicateKey: string
  kind: SuggestionKind
  title: string
  reason: string
  evidence: string
  rawConfidence: number
  action: SuggestionAction
}

/** 已持久化的建议记录（含反馈状态） */
export interface SuggestionRecord extends SuggestionCandidate {
  id: string
  sessionId?: string
  status: 'suggested' | 'accepted' | 'ignored' | 'never'
  createdAt: number
  feedbackAt?: number
  /** 0.3.0 新增：记录所在数据层（project/global）；读取旧记录按文件层推断填充 */
  scope?: 'project' | 'global'
}

/** 建议反馈 */
export type SuggestionFeedback = 'accepted' | 'ignored' | 'never'

/** 建议统计 */
export interface SuggestionStats {
  suggestedCount: number
  todayAccepted: number
  todayIgnored: number
  todayNever: number
  typeWeights: Record<SuggestionKind, number>
}

/** 建议 ROI 漏斗统计（M8：证明价值） */
export interface SuggestionRoiStats {
  /** 漏斗各环节计数（最近 N 天） */
  funnel: {
    suggested: number
    accepted: number
    ignored: number
    never: number
  }
  /** 各类型建议数与接受数（最近 N 天） */
  byType: Array<{
    kind: SuggestionKind
    suggested: number
    accepted: number
    rate: number
  }>
  /** 整体接受率（accepted / 有反馈的） */
  acceptRate: number
  /** 打扰率（1 - acceptRate；有反馈时才有意义） */
  disturbRate: number
  /** 样本是否足够（≥5 条有反馈才下结论） */
  sufficient: boolean
  /** 是否触发降预算（接受率 < 30% 且样本足够） */
  shouldReduceBudget: boolean
  /** 最近 N 天窗口（默认 7） */
  days: number
}

/** 建议引擎评估输入 */
export interface SuggestionEvaluationInput {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  sessionId?: string
  existingSessionSuggestions?: SuggestionRecord[]
  existingAutomationTitles?: string[]
  existingCorrectionRules?: string[]
  sopCandidateCount?: number
}

/** 建议引擎评估输出 */
export interface SuggestionEvaluationResult {
  candidates: SuggestionCandidate[]
  suppressed: Array<{ candidate: SuggestionCandidate; reason: string }>
}

// ===== ActionCard（统一动作卡片协议） =====

/**
 * ActionCard：跨来源统一动作卡片协议（参考 Proma issue #1462）。
 *
 * 原则：卡片只保存「入口 + 状态 + 最小摘要」，原始内容仍归属各自来源系统，
 * 避免复制出第二套数据系统。ProactiveAgent 当前主要产出 source='suggestion'
 * 的卡片（由 SuggestionRecord 转换而来），未来 agent / automation / bridge
 * 等来源可投递同协议卡片。
 */

/** 卡片来源 */
export type ActionCardSource =
  | 'suggestion' // ProactiveAgent 主动建议引擎（当前唯一实现来源）
  | 'agent' // Agent 会话（权限/提问/审批/失败）
  | 'automation' // 定时任务（异常/摘要/需确认结果）
  | 'memory' // 待确认记忆/纠正
  | 'planning' // 今日 Todo / 日程
  | 'project' // 项目事件
  | 'bridge' // 飞书/钉钉等渠道桥

/** 卡片优先级 */
export type ActionCardPriority = 'urgent' | 'normal' | 'low'

/** 卡片允许的动作 */
export type ActionCardAction = 'accept' | 'dismiss' | 'snooze' | 'open'

/** 卡片隐私分级（远程呈现边界） */
export type ActionCardPrivacy = 'local-only' | 'remote-summary'

/** 卡片生命周期状态 */
export type ActionCardStatus =
  | 'pending' // 待处理
  | 'accepted' // 已接受
  | 'dismissed' // 已忽略/关闭
  | 'resolved' // 已解决（含不再建议这类）

/** 卡片目标：点开后跳转的上下文 */
export interface ActionCardTarget {
  kind: 'project' | 'session' | 'file' | 'settings' | 'automation' | 'todo' | 'memory' | 'skill'
  id: string
}

/** 统一动作卡片 */
export interface ActionCard {
  id: string
  source: ActionCardSource
  projectId?: string
  title: string
  summary: string
  priority: ActionCardPriority
  expiresAt?: number
  allowedActions: ActionCardAction[]
  target?: ActionCardTarget
  privacy: ActionCardPrivacy
  status: ActionCardStatus
  /** 稳定去重键（kind + 核心实体），跨运行/跨会话去重 */
  duplicateKey: string
  /** 触发证据（哪条消息/哪个信号触发的），可审计基石 */
  evidence?: string
  createdAt: number
  feedbackAt?: number
}

// ===== SDK 会话消息（宽松结构，供外部读取 JSONL） =====

/**
 * SDKMessage 宽松结构：仅保留 core 关心的字段。
 * 会话 JSONL 为 `type`/`message.content` 嵌套结构，字段足够提取 user/assistant 文本即可。
 */
export interface SDKMessage {
  type: string
  session_id?: string
  parent_tool_use_id?: string | null
  message?: { content?: string | Array<{ type?: string; text?: string; content?: unknown }> }
  [key: string]: unknown
}
