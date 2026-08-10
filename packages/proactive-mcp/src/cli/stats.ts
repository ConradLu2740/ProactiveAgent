/**
 * proactive-mcp stats — 记忆状态一瞥
 *
 * 命令行只读快照：记忆统计 + 建议统计 + 数据目录/模式展示。
 * 是 /today 面板的终端版。
 */

import os from 'node:os'
import { memoryService, suggestService, getConfigDir, getMemoryRootDir, getProjectIdentity, isEscapeGlobal } from '@proactive-agent/core'

const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  correction: '纠正',
  sop: '流程',
  todo_context: '待办',
  event: '事件',
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p
}

/** 输出记忆统计 */
export function runStats(): number {
  const mem = memoryService.stats()
  const sug = suggestService.getSuggestionStats()
  const mode = memoryService.extractionMode()
  const llmConfigured = memoryService.isLlmConfigured()
  // 展示实际生效模式：llm 但未配置 → 实际跑规则；规则/off → 直接显示
  const effectiveMode = mode === 'llm' && !llmConfigured ? 'rule（降级）' : mode

  console.log('📊 ProactiveAgent 统计')
  console.log('')
  // 0.3.0：项目身份
  try {
    if (isEscapeGlobal()) {
      console.log('  项目: （逃生模式 PROACTIVE_SCOPE=global）')
    } else {
      const ident = getProjectIdentity()
      console.log(`  项目: ${ident.displayName}（${ident.identitySource}，key=${ident.key}）`)
    }
  } catch {
    // 忽略
  }
  console.log('  记忆')
  console.log(`    atom 总数:  ${mem.atomCount}`)
  const byType = Object.entries(mem.byType)
    .filter(([, n]) => (n as number) > 0)
    .map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`)
    .join(' · ')
  if (byType) console.log(`    按类型:     ${byType}`)
  console.log(`    场景:       ${mem.sceneCount} 个`)
  console.log(`    待确认:     ${mem.pendingAtoms + mem.pendingCorrections}（记忆 ${mem.pendingAtoms} + 纠正 ${mem.pendingCorrections}）`)
  console.log(`    画像:       ${mem.personaExists ? '已生成' : '未生成'}`)
  const activity = memoryService.memoryActivity()
  const review = memoryService.memoryReviewOpportunity()
  console.log(`    记忆动态:   今日 ${activity.todayEntries} 条 · 距上次更新 ${activity.daysSinceLastUpdate} 天`)
  const overload = memoryService.personaOverloadHint()
  if (overload.overloaded) console.log(`    ⚠️ 画像超载:  ${overload.lineCount} 行 / ${overload.sectionCount} 章节，建议精简重整`)
  if (review) console.log(`    💡 ${review.message}`)
  if (mem.lastExtractionAt) {
    console.log(`    上次提取:   ${new Date(mem.lastExtractionAt).toLocaleString('zh-CN')}`)
  }
  console.log('')
  console.log('  建议')
  console.log(`    待处理:     ${sug.suggestedCount} 条`)
  console.log(`    今日:       接受 ${sug.todayAccepted} · 忽略 ${sug.todayIgnored} · 未反馈 ${sug.todayNever}`)
  const weights = Object.entries(sug.typeWeights)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')
  console.log(`    类型权重:   ${weights}`)
  console.log('')
  console.log('  数据')
  console.log(`    根目录:     ${expandHome(getConfigDir())}`)
  console.log(`    记忆目录:   ${expandHome(getMemoryRootDir())}`)
  console.log(`    提取模式:   ${effectiveMode}${llmConfigured ? '（LLM 已配置）' : '（规则模式，零外发）'}`)
  return 0
}
