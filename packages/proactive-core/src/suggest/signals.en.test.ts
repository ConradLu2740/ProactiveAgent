/**
 * P1 英文信号支持测试 — 中英文 correction/automation/followup 识别
 */

import { describe, expect, it } from 'bun:test'
import { extractSignals, hasStrongSignal } from './signals'

describe('英文信号（P1）', () => {
  it('英文 correction：please always use', () => {
    const signals = extractSignals(['please always use pnpm for installs'])
    expect(signals.some((s) => s.kind === 'correction')).toBe(true)
  })

  it('英文 correction：please never', () => {
    const signals = extractSignals(['please never commit directly to main'])
    expect(signals.some((s) => s.kind === 'correction')).toBe(true)
  })

  it('英文 correction：from now on', () => {
    const signals = extractSignals(['from now on, always run tests before push'])
    expect(signals.some((s) => s.kind === 'correction')).toBe(true)
  })

  it('英文 correction：I prefer', () => {
    const signals = extractSignals(['I prefer you to write commit messages in Chinese'])
    expect(signals.some((s) => s.kind === 'correction')).toBe(true)
  })

  it('英文 automation：every day', () => {
    const signals = extractSignals(['check the release status every day at 5pm'])
    expect(signals.some((s) => s.kind === 'automation')).toBe(true)
  })

  it('英文 automation：weekly', () => {
    const signals = extractSignals(['send me a weekly summary of the project'])
    expect(signals.some((s) => s.kind === 'automation')).toBe(true)
  })

  it('英文 followup：remind me tomorrow', () => {
    const signals = extractSignals(['remind me tomorrow to submit the report'])
    expect(signals.some((s) => s.kind === 'followup')).toBe(true)
  })

  it('英文 followup：continue next week', () => {
    const signals = extractSignals(['we can continue this next week'])
    expect(signals.some((s) => s.kind === 'followup')).toBe(true)
  })

  it('英文 todo：not done yet', () => {
    const signals = extractSignals(['the migration is not done yet'])
    expect(signals.some((s) => s.kind === 'todo')).toBe(true)
  })

  it('hasStrongSignal 识别英文信号', () => {
    expect(hasStrongSignal(['please always use pnpm'])).toBe(true)
    expect(hasStrongSignal(['check every day'])).toBe(true)
  })

  it('英文拒绝词抑制纯拒绝短句', () => {
    const signals = extractSignals(['never mind'])
    expect(signals.some((s) => s.kind === 'correction')).toBe(false)
  })
})
