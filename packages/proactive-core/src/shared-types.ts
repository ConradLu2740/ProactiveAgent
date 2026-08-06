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
  | { type: 'open_automation_create'; automationTitle: string; suggestedPrompt: string }
  | { type: 'open_todo_create'; title: string; notes?: string }
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
