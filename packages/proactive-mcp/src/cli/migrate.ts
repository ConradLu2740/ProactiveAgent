/**
 * proactive-mcp migrate — 旧数据迁移与反向收敛（0.3.0）
 *
 * - migrate                  ：迁移 0.1.x/0.2.x 全局数据到 global 层（幂等）
 * - migrate --merge-to-global：把项目层数据合并回 global（逃生数据侧通道，--preview 预览）
 * - migrate --status         ：查看迁移状态
 */

import { getConfigDir, migrateLegacyData, mergeProjectsToGlobal, readTopIndex, getGlobalDir, getProjectsRootDir } from '@proactive-agent/core'
import { existsSync } from 'node:fs'

export function runMigrate(args: string[]): number {
  const preview = args.includes('--preview')
  const mergeToGlobal = args.includes('--merge-to-global')
  const status = args.includes('--status')

  if (status) {
    const top = readTopIndex()
    const configDir = getConfigDir()
    const hasOldMemory = existsSync(configDir + '/memory')
    const hasOldSuggestions = existsSync(configDir + '/suggestions.json')
    const hasGlobal = existsSync(getGlobalDir())
    const hasProjects = existsSync(getProjectsRootDir())
    console.log('ProactiveAgent 迁移状态')
    console.log(`  顶层 index.json: ${top?.schemaVersion === 2 ? `schemaVersion=${top.schemaVersion}（已迁移或全新）` : '未创建（旧布局或未初始化）'}`)
    console.log(`  旧全局数据: ${hasOldMemory || hasOldSuggestions ? '⚠️ 发现旧布局（运行 proactive-mcp migrate 迁移）' : '无'}`)
    console.log(`  global 层: ${hasGlobal ? '存在' : '未创建'}`)
    console.log(`  projects 层: ${hasProjects ? '存在' : '未创建'}`)
    if (top?.migration) {
      console.log(`  上次迁移: ${top.migration.status} @ ${new Date(top.migration.at).toISOString()} moved=${top.migration.movedFiles.join(',')}`)
    }
    return 0
  }

  if (mergeToGlobal) {
    const result = mergeProjectsToGlobal({ preview })
    if (preview) {
      console.log(`预览：将合并 ${result.items.length} 个项目到 global：`)
      for (const k of result.items) console.log(`  - ${k}`)
      console.log('（--preview 只读，未执行）')
    } else {
      console.log(`已合并 ${result.items.length} 个项目到 global：`)
      for (const k of result.items) console.log(`  - ${k}`)
      console.log('提示：PROACTIVE_SCOPE=global 是读取侧逃生，本命令是数据侧收敛。')
    }
    return 0
  }

  // 默认：执行迁移
  const result = migrateLegacyData()
  if (result.status === 'already-v2') {
    console.log('数据已是 v2 布局，无需迁移。')
  } else if (result.status === 'nothing-to-do') {
    console.log('未发现旧数据（全新初始化），已建立 v2 顶层索引。')
  } else if (result.status === 'migrated') {
    console.log(`✅ 迁移完成：${result.detail ?? ''}`)
    console.log('  旧全局数据已移入 global 层，行为与 0.2.x 一致（recall 默认包含）。')
  } else {
    console.log(`❌ 迁移失败：${result.detail ?? ''}`)
    return 1
  }
  return 0
}
