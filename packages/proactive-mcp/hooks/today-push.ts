/**
 * Claude Code SessionStart hook — 今日主动建议 + 记忆注入
 *
 * 在 Claude Code 会话开始时运行：
 * 1. 待处理建议（去重：同一建议注入过一次后不再重复，避免每会话重复打扰）
 * 2. 热点场景
 * 3. 用户画像摘要 + 高优先级记忆（让记忆真正进入工作流，而不是等 agent 自觉调 memory_recall）
 * 无内容则输出空（不打扰）。
 *
 * 安装（.claude/settings.json）：
 * ```json
 * { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun run /abs/path/today-push.ts" }] }] } }
 * ```
 *
 * 运行：bun run hooks/today-push.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { memoryService, suggestService, getConfigDir } from '@proactive-agent/core'
import { recordLifecycle, currentProjectKey } from '../src/event-store'
import { readStdinInput, detectTool } from './common'

/** 去重记录文件：记录已注入过的建议 ID（放在配置目录下，随数据走） */
function lastInjectedPath(): string {
  return join(getConfigDir(), '.today-push-injected.json')
}

function readInjected(): string[] {
  try {
    const p = lastInjectedPath()
    if (!existsSync(p)) return []
    const data = JSON.parse(readFileSync(p, 'utf-8')) as { ids?: string[] }
    return Array.isArray(data.ids) ? data.ids : []
  } catch {
    return []
  }
}

function writeInjected(ids: string[]): void {
  try {
    const p = lastInjectedPath()
    mkdirSync(getConfigDir(), { recursive: true })
    writeFileSync(p, JSON.stringify({ ids: ids.slice(-50), updatedAt: Date.now() }, null, 2), 'utf-8')
  } catch {
    // 去重记录写失败不影响主流程
  }
}

function main(): void {
  try {
    // 0.6：跨工具事件感知——会话开始事件（daemon 定时评估上下文来源；工具自适应）
    try {
      const input = readStdinInput()
      recordLifecycle(detectTool(input), 'start', { sid: input.session_id ?? input.sessionId, pk: currentProjectKey() })
    } catch {
      // 事件写入失败不阻断
    }
    // 待处理建议（去重：只注入未注入过的）
    const injected = readInjected()
    const allSuggestions = suggestService.listSuggestionsForUI('suggested').slice(0, 10)
    const suggestions = allSuggestions.filter((s) => !injected.includes(s.id)).slice(0, 3)
    const scenes = memoryService.getHotScenes({ limit: 3 })
    const personaRaw = memoryService.personaRaw()
    const persona = memoryService.persona()

    // 注入过本次建议后记录（下次不再重复）
    if (suggestions.length > 0) {
      writeInjected([...injected, ...suggestions.map((s) => s.id)])
    }

    if (suggestions.length === 0 && scenes.length === 0 && !personaRaw) {
      // 该沉默时沉默：无内容不注入
      console.log('')
      return
    }

    const lines: string[] = []
    lines.push('【ProactiveAgent 主动中心】')
    if (suggestions.length > 0) {
      lines.push('待处理建议：')
      for (const s of suggestions) {
        lines.push(`- [${s.kind}] ${s.title}（${s.reason}）`)
      }
    }
    if (scenes.length > 0) {
      lines.push('近期关注：' + scenes.map((s) => s.title).join('、'))
    }
    // 记忆注入（P1-1）：画像摘要 + 高优先级记忆，让记忆真正进入工作流
    if (personaRaw || (persona.summary ?? '').trim()) {
      const summary = persona.summary?.trim()
      if (summary) {
        lines.push(`用户画像：${summary}`)
      }
    }
    // top 记忆（确认过的、高优先级 2 条）
    try {
      const recall = memoryService.searchAsText({ query: '', limit: 2, includeUnconfirmed: false })
      if (recall && !recall.startsWith('未找到')) {
        lines.push('近期记忆：')
        for (const line of recall.split('\n').filter((l) => l.trim()).slice(0, 4)) {
          lines.push(`  ${line.trim().slice(0, 120)}`)
        }
      }
    } catch {
      // 记忆检索失败不阻断
    }
    lines.push('（以上为主动推送，若与本会话无关可忽略）')
    console.log(lines.join('\n'))
  } catch (error) {
    // hook 失败不能影响宿主会话
    console.error('[today-push] 推送失败（已忽略）:', error instanceof Error ? error.message : error)
    console.log('')
  }
}

main()
