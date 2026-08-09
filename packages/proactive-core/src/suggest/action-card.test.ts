/**
 * ActionCard 转换层测试
 *
 * 覆盖：状态映射 / 优先级派生 / 目标映射 / 允许动作 / 正向转换全字段 / 批量转换
 */

import { describe, expect, test } from 'bun:test'
import type { SuggestionRecord } from '../shared-types'
import {
  toActionCard,
  toActionCards,
  confidenceToPriority,
  actionToTarget,
  allowedActionsFor,
  toCardStatus,
  correctionTargetId,
} from './action-card'

function makeRecord(overrides: Partial<SuggestionRecord> = {}): SuggestionRecord {
  return {
    id: 'sug-1',
    duplicateKey: 'automation:每日总结',
    kind: 'automation',
    title: '建议开启每日总结自动化',
    reason: '你经常在会话结束时做每日总结',
    evidence: '用户说"以后每天总结一下"',
    rawConfidence: 0.9,
    action: {
      type: 'open_automation_create',
      automationTitle: '每日总结',
      suggestedPrompt: '每天总结当天工作',
    },
    status: 'suggested',
    createdAt: 1700000000000,
    ...overrides,
  }
}

describe('toCardStatus（建议状态 → 卡片状态）', () => {
  test('suggested → pending', () => {
    expect(toCardStatus('suggested')).toBe('pending')
  })
  test('accepted → accepted', () => {
    expect(toCardStatus('accepted')).toBe('accepted')
  })
  test('ignored → dismissed', () => {
    expect(toCardStatus('ignored')).toBe('dismissed')
  })
  test('never → resolved（不再建议这类）', () => {
    expect(toCardStatus('never')).toBe('resolved')
  })
})

describe('confidenceToPriority（置信度 → 优先级）', () => {
  test('≥0.8 → urgent', () => {
    expect(confidenceToPriority(0.8)).toBe('urgent')
    expect(confidenceToPriority(0.95)).toBe('urgent')
  })
  test('0.5~0.79 → normal', () => {
    expect(confidenceToPriority(0.5)).toBe('normal')
    expect(confidenceToPriority(0.79)).toBe('normal')
  })
  test('<0.5 → low', () => {
    expect(confidenceToPriority(0.49)).toBe('low')
    expect(confidenceToPriority(0)).toBe('low')
  })
})

describe('actionToTarget（建议动作 → 卡片目标）', () => {
  test('automation 创建 → automation target', () => {
    const target = actionToTarget({
      type: 'open_automation_create',
      automationTitle: '每日总结',
      suggestedPrompt: 'x',
    })
    expect(target).toEqual({ kind: 'automation', id: '每日总结' })
  })
  test('todo 创建 → todo target', () => {
    const target = actionToTarget({ type: 'open_todo_create', title: '写周报' })
    expect(target).toEqual({ kind: 'todo', id: '写周报' })
  })
  test('memory_correction → memory target', () => {
    const target = actionToTarget({ type: 'memory_correction', raw: '先写测试再提交', rule: 'correction-rule' })
    expect(target?.kind).toBe('memory')
  })
  test('memory board → memory target', () => {
    const target = actionToTarget({ type: 'open_memory_board' })
    expect(target).toEqual({ kind: 'memory', id: 'board' })
  })
  test('skill creator → skill target', () => {
    const target = actionToTarget({ type: 'open_skill_creator', topic: 'npm publish' })
    expect(target).toEqual({ kind: 'skill', id: 'npm publish' })
  })
})

describe('allowedActionsFor（按状态返回允许动作）', () => {
  test('pending → accept/dismiss/open（suggestion 不支持 snooze）', () => {
    expect(allowedActionsFor('pending')).toEqual(['accept', 'dismiss', 'open'])
  })
  test('accepted → 无（已结束）', () => {
    expect(allowedActionsFor('accepted')).toEqual([])
  })
  test('resolved → 无', () => {
    expect(allowedActionsFor('resolved')).toEqual([])
  })
  test('dismissed → open（允许回看）', () => {
    expect(allowedActionsFor('dismissed')).toEqual(['open'])
  })
})

describe('toActionCard（正向全字段转换）', () => {
  test('基本字段映射', () => {
    const card = toActionCard(makeRecord())
    expect(card.id).toBe('sug-1')
    expect(card.source).toBe('suggestion')
    expect(card.title).toBe('建议开启每日总结自动化')
    expect(card.summary).toBe('你经常在会话结束时做每日总结')
    expect(card.priority).toBe('urgent') // 0.9 → urgent
    expect(card.status).toBe('pending')
    expect(card.privacy).toBe('local-only')
    expect(card.duplicateKey).toBe('automation:每日总结')
    expect(card.evidence).toBe('用户说"以后每天总结一下"')
    expect(card.createdAt).toBe(1700000000000)
  })

  test('target 从 action 派生', () => {
    const card = toActionCard(makeRecord())
    expect(card.target).toEqual({ kind: 'automation', id: '每日总结' })
  })

  test('允许动作从状态派生', () => {
    const card = toActionCard(makeRecord({ status: 'suggested' }))
    expect(card.allowedActions).toEqual(['accept', 'dismiss', 'open'])
  })

  test('已接受卡片：status=accepted、无允许动作、带 feedbackAt', () => {
    const card = toActionCard(makeRecord({ status: 'accepted', feedbackAt: 1700000001000 }))
    expect(card.status).toBe('accepted')
    expect(card.allowedActions).toEqual([])
    expect(card.feedbackAt).toBe(1700000001000)
  })

  test('已忽略卡片：status=dismissed', () => {
    const card = toActionCard(makeRecord({ status: 'ignored' }))
    expect(card.status).toBe('dismissed')
  })

  test('低置信度 → low 优先级', () => {
    const card = toActionCard(makeRecord({ rawConfidence: 0.3 }))
    expect(card.priority).toBe('low')
  })

  test('旧记录（无 scope）兼容', () => {
    // scope 是 0.3.0 新增字段；旧 v1 记录缺省时转换不崩溃
    const old = makeRecord() as SuggestionRecord
    const card = toActionCard(old)
    expect(card.source).toBe('suggestion')
    expect(card.status).toBe('pending')
  })

  test('脏数据防御：action 缺失时不抛错、target 为 undefined', () => {
    // suggestions.json 是磁盘数据可被手工编辑；action 缺失不应让 card_list 整体崩溃
    const broken = makeRecord() as SuggestionRecord
    ;(broken as { action?: unknown }).action = undefined
    const card = toActionCard(broken)
    expect(card.target).toBeUndefined()
    expect(card.status).toBe('pending')
  })

  test('memory_correction target id 用 rule 而非 raw 前 120 字符', () => {
    const card = toActionCard(
      makeRecord({
        kind: 'correction',
        action: { type: 'memory_correction', raw: '很长的原文消息'.repeat(50), rule: 'commit-before-test' },
      }),
    )
    expect(card.target?.kind).toBe('memory')
    expect(card.target?.id).toBe('commit-before-test')
  })

  test('correctionTargetId：无 rule 时回退 raw（截断 120）', () => {
    expect(correctionTargetId('short')).toBe('short')
    expect(correctionTargetId('x'.repeat(200)).length).toBe(120)
  })
})

describe('toActionCards（批量）', () => {
  test('空数组 → 空数组', () => {
    expect(toActionCards([])).toEqual([])
  })

  test('多条转换且顺序保持', () => {
    const cards = toActionCards([
      makeRecord({ id: 'a', status: 'suggested' }),
      makeRecord({ id: 'b', status: 'accepted' }),
    ])
    expect(cards.map((c) => c.id)).toEqual(['a', 'b'])
    expect(cards.map((c) => c.status)).toEqual(['pending', 'accepted'])
  })
})
