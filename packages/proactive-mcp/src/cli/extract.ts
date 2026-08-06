/**
 * proactive-mcp extract — 对已有项目做一次记忆提取（冷启动引导）
 *
 * 扫描当前项目的 README / docs / package.json / git log / TODO，
 * 规则模式归一为记忆候选，默认 pending（需 memory_confirm 确认后进入召回）。
 * 纯规则零外发；--dry-run 只预览不写入。
 */

import { extractRepoMemory } from '@proactive-agent/core'

export function runExtract(args: string[]): number {
  const dryRun = args.includes('--dry-run')
  const global = args.includes('--global')
  const verbose = args.includes('--verbose')

  const result = extractRepoMemory({ dryRun, scope: global ? 'global' : 'project' })

  console.log('🔍 ProactiveAgent 项目记忆提取')
  console.log('')
  console.log('  扫描源:')
  console.log(`    README:        ${result.sources.readme ? '✅ 已读取' : '—'}`)
  console.log(`    docs/ 文档:    ${result.sources.docs > 0 ? `${result.sources.docs} 个文件` : '—'}`)
  console.log(`    package.json:  ${result.sources.packageJson ? '✅ 已读取' : '—'}`)
  console.log(`    git log:       ${result.sources.gitLog > 0 ? `${result.sources.gitLog} 条提交` : '—（非 git 仓库）'}`)
  console.log(`    TODO/FIXME:    ${result.sources.todos > 0 ? `${result.sources.todos} 条` : '—'}`)
  console.log('')

  if (result.candidates.length === 0) {
    console.log('未提取到记忆候选（项目信息较少；用 memory_capture 手动沉淀偏好）。')
    return 0
  }

  if (dryRun) {
    console.log(`🔍 预览 ${result.candidates.length} 条候选（--dry-run 未写入）：`)
    console.log('')
  } else {
    console.log(`🧠 提取 ${result.candidates.length} 条候选，写入 ${result.storedCount} 条（pending 待确认）：`)
    console.log('')
  }

  for (const c of result.candidates.slice(0, 20)) {
    console.log(`  [${c.type}] ${c.content.slice(0, 100)}`)
  }
  if (result.candidates.length > 20) {
    console.log(`  … 共 ${result.candidates.length} 条`)
  }
  console.log('')

  if (dryRun) {
    console.log('确认写入：proactive-mcp extract')
  } else {
    console.log('下一步：')
    console.log('  1. 在 agent 里用 memory_pending 查看待确认候选')
    console.log('  2. 用 memory_confirm 确认（进入召回）或 memory_reject 拒绝')
    console.log('  3. 之后 memory_recall 就能命中你的真实项目信息了')
  }
  return 0
}
