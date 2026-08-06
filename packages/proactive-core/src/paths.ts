/**
 * ProactiveAgent Core 路径解析（宿主无关）
 *
 * 0.3.0「按项目记忆」：默认按项目隔离（~/.proma-proactive/projects/<key>/），
 * 显式全局共享（global/），PROACTIVE_SCOPE=global 逃生回退单层。
 *
 * 覆盖优先级：PROACTIVE_DATA_DIR > PROMA_CONFIG_DIR > ~/.proma-proactive/
 * PROMA_MEMORY_DIR 显式设置时：单层 global 实例（D7，忽略项目概念）
 *
 * 目录布局（0.3.0）：
 * ```text
 * ~/.proma-proactive/
 *   index.json            # 顶层元数据（schemaVersion:2 / projects[] / migration）
 *   projects/<key>/       # 项目隔离数据（meta.json + memory/ + suggestions.json）
 *   global/               # 显式共享层（memory/ + suggestions.json）
 *   .env                  # LLM 配置（全局）
 * ```
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 注意：不做模块级缓存，每次实时读 env（对齐原 config-paths 行为），
// 保证测试可在 beforeAll 设置 PROMA_MEMORY_DIR / PROACTIVE_DATA_DIR 后生效。

/** 获取 core 数据根目录（自动创建） */
export function getConfigDir(): string {
  // PROACTIVE_DATA_DIR（本包专用）> PROMA_CONFIG_DIR（兼容 Proma 既有配置目录）> ~/.proma-proactive/
  const override = process.env.PROACTIVE_DATA_DIR?.trim() || process.env.PROMA_CONFIG_DIR?.trim()
  if (override) {
    if (!existsSync(override)) {
      mkdirSync(override, { recursive: true })
    }
    return override
  }
  const dir = join(homedir(), '.proma-proactive')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

// ===== 项目路由（0.3.0） =====

import {
  isEscapeGlobal,
  isSingleLayerMode,
  resolveProjectKey,
  getProjectsRootDir,
  getGlobalDir,
  getProjectMemoryRootDir,
  getGlobalMemoryRootDir,
  getProjectSuggestionsPath,
  getGlobalSuggestionsPath,
  getProjectMetaPath,
} from './project'

export {
  isEscapeGlobal,
  isSingleLayerMode,
  resolveProjectKey,
  getProjectsRootDir,
  getGlobalDir,
  getProjectMemoryRootDir,
  getGlobalMemoryRootDir,
  getProjectSuggestionsPath,
  getGlobalSuggestionsPath,
  getProjectMetaPath,
}
export {
  getProjectKey,
  getProjectIdentity,
  getTopIndexPath,
  readTopIndex,
  writeTopIndex,
  migrateLegacyData,
  mergeProjectsToGlobal,
  listProjectKeys,
  currentLayerKey,
  resetProjectIdentity,
  pathHash,
  normalizeGitRemote,
  GLOBAL_KEY,
  type ProjectIdentity,
  type Scope,
  type WriteScope,
  type ReadScope,
} from './project'

/** 当前项目记忆根目录（按层路由；PROMA_MEMORY_DIR 显式时返回 override） */
export function getMemoryRootDir(): string {
  const memOverride = process.env.PROMA_MEMORY_DIR?.trim()
  if (memOverride) return memOverride
  if (isEscapeGlobal()) return join(getConfigDir(), 'memory') // 🔴#4：逃生回退 0.2 单层（configDir/memory），与 global/ 物理分离
  if (isSingleLayerMode()) return join(getConfigDir(), 'memory')
  return getProjectMemoryRootDir()
}

export function getMemoryIndexPath(): string {
  return join(getMemoryRootDir(), 'index.json')
}

export function getPersonaPath(): string {
  return join(getMemoryRootDir(), 'profile.md')
}

export function getMemoryAtomsDir(): string {
  return join(getMemoryRootDir(), 'atoms')
}

export function getMemoryAtomsDayPath(dateKey: string): string {
  return join(getMemoryAtomsDir(), `${dateKey}.jsonl`)
}

export function getMemoryScenesDir(): string {
  return join(getMemoryRootDir(), 'scenes')
}

export function getCorrectionsPath(): string {
  return join(getMemoryRootDir(), 'corrections.json')
}

export function getMemoryLogDir(): string {
  return join(getMemoryRootDir(), 'memory_log')
}

// ===== suggestions 路径（按层路由） =====

export function getSuggestionsPath(): string {
  if (isEscapeGlobal() || isSingleLayerMode()) return join(getConfigDir(), 'suggestions.json')
  return getProjectSuggestionsPath()
}

/** 依赖 project.ts 的引用（mcp/today/doctor 等展示用） */
export function getProjectKeyPublic(opts?: { explicit?: string }): string {
  return resolveProjectKey(opts).key
}
