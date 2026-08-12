/**
 * proactive-mcp doctor — 健康检查
 *
 * 开发者遇到"为什么没生效"时一键诊断。输出体检报告：
 * 数据目录 / 索引可读 / LLM 配置 / hooks 产物 / today 端口。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { createConnection } from 'node:net'
import { memoryService, suggestService, getConfigDir, getMemoryRootDir, getProjectIdentity, isEscapeGlobal, readTopIndex } from '@proactive-agent/core'
import { isProcessAlive, dailyNotifiedCount, dailyNotifyLimit, personaDisturbCoefficient } from '../daemon'

interface CheckResult {
  status: 'ok' | 'warn' | 'error'
  label: string
  detail: string
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p
}

/** 检查数据目录存在性与可写性 */
function checkDataDir(): CheckResult {
  const dir = expandHome(getConfigDir())
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.doctor-probe-${Date.now()}`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return { status: 'ok', label: '数据目录', detail: dir }
  } catch (error) {
    return { status: 'error', label: '数据目录', detail: `${dir} 不可写：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 检查 LLM 配置（同源链） */
function checkLlm(): CheckResult {
  const mode = memoryService.extractionMode()
  const configured = memoryService.isLlmConfigured()
  if (mode === 'off') {
    return { status: 'warn', label: '提取模式', detail: '已关闭（记忆提取不工作）' }
  }
  if (mode === 'llm' && !configured) {
    // 全新安装未配 LLM：说明这是默认状态而非用户配置错误（措辞修复 #4）
    return { status: 'ok', label: '提取模式', detail: '规则模式（未配置 LLM，零外发可用；配置 MEMORY_LLM_API_KEY 可提升提取精度）' }
  }
  return { status: 'ok', label: '提取模式', detail: `${mode}${configured ? ' · LLM 已配置' : ' · 规则模式（零外发）'}` }
}

/** 检查 hooks 产物是否存在（发布包内置） */
function checkHooks(): CheckResult {
  // 从当前模块位置推断 dist/hooks/（import.meta.url 指向 dist/index.js）
  const here = fileURLToPath(import.meta.url)
  const distDir = dirname(here)
  const hooksDir = join(distDir, 'hooks')
  const todayPush = join(hooksDir, 'today-push.js')
  const sessionEnd = join(hooksDir, 'session-end.js')
  const found = existsSync(todayPush) && existsSync(sessionEnd)
  if (!found) {
    return { status: 'warn', label: 'hooks 产物', detail: `${hooksDir} 缺少 today-push.js / session-end.js（发布包应内置；源码跑 dev 时属正常，构建后生成）` }
  }
  return { status: 'ok', label: 'hooks 产物', detail: hooksDir }
}

/** 检查项目 .claude/settings.json 里配置的 hooks 路径是否真实存在 */
function checkProjectHooks(): CheckResult {
  const target = join(process.cwd(), '.claude', 'settings.json')
  if (!existsSync(target)) {
    return { status: 'ok', label: '项目 hooks 配置', detail: '未配置（用 proactive-mcp init 一键生成）' }
  }
  try {
    const cfg = JSON.parse(readFileSync(target, 'utf-8')) as { hooks?: Record<string, unknown> }
    const hooks = cfg.hooks ?? {}
    const commands: string[] = []
    for (const event of Object.values(hooks)) {
      for (const entry of event as Array<{ hooks?: Array<{ command?: string }> }>) {
        for (const h of entry.hooks ?? []) {
          if (h.command?.includes('proactive') || h.command?.includes('today-push') || h.command?.includes('session-end')) commands.push(h.command)
        }
      }
    }
    if (commands.length === 0) {
      return { status: 'ok', label: '项目 hooks 配置', detail: `${target}（未发现 proactive-agent hooks）` }
    }
    const missing = commands.filter((c) => {
      const match = c.match(/node\s+(.+)/)
      if (!match) return false
      const p = match[1].trim().replace(/^"|^'/, '').replace(/"$|'$/, '')
      return !existsSync(p)
    })
    if (missing.length > 0) {
      return { status: 'warn', label: '项目 hooks 配置', detail: `${missing.length} 条 hooks 路径不存在：${missing[0]?.slice(0, 80)}…（请重新 proactive-mcp init）` }
    }
    return { status: 'ok', label: '项目 hooks 配置', detail: `${target}（${commands.length} 条 proactive hooks，路径均存在）` }
  } catch {
    return { status: 'warn', label: '项目 hooks 配置', detail: `${target} 不是合法 JSON，请检查` }
  }
}

/** 检查记忆索引可读与统计 */
function checkMemory(): CheckResult {
  try {
    const stats = memoryService.stats()
    const parts = [
      `${stats.atomCount} 条 atom`,
      `${stats.sceneCount} 场景`,
      stats.personaExists ? '画像已生成' : '画像未生成',
      stats.pendingAtoms + stats.pendingCorrections > 0 ? `${stats.pendingAtoms + stats.pendingCorrections} 条待确认` : '无待确认',
    ]
    return { status: 'ok', label: '记忆状态', detail: parts.join(' · ') }
  } catch (error) {
    return { status: 'error', label: '记忆状态', detail: `读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 检查建议索引健康 */
function checkSuggest(): CheckResult {
  try {
    const s = suggestService.getSuggestionStats()
    return { status: 'ok', label: '建议状态', detail: `建议 ${s.suggestedCount} 条 · 今日接受 ${s.todayAccepted} · 忽略 ${s.todayIgnored}` }
  } catch (error) {
    return { status: 'warn', label: '建议状态', detail: `读取失败（首次使用可能为空）：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 检查 today 端口占用（异步） */
function checkTodayPort(): Promise<CheckResult> {
  const port = Number(process.env.PROACTIVE_TODAY_PORT ?? 8737)
  return new Promise<CheckResult>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.destroy()
      resolve({ status: 'warn', label: 'today 端口', detail: `${port} 已被占用（可能已有实例在运行；用 PROACTIVE_TODAY_PORT 换端口）` })
    })
    socket.on('error', () => {
      resolve({ status: 'ok', label: 'today 端口', detail: `${port} 空闲（--today 面板可用）` })
    })
  })
}

/** 检查 daemon 守护进程状态（0.5 主动出口） */
function checkDaemon(): CheckResult {
  const p = join(getConfigDir(), 'daemon.json')
  try {
    if (!existsSync(p)) {
      return { status: 'ok', label: 'daemon 状态', detail: '未运行（proactive-mcp daemon 启动；--install 登录自启）' }
    }
    const state = JSON.parse(readFileSync(p, 'utf-8')) as {
      pid?: number
      startedAt?: number
      lastRunAt?: number
      lastNotifyAt?: number
      notifiedIds?: string[]
      dailyNotified?: number
      dailyNotifiedDate?: string
    }
    const alive = typeof state.pid === 'number' && isProcessAlive(state.pid)
    if (!alive) {
      return { status: 'warn', label: 'daemon 状态', detail: `pid=${state.pid} 不存活（陈旧状态；重启 daemon 会覆盖，或 daemon --status 查看）` }
    }
    const parts = [`pid=${state.pid}`]
    if (state.lastRunAt) parts.push(`上次评估 ${new Date(state.lastRunAt).toLocaleTimeString()}`)
    if (state.lastNotifyAt) parts.push(`上次通知 ${new Date(state.lastNotifyAt).toLocaleTimeString()}`)
    if (Array.isArray(state.notifiedIds)) parts.push(`已通知 ${state.notifiedIds.length} 条`)
    // 0.8：今日疲劳状态（跨天自动重置）
    const used = dailyNotifiedCount({ dailyNotified: state.dailyNotified ?? 0, dailyNotifiedDate: state.dailyNotifiedDate ?? '' })
    const coeff = personaDisturbCoefficient()
    const limit = dailyNotifyLimit()
    parts.push(`今日 ${used}/${limit} 条${coeff < 1 ? '（画像少打扰 ×' + coeff + '）' : ''}`)
    if (used >= limit) {
      return { status: 'warn', label: 'daemon 状态', detail: parts.join(' · ') + '（已达今日通知上限，建议保留至明日）' }
    }
    return { status: 'ok', label: 'daemon 状态', detail: parts.join(' · ') }
  } catch {
    return { status: 'warn', label: 'daemon 状态', detail: '状态文件异常（首次使用可能为空）' }
  }
}

/** 运行全部检查并输出报告 */
export async function runDoctor(): Promise<number> {
  const dataDir = expandHome(getConfigDir())
  const memRoot = expandHome(getMemoryRootDir())
  const checks = [checkDataDir(), checkLlm(), checkHooks(), checkProjectHooks(), checkMemory(), checkSuggest(), await checkTodayPort(), checkDaemon()]

  console.log('ProactiveAgent 健康检查')
  console.log(`  数据根目录: ${dataDir}`)
  console.log(`  记忆目录:   ${memRoot}`)
  // 0.3.0：项目身份与迁移状态
  try {
    if (isEscapeGlobal()) {
      console.log('  项目:       （逃生模式 PROACTIVE_SCOPE=global，全部读写全局单层）')
    } else {
      const ident = getProjectIdentity()
      console.log(`  项目:       ${ident.displayName}（${ident.identitySource}，key=${ident.key}）`)
    }
    const top = readTopIndex()
    if (top?.migration?.status === 'done') {
      console.log(`  迁移:       旧数据已迁移到 global 层（${new Date(top.migration.at).toISOString().slice(0, 10)}）`)
    }
  } catch {
    // 身份/迁移展示失败不阻塞
  }
  console.log('')
  let errors = 0
  let warns = 0
  for (const c of checks) {
    const icon = c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'
    if (c.status === 'error') errors += 1
    if (c.status === 'warn') warns += 1
    console.log(`  ${icon} ${c.label}: ${c.detail}`)
  }
  console.log('')
  if (errors > 0) {
    console.log(`结果: ${errors} 个错误 · ${warns} 个警告 —— 建议先修复错误项`)
    return 1
  }
  if (warns > 0) {
    console.log(`结果: 基本正常（${warns} 个警告，见上方说明）`)
    return 0
  }
  console.log('结果: 全部正常 ✅')
  return 0
}
