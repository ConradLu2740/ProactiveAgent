/**
 * ProactiveAgent MCP Server — Resources
 *
 * 只读资源：
 * - memory://today    今日建议 + 热点场景（主动中心摘要）
 * - memory://stats    记忆统计
 * - memory://persona  L3 用户画像 markdown
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { memoryService, suggestService } from '@proactive-agent/core'

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    'proactive-today',
    'memory://today',
    {
      title: 'Proactive Today',
      description: '今日主动中心摘要：待处理建议 + 近期热点场景',
      mimeType: 'application/json',
    },
    async () => {
      const suggestions = suggestService.listSuggestionsForUI('suggested')
      const scenes = memoryService.getHotScenes({ limit: 5 })
      const payload = {
        generatedAt: new Date().toISOString(),
        suggestionCount: suggestions.length,
        suggestions: suggestions.map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          reason: r.reason,
          status: r.status,
        })),
        hotScenes: scenes.map((s) => ({
          title: s.title,
          heat: s.heat,
          atomCount: s.atomIds.length,
        })),
      }
      return {
        contents: [{ uri: 'memory://today', mimeType: 'application/json', text: safeJson(payload) }],
      }
    },
  )

  server.registerResource(
    'proactive-stats',
    'memory://stats',
    {
      title: 'Memory Stats',
      description: '记忆系统统计',
      mimeType: 'application/json',
    },
    async () => {
      return {
        contents: [
          { uri: 'memory://stats', mimeType: 'application/json', text: safeJson(memoryService.stats()) },
        ],
      }
    },
  )

  server.registerResource(
    'proactive-persona',
    'memory://persona',
    {
      title: 'User Persona',
      description: 'L3 用户画像 markdown（稳定的用户偏好/行为规则）',
      mimeType: 'text/markdown',
    },
    async () => {
      const persona = memoryService.personaRaw() ?? '尚未生成用户画像。'
      return { contents: [{ uri: 'memory://persona', mimeType: 'text/markdown', text: persona }] }
    },
  )
}
