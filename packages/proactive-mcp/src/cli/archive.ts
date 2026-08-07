/**
 * proactive-mcp archive — TTL 记忆归档（M9）
 *
 * 用法：
 *   proactive-mcp archive            # 执行归档（过期记忆移入 archive/archive.jsonl 并删除）
 *   proactive-mcp archive --dry-run  # 只统计过期数，不实际归档
 *   proactive-mcp archive --status   # 查看归档状态（归档数 + 各类型 TTL 配置）
 *   proactive-mcp archive --off      # 提示如何禁用 TTL
 */

import { archiveExpiredAtoms, readArchivedCount, isTtlDisabled, DEFAULT_TTL_DAYS, getTtlDays } from '@proactive-agent/core'

const TYPE_LABEL: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  correction: '纠正',
  sop: '流程',
  todo_context: '待办',
  event: '事件',
}

export function runArchive(argv: string[]): number {
  const dryRun = argv.includes('--dry-run')
  const status = argv.includes('--status')

  if (status) {
    console.log('🧊 TTL 记忆归档状态')
    console.log(`  已归档: ${readArchivedCount()} 条`)
    console.log(`  启用: ${isTtlDisabled() ? '否（PROACTIVE_TTL_OFF=1）' : '是'}`)
    console.log('  默认 TTL（天，null=永久）:')
    for (const [type, days] of Object.entries(DEFAULT_TTL_DAYS)) {
      const eff = getTtlDays(type as keyof typeof DEFAULT_TTL_DAYS)
      const effLabel = eff === null ? '永久' : `${eff} 天`
      const overridden = eff !== days ? `（env 覆盖 → ${effLabel}）` : ''
      console.log(`    ${TYPE_LABEL[type] ?? type}: ${effLabel}${overridden}`)
    }
    console.log('  环境变量: PROACTIVE_TTL_DAYS=N 统一覆盖非永久类型 · PROACTIVE_TTL_OFF=1 禁用')
    return 0
  }

  if (isTtlDisabled()) {
    console.log('⚠️ TTL 已禁用（PROACTIVE_TTL_OFF=1），未执行归档。')
    return 0
  }

  const result = archiveExpiredAtoms({ dryRun })
  if (dryRun) {
    console.log(`🔎 预览（--dry-run）：发现 ${result.expiredCount} 条过期记忆，未实际删除。`)
    console.log('  执行 `proactive-mcp archive` 确认归档。')
  } else {
    console.log(`🧊 归档完成：${result.archived} 条过期记忆移入 archive/archive.jsonl。`)
    if (result.expiredCount > result.archived) {
      console.log(`  （${result.expiredCount - result.archived} 条未删除，可能因文件锁/读取异常）`)
    }
    if (result.archived === 0) console.log('  当前无过期记忆。')
  }
  return 0
}
