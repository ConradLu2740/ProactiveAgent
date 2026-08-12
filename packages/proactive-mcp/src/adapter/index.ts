/**
 * HostAdapter 注册表（M1）
 *
 * 参考 harnery AdapterRegistry：id 唯一、重复注册 fail loud。
 * hooks 脚本与引擎通过 getAdapter(hostId) 取适配器，判断用能力而非宿主名。
 */

import type { HostAdapter, HostId } from './types'
import { claudeAdapter } from './claude'
import { kimiAdapter } from './kimi'
import { cursorAdapter } from './cursor'
import { clineAdapter } from './cline'
import { codexAdapter } from './codex'

const registry = new Map<HostId, HostAdapter>()

/** 注册适配器（重复 id fail loud） */
export function registerAdapter(adapter: HostAdapter): void {
  if (registry.has(adapter.id)) {
    throw new Error(`[adapter] 重复注册 HostAdapter: ${adapter.id}`)
  }
  registry.set(adapter.id, adapter)
}

/** 获取适配器（未注册返回 undefined） */
export function getAdapter(id: HostId): HostAdapter | undefined {
  return registry.get(id)
}

/** 列出全部适配器 */
export function listAdapters(): HostAdapter[] {
  return [...registry.values()]
}

/** 内置适配器注册（claude / kimi / cursor / cline / codex） */
export function registerBuiltinAdapters(): void {
  if (registry.size === 0) {
    registerAdapter(claudeAdapter)
    registerAdapter(kimiAdapter)
    registerAdapter(cursorAdapter)
    registerAdapter(clineAdapter)
    registerAdapter(codexAdapter)
  }
}

registerBuiltinAdapters()

export type { HostAdapter, HostCapabilities, Capability, HostId, HostMessage, HostSuggestion, InjectionContext, HostHookInput, HostEventMap } from './types'
export { detectHostId } from './types'
export { claudeAdapter, renderTextSuggestion, renderTodayInjection, extractTranscriptMessages } from './claude'
export { kimiAdapter, renderKimiNotification, extractWireMessages, locateWireFile } from './kimi'
export { cursorAdapter, readCursorSession, looksLikeCursorInput } from './cursor'
export { clineAdapter, readClineSession } from './cline'
export { codexAdapter, readCodexSession } from './codex'
