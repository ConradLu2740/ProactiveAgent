/**
 * Claude Code SessionStart hook — 今日主动建议推送
 *
 * 在 Claude Code 会话开始时运行：如果 ProactiveAgent 有待处理建议或热点场景，
 * 输出文本注入会话上下文（Claude 会主动告知用户）；无内容则输出空（不打扰）。
 *
 * 安装（.claude/settings.json）：
 * ```json
 * { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun run /abs/path/today-push.ts" }] }] } }
 * ```
 *
 * 运行：bun run hooks/today-push.ts
 */

import { memoryService, suggestService } from '@proactive-agent/core'

function main(): void {
  try {
    const suggestions = suggestService.listSuggestionsForUI('suggested').slice(0, 5)
    const scenes = memoryService.getHotScenes({ limit: 3 })
    const persona = memoryService.personaRaw()

    if (suggestions.length === 0 && scenes.length === 0 && !persona) {
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
    if (persona) {
      lines.push('用户画像已就绪，可在合适时机调用 persona_get 读取。')
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
