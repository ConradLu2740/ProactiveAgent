/**
 * ProactiveAgent Core 路径解析（宿主无关）
 *
 * 默认根目录：~/.proma-proactive/（用户级一份共享，跨工具复用）
 * 覆盖优先级：PROACTIVE_DATA_DIR > PROMA_MEMORY_DIR（兼容旧数据）
 *
 * 目录布局与 Proma 既有约定一致：
 * ```text
 * ~/.proma-proactive/
 *   index.json            # 记忆索引（按需生成：写入开关/提取模式等配置时落盘）
 *   profile.md            # L3 用户画像
 *   atoms/{YYYY-MM-DD}.jsonl   # L1 原子记忆
 *   scenes/{sceneId}.md   # L2 场景块
 *   corrections.json      # 行为纠正候选
 *   suggestions.json      # 主动建议记录
 *   memory_log/{YYYY-MM-DD}.md # 每日记忆变更日志
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

// ===== memory 路径（对齐 Proma 布局） =====

/**
 * 记忆根目录：PROMA_MEMORY_DIR 直接覆盖（对齐原 config-paths 语义），
 * 否则为 core 根/memory。
 */
export function getMemoryRootDir(): string {
  const memOverride = process.env.PROMA_MEMORY_DIR?.trim()
  if (memOverride) return memOverride
  return join(getConfigDir(), 'memory')
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

// ===== suggestions 路径 =====

export function getSuggestionsPath(): string {
  return join(getConfigDir(), 'suggestions.json')
}
