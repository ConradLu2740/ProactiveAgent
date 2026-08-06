/**
 * proactive-mcp demo — 教程式示例（教学层 v1）
 *
 * 在隔离的临时数据目录中演示 ProactiveAgent 四类核心能力：
 * capture → recall → suggest → persona。
 * 不污染真实数据，`--clean` 可清理演示目录。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { memoryService, suggestService, getConfigDir } from '@proactive-agent/core'

const DEMO_DIR = join(os.tmpdir(), 'pa-demo-data')

function demoDirLabel(): string {
  return DEMO_DIR
}

/** 清理演示数据 */
function cleanDemo(): void {
  if (existsSync(DEMO_DIR)) {
    rmSync(DEMO_DIR, { recursive: true, force: true })
    console.log(`🧹 已清理演示数据: ${demoDirLabel()}`)
  } else {
    console.log('ℹ️  没有演示数据需要清理')
  }
}

/** 运行完整教学演示 */
export async function runDemo(cleanOnly = false): Promise<number> {
  if (cleanOnly) {
    cleanDemo()
    return 0
  }

  // 隔离数据目录：所有演示写入 /tmp/pa-demo-data，绝不触碰真实 ~/.proma-proactive/
  if (!existsSync(DEMO_DIR)) mkdirSync(DEMO_DIR, { recursive: true })
  process.env.PROACTIVE_DATA_DIR = DEMO_DIR

  console.log('🎓 ProactiveAgent 快速教学（数据隔离于 /tmp/pa-demo-data，不影响真实记忆）')
  console.log('')

  // ① capture：显式沉淀记忆
  console.log('① memory_capture —— 沉淀一条长期记忆')
  const captured = memoryService.captureCandidate(
    { content: '用户偏好用 TypeScript 和 Bun', type: 'preference', priority: 80 },
    {},
    { confirmed: true },
  )
  console.log(`   已记住：[${captured.atom.type}] ${captured.atom.content}${captured.deduplicated ? '（与已有重复，已合并）' : ''}`)
  console.log('')

  // ② recall：检索记忆
  console.log('② memory_recall —— 检索记忆（任务开始前注入上下文）')
  console.log('   （同步 keyword 演示）')
  const syncHits = memoryService.search({ query: 'TypeScript', limit: 5 })
  console.log(`   命中 ${syncHits.hits.length} 条`)
  for (const h of syncHits.hits.slice(0, 3)) {
    console.log(`     - [${h.atom.type}] ${h.atom.content.slice(0, 60)}（score ${h.score.toFixed(2)}）`)
  }
  console.log('')

  // ③ suggest：识别行为纠正
  console.log('③ suggest_now —— 会话结束评估主动建议')
  const records = await suggestService.evaluateSessionSuggestions(
    [{ role: 'user', content: '以后提交代码前必须先写单元测试' }],
    { sessionId: 'demo-session-1' },
  )
  if (records.length === 0) {
    console.log('   （本次无建议——"该沉默时沉默"）')
  } else {
    for (const r of records.slice(0, 3)) {
      console.log(`   建议：[${r.kind}] ${r.title}`)
      console.log(`     理由: ${r.reason}`)
      console.log(`     接受: suggest_accept ${r.id}（写入长期行为纠正，所有工具遵守）`)
    }
  }
  console.log('')

  // ④ persona：画像生成
  console.log('④ persona —— L3 用户画像')
  const persona = memoryService.persona()
  if (persona.summary) {
    console.log(`   画像已生成：${persona.summary.slice(0, 80)}`)
  } else {
    console.log('   画像未生成（记忆足够多后自动生成，或用 memory_capture 沉淀偏好）')
  }
  console.log('')

  console.log('✅ 演示完成！打开 http://127.0.0.1:8737/today 可查看演示数据')
  console.log('   （注意：demo 数据在 /tmp/pa-demo-data，不影响真实记忆）')
  console.log('   清理: proactive-mcp demo --clean')
  console.log('')
  console.log('   💡 下一步：对真实项目做一次提取引导（extract 命令即将推出）')
  return 0
}
