/**
 * @proactive-agent/core — ProactiveAgent headless 引擎
 *
 * 宿主无关的主动能力引擎：
 * - memoryService：主动记忆（capture/recall/persona/scene/extract）
 * - suggestService：主动建议（evaluate/feedback/analyst/group）
 * - setAutomationTitlesProvider：注入宿主 automation 标题（可选）
 *
 * 用法：
 * ```ts
 * import { memoryService, suggestService, setAutomationTitlesProvider } from '@proactive-agent/core'
 * // Electron: setAutomationTitlesProvider(() => listAutomations().map(a => a.name))
 * ```
 */

import * as memoryService from './memory/service'
import * as suggestService from './suggest/service'
import { setAutomationTitlesProvider } from './provider'
export * from './paths'
export * from './provider'
export * from './memory/repo-extract'
export * from './memory/ttl'
export * from './shared-types'
export type { ProactiveCoreOptions } from './types'

export { memoryService, suggestService }

import type { ProactiveCoreOptions } from './types'

export function createCore(options: ProactiveCoreOptions = {}): {
  memory: typeof memoryService
  suggest: typeof suggestService
} {
  if (options.automationTitles) {
    setAutomationTitlesProvider(options.automationTitles)
  }
  return { memory: memoryService, suggest: suggestService }
}
