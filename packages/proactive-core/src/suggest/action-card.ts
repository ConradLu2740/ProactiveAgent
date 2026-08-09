/**
 * ActionCard 转换层：SuggestionRecord → ActionCard 桥接
 *
 * ActionCard 是跨来源统一动作卡片协议（见 shared-types）。当前引擎产出的是
 * SuggestionRecord（source='suggestion'），本模块提供纯函数转换：
 * - toActionCard(record): SuggestionRecord → ActionCard（正向）
 * - fromActionCard(card): ActionCard → SuggestionRecord 兼容视图（反向，用于
 *   remote 端接收 ActionCard 后回写本引擎的旧格式，MVP 阶段可选）
 *
 * 转换规则保持最小、可预测：不新增持久化字段，只做字段映射与派生。
 * 旧版 v1 index 记录（无 scope）同样兼容。
 */

import type {
  ActionCard,
  ActionCardAction,
  ActionCardPriority,
  ActionCardStatus,
  ActionCardTarget,
  SuggestionRecord,
} from '../shared-types'

/** 建议状态 → 卡片状态 */
export function toCardStatus(status: SuggestionRecord['status']): ActionCardStatus {
  switch (status) {
    case 'accepted':
      return 'accepted'
    case 'ignored':
      return 'dismissed'
    case 'never':
      return 'resolved'
    default:
      return 'pending'
  }
}

/** 置信度 → 优先级（派生，不持久化） */
export function confidenceToPriority(rawConfidence: number): ActionCardPriority {
  if (rawConfidence >= 0.8) return 'urgent'
  if (rawConfidence >= 0.5) return 'normal'
  return 'low'
}

/** 建议动作 → 卡片目标（可点击跳转上下文） */
export function actionToTarget(
  action: SuggestionRecord['action'] | undefined,
): ActionCardTarget | undefined {
  if (!action) return undefined
  switch (action.type) {
    case 'memory_correction':
      return { kind: 'memory', id: correctionTargetId(action.raw, action.rule) }
    case 'open_automation_create':
      return { kind: 'automation', id: action.automationTitle }
    case 'open_todo_create':
      return { kind: 'todo', id: action.title }
    case 'open_memory_board':
      return { kind: 'memory', id: 'board' }
    case 'open_skill_creator':
      return { kind: 'skill', id: action.topic }
    default:
      return undefined
  }
}

/**
 * memory_correction 的稳定 target id：用 rule 而非 raw 前 120 字符。
 * raw 是用户消息原文（可能换行/重复），rule 是规则表达，稳定且更可读。
 */
export function correctionTargetId(raw: string, rule?: string): string {
  const base = rule || raw
  return base.length > 120 ? base.slice(0, 120) : base
}

/** 建议允许的动作（MVP：suggestion 不支持 snooze，保持 accept/dismiss/open） */
export function allowedActionsFor(status: ActionCardStatus): ActionCardAction[] {
  if (status === 'accepted' || status === 'resolved') return []
  if (status === 'dismissed') return ['open']
  return ['accept', 'dismiss', 'open']
}

/** SuggestionRecord → ActionCard（正向转换） */
export function toActionCard(record: SuggestionRecord): ActionCard {
  const status = toCardStatus(record.status)
  const target = actionToTarget(record.action)
  return {
    id: record.id,
    source: 'suggestion',
    // SuggestionRecord 无 projectId；如 scope 存在可映射为 projectId 的占位，
    // 但 MVP 不引入新持久化字段，保持 undefined
    title: record.title,
    summary: record.reason,
    priority: confidenceToPriority(record.rawConfidence),
    allowedActions: allowedActionsFor(status),
    target,
    privacy: 'local-only',
    status,
    duplicateKey: record.duplicateKey,
    evidence: record.evidence,
    createdAt: record.createdAt,
    feedbackAt: record.feedbackAt,
  }
}

/** 批量转换 */
export function toActionCards(records: SuggestionRecord[]): ActionCard[] {
  return records.map(toActionCard)
}
