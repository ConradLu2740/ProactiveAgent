/**
 * M8 建议 ROI 指标测试
 *
 * 通过直接构造 suggestions.json（单层模式）验证：
 * - funnel 各环节计数（建议/接受/忽略/永不）
 * - acceptRate / disturbRate
 * - shouldReduceBudget：样本 ≥5 且接受率 <30%
 * - 降预算后 evaluateNow 门槛提高（弱信号被抑制、强信号保留）
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as service from './service'
import { suggestionRoiStats, resetSuggestionsCache } from './feedback'
import { resetProjectIdentity } from '../project'
import { getSuggestionsPath } from '../paths'
import { defaultTypeWeights } from './engine'
import type { SuggestionKind } from '../shared-types'

const TEST_DIR = '/tmp/proactive-m8-test-' + Math.random().toString(36).slice(2)

beforeEach(() => {
  // 单层模式（逃生开关）：suggestions.json 直接在 config dir，路径可预测
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  process.env.PROACTIVE_DATA_DIR = TEST_DIR
  process.env.PROMA_MEMORY_DIR = TEST_DIR + '/memory'
  process.env.PROACTIVE_SCOPE = 'global'
  resetSuggestionsCache()
  resetProjectIdentity()
})

/** 构造一条建议记录 */
function rec(partial: {
  id: string
  kind: SuggestionKind
  status: 'suggested' | 'accepted' | 'ignored' | 'never'
  createdAt?: number
}): Record<string, unknown> {
  return {
    id: partial.id,
    kind: partial.kind,
    status: partial.status,
    createdAt: partial.createdAt ?? Date.now(),
    title: 'test suggestion ' + partial.id,
    reason: 'test',
    evidence: 'test',
    rawConfidence: 0.9,
    duplicateKey: 'test:' + partial.id,
    action: { type: 'open_automation_create', automationTitle: 't', suggestedPrompt: 'p' },
  }
}

/** 写入 suggestions.json（records 覆盖） */
function writeRecords(records: Array<Record<string, unknown>>): void {
  const index = {
    version: 1,
    records,
    typeWeights: defaultTypeWeights(),
    enabled: true,
  }
  writeFileSync(getSuggestionsPath(), JSON.stringify(index, null, 2), 'utf-8')
  resetSuggestionsCache()
}

describe('建议 ROI（M8）', () => {
  it('无记录时 ROI 为 0、样本不足、不降预算', () => {
    writeRecords([])
    const roi = suggestionRoiStats(7)
    expect(roi.funnel.suggested).toBe(0)
    expect(roi.acceptRate).toBe(0)
    expect(roi.sufficient).toBe(false)
    expect(roi.shouldReduceBudget).toBe(false)
  })

  it('全部接受 → 接受率 100%、不降预算', () => {
    writeRecords([
      rec({ id: 'a1', kind: 'correction', status: 'accepted' }),
      rec({ id: 'a2', kind: 'automation', status: 'accepted' }),
    ])
    const roi = suggestionRoiStats(7)
    expect(roi.funnel.accepted).toBe(2)
    expect(roi.acceptRate).toBe(1)
    expect(roi.disturbRate).toBe(0)
    expect(roi.shouldReduceBudget).toBe(false)
  })

  it('接受率 <30% 且样本 ≥5 → shouldReduceBudget=true', () => {
    writeRecords([
      rec({ id: 'b1', kind: 'correction', status: 'accepted' }),
      rec({ id: 'b2', kind: 'automation', status: 'ignored' }),
      rec({ id: 'b3', kind: 'correction', status: 'ignored' }),
      rec({ id: 'b4', kind: 'automation', status: 'ignored' }),
      rec({ id: 'b5', kind: 'correction', status: 'ignored' }),
      rec({ id: 'b6', kind: 'automation', status: 'ignored' }),
    ])
    const roi = suggestionRoiStats(7)
    expect(roi.funnel.accepted).toBe(1)
    expect(roi.funnel.ignored).toBe(5)
    expect(roi.sufficient).toBe(true)
    expect(roi.acceptRate).toBeCloseTo(1 / 6)
    expect(roi.shouldReduceBudget).toBe(true)
  })

  it('byType 统计：类型建议数与接受数', () => {
    writeRecords([
      rec({ id: 'c1', kind: 'correction', status: 'accepted' }),
      rec({ id: 'c2', kind: 'correction', status: 'ignored' }),
      rec({ id: 'c3', kind: 'automation', status: 'suggested' }),
    ])
    const roi = suggestionRoiStats(7)
    const correctionType = roi.byType.find((t) => t.kind === 'correction')
    expect(correctionType?.suggested).toBe(2)
    expect(correctionType?.accepted).toBe(1)
    expect(correctionType?.rate).toBeCloseTo(0.5)
  })

  it('shouldReduceBudget 为 true 时 evaluateNow 提高门槛（弱信号被抑制）', async () => {
    // 直接写入 5 条混合忽略记录（correction×2 + automation×2 + followup×1，规避单类型静默）
    writeRecords([
      rec({ id: 'd1', kind: 'correction', status: 'ignored' }),
      rec({ id: 'd2', kind: 'automation', status: 'ignored' }),
      rec({ id: 'd3', kind: 'correction', status: 'ignored' }),
      rec({ id: 'd4', kind: 'automation', status: 'ignored' }),
      rec({ id: 'd5', kind: 'followup', status: 'ignored' }),
    ])
    expect(service.shouldReduceSuggestionBudget()).toBe(true)

    // 降预算后 threshold=0.9：session_end 下弱信号 followup（conf 0.8）被抑制
    // （无降预算时 followup 0.8 ≥ 0.6 会通过，见 evaluate-now.test 覆盖）
    const followup = await service.evaluateNow({
      trigger: 'session_end',
      sessionId: 'roi-budget-followup',
      messages: [{ role: 'user', content: '明天继续做这个功能' }],
    })
    expect(followup.length).toBe(0)
  })
})
