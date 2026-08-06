/**
 * scope 参数归一化（MCP 工具侧）
 *
 * 0.3.0「按项目记忆」：
 * - 写入工具（capture/extract）：'project' | 'global'（默认 project）
 * - 读取工具（recall/persona/stats）：'auto' | 'project' | 'global'（默认 auto=双层合并）
 */

import { isSingleLayerMode } from '@proactive-agent/core'

export type WriteScope = 'project' | 'global'
export type ReadScope = 'auto' | 'project' | 'global'

/** 写入层归一化：非法值回退 project；单层模式强制 project（写 PROMA_MEMORY_DIR） */
export function normalizeWriteScope(v: unknown): WriteScope {
  if (isSingleLayerMode()) return 'project'
  return v === 'global' ? 'global' : 'project'
}

/** 读取层归一化：非法值回退 auto */
export function normalizeReadScope(v: unknown): ReadScope {
  if (v === 'project' || v === 'global' || v === 'auto') return v
  return 'auto'
}
