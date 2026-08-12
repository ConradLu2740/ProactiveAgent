/**
 * proactive-mcp demo-data — 生成精心编排的演示数据（演示素材工具）
 *
 * 用途：Show HN / Reddit / README GIF 的演示环境重建。生成一套真实感的
 * 「记忆 + 建议 + 任务 + 画像 + 疲劳计数」，让 /today 面板和 daemon 通知
 * 有内容可展示。走真实引擎链路（captureCandidate / evaluateNow / task-store），
 * 不是伪造 JSON。
 *
 * 用法：
 *   PROACTIVE_DATA_DIR=/tmp/pa-demo proactive-mcp demo-data
 *   proactive-mcp demo-data --clean   # 清理演示目录
 *
 * 数据写入当前 PROACTIVE_DATA_DIR（默认 ~/.proma-proactive/）。演示时请务必
 * 用隔离目录，避免污染真实记忆。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryService, suggestService, getConfigDir } from '@proactive-agent/core'
import { addTodo, addAutomation } from '../task-store'

/** 演示数据标记：记录已生成（避免重复执行重复写建议） */
function markerPath(): string {
  return join(getConfigDir(), '.demo-data-marker')
}

function cleanDemoData(): void {
  const dir = getConfigDir()
  // 防误删：只在存在 demo marker（本工具生成过数据）时才允许清理
  if (!existsSync(markerPath())) {
    console.log(`❌ 拒绝清理：${dir} 没有演示数据 marker（.demo-data-marker），可能包含真实数据。`)
    console.log('   如确认要清理，请先手动删除 marker 或用隔离的 PROACTIVE_DATA_DIR 目录。')
    return
  }
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    console.log(`🧹 已清理演示数据目录: ${dir}`)
  } else {
    console.log('ℹ️  没有演示数据需要清理')
  }
}

function marker(): { done: boolean } {
  try {
    return existsSync(markerPath()) ? { done: true } : { done: false }
  } catch {
    return { done: false }
  }
}

/** 注入一条记忆（确认生效） */
function remember(content: string, type: 'fact' | 'preference' | 'correction' | 'sop' | 'todo_context' | 'event', priority: number): void {
  try {
    const r = memoryService.captureCandidate({ content, type, priority }, {}, { confirmed: true })
    console.log(`   💾 [${type}] ${content}${r.deduplicated ? '（合并）' : ''}`)
  } catch (error) {
    console.warn(`   跳过记忆（${error instanceof Error ? error.message : '未知'}）: ${content}`)
  }
}

/** 注入一条建议（走真实引擎链路；session_mid 只推强信号，followup/todo 用 session_end 语义） */
async function suggest(messages: string[], sessionId: string, trigger: 'session_mid' | 'session_end' = 'session_mid'): Promise<void> {
  try {
    const records = trigger === 'session_end'
      ? await suggestService.evaluateSessionSuggestions(
          messages.map((m) => ({ role: 'user' as const, content: m })),
          { sessionId },
        )
      : await suggestService.evaluateNow({
          trigger,
          sessionId,
          messages: messages.map((m) => ({ role: 'user' as const, content: m })),
        })
    if (records.length > 0) {
      const r = records[0]
      console.log(`   💡 [${r.kind}] ${r.title} —— ${r.reason.slice(0, 50)}`)
    } else {
      console.warn(`   未生成建议（该沉默时沉默？）: ${messages[0]?.slice(0, 30)}`)
    }
  } catch (error) {
    console.warn(`   建议生成失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 写入画像（真实感，不含"少打扰"词避免干扰疲劳展示） */
function writePersona(): void {
  try {
    memoryService.savePersona(
      [
        '## 技术栈',
        '- 偏好 TypeScript + Bun，包管理用 pnpm（不要用 npm）',
        '- 前端 React，后端 Node；monorepo（pnpm workspaces）',
        '',
        '## 工作习惯',
        '- 提交代码前必须先写单元测试',
        '- 喜欢简洁的回复，先给结论再展开',
        '- 每天下午会检查发布状态',
        '',
        '## 当前关注',
        '- 正在重构 auth 模块的 token 刷新逻辑',
        '',
      ].join('\n'),
      'project',
    )
    console.log('   👤 用户画像已写入')
  } catch (error) {
    console.warn(`   画像写入失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 写入疲劳计数（daemon.json：今日 2/6，让面板/doctor 展示克制状态） */
function writeFatigueState(): void {
  try {
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const state = {
      version: 1,
      pid: -1,
      startedAt: Date.now() - 86_400_000,
      notifiedIds: ['demo-notify-1', 'demo-notify-2'],
      dailyNotified: 2,
      dailyNotifiedDate: today,
      lastRunAt: Date.now() - 3_600_000,
      lastNotifyAt: Date.now() - 3_000_000,
    }
    writeFileSync(join(getConfigDir(), 'daemon.json'), JSON.stringify(state, null, 2), 'utf-8')
    console.log('   ⏱️  疲劳状态：今日已通知 2/6 条')
  } catch (error) {
    console.warn(`   疲劳状态写入失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 运行演示数据生成 */
export async function runDemoData(argv: string[]): Promise<number> {
  if (argv.includes('--clean')) {
    cleanDemoData()
    return 0
  }

  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true })
  if (marker().done && !argv.includes('--force')) {
    console.log(`ℹ️  演示数据已存在（${dir}）。用 --force 重新生成，或 --clean 清理后重跑。`)
    return 0
  }

  console.log(`🎬 正在生成演示数据 → ${dir}`)
  console.log('')

  // ① 记忆（真实感）
  console.log('① 记忆：')
  remember('用户偏好用 TypeScript 和 Bun，包管理用 pnpm', 'preference', 85)
  remember('提交代码前必须先写单元测试', 'correction', 90)
  remember('项目采用 pnpm monorepo（pnpm workspaces），依赖用 pnpm 安装', 'fact', 70)
  remember('待办：重构 auth 模块的 token 刷新逻辑', 'todo_context', 75)
  remember('今天完成了 0.9.0 发布，明天跟进用户反馈', 'event', 60)

  // ② 建议（真实规则链路）
  console.log('② 建议：')
  await suggest(['以后都用 pnpm 安装依赖，不要用 npm'], 'demo-sess-correction')
  await suggest(['每天下午 5 点检查发布状态'], 'demo-sess-automation')
  await suggest(['这个重构做到一半，稍后继续，明天接着弄'], 'demo-sess-followup', 'session_end')
  await suggest(['auth 重构还没完成，记得下周给用户发版本更新说明'], 'demo-sess-todo', 'session_end')

  // ③ 落地任务
  console.log('③ 已落地任务：')
  const todo = addTodo({ title: '重构 auth 模块的 token 刷新逻辑', notes: '来自今日记忆沉淀', projectHint: 'demo' })
  console.log(`   ✅ [todo] #${todo.id} ${todo.title}`)
  const auto = addAutomation({ title: '检查发布状态', prompt: '每天下午 5 点检查发布状态', cron: '0 17 * * *', projectHint: 'demo' })
  console.log(`   ✅ [automation] #${auto.id} ${auto.title}（cron: ${auto.cron}）`)

  // ④ 画像 + 疲劳
  console.log('④ 画像 + 疲劳状态：')
  writePersona()
  writeFatigueState()

  // 标记完成
  try {
    writeFileSync(markerPath(), JSON.stringify({ at: Date.now() }), 'utf-8')
  } catch {
    // 标记失败不阻断
  }

  console.log('')
  console.log('✅ 演示数据就绪！下一步：')
  console.log('   proactive-mcp --today        # 打开 http://127.0.0.1:8737/today')
  console.log('   proactive-mcp daemon         # 启动守护进程（演示桌面通知）')
  console.log('   proactive-mcp doctor         # 查看健康与疲劳状态')
  return 0
}
