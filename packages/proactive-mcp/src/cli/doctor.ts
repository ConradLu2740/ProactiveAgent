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
import { memoryService, suggestService, getConfigDir, getMemoryRootDir } from '@proactive-agent/core'

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
    return { status: 'warn', label: 'LLM 提取', detail: '模式为 llm 但未配置 MEMORY_LLM_API_KEY，将降级规则模式（功能可用，精度较低）' }
  }
  return { status: 'ok', label: '提取模式', detail: `${mode}${configured ? ' · LLM 已配置' : ' · 规则模式（零外发）'}` }
}

/** 检查 hooks 产物是否存在（发布包内置） */
function checkHooks(): CheckResult {
  // 从当前模块位置推断 dist/hooks/
  const here = fileURLToPath(import.meta.url)
  const distDir = join(dirname(here), '..')
  const hooksDir = join(distDir, 'hooks')
  const todayPush = join(hooksDir, 'today-push.js')
  const sessionEnd = join(hooksDir, 'session-end.js')
  const found = existsSync(todayPush) && existsSync(sessionEnd)
  if (!found) {
    return { status: 'warn', label: 'hooks 产物', detail: `${hooksDir} 缺少 today-push.js / session-end.js（发布包应内置；源码跑 dev 时属正常，构建后生成）` }
  }
  return { status: 'ok', label: 'hooks 产物', detail: hooksDir }
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

/** 运行全部检查并输出报告 */
export async function runDoctor(): Promise<number> {
  const dataDir = expandHome(getConfigDir())
  const memRoot = expandHome(getMemoryRootDir())
  const checks = [checkDataDir(), checkLlm(), checkHooks(), checkMemory(), checkSuggest(), await checkTodayPort()]

  console.log('ProactiveAgent 健康检查')
  console.log(`  数据根目录: ${dataDir}`)
  console.log(`  记忆目录:   ${memRoot}`)
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
    console.log(`结果: 全部通过（${warns} 个警告，通常可忽略）`)
    return 0
  }
  console.log('结果: 全部正常 ✅')
  return 0
}
