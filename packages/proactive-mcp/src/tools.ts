/**
 * ProactiveAgent MCP Server — 工具注册
 *
 * 对外暴露的 Tools（pull 能力）：
 * - memory_capture / memory_recall / memory_extract / memory_pending / memory_confirm / memory_reject
 * - persona_get / scene_summary / memory_stats
 * - suggest_now / suggest_list / suggest_accept / suggest_ignore
 * - card_list / card_get（统一 ActionCard 协议视图）
 *
 * 所有 handler 返回 MCP CallToolResult（text 内容）。
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { memoryService, suggestService, isEscapeGlobal } from '@proactive-agent/core'
import { buildDailyReviewText, buildOnboardingText } from './prompts'
import { normalizeWriteScope, normalizeReadScope } from './scope'

const MEMORY_TYPES = ['fact', 'preference', 'correction', 'sop', 'todo_context', 'event'] as const
const SUGGEST_STATUS = ['suggested', 'accepted', 'ignored', 'never'] as const
const WRITE_SCOPES = ['project', 'global'] as const
const READ_SCOPES = ['auto', 'project', 'global'] as const

/** 展示层标签：逃生模式时统一显示 global（🟡-5 修复，避免误导） */
function displayScope(scope?: string): string {
  if (isEscapeGlobal()) return 'global（逃生单层）'
  return scope ?? 'project'
}

function text(msg: string): {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: { text: string }
} {
  return { content: [{ type: 'text', text: msg }], structuredContent: { text: msg } }
}

/** 所有工具统一返回的 text 结果 schema（供 outputSchema 声明，提升目录质量分） */
const textResultSchema = z.object({
  text: z.string(),
})

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']).describe('Message role'),
  content: z.string().describe('Message content'),
})

export function registerTools(server: McpServer): void {
  // ===== 主动记忆：写入 =====

  server.registerTool(
    'memory_capture',
        {
      title: 'Capture a memory',
      description:
        'Explicitly store a long-term memory (takes effect immediately, enters recall). ' +
        'Use when the user clearly expresses a preference/fact/process/correction. ' +
        'Keep content concise, self-contained, and independently understandable. ' +
        'Types: fact / preference / correction / sop / todo_context / event.',
      inputSchema: {
        content: z
          .string()
          .min(1)
          .max(2000)
          .describe('Memory content. Keep negations intact: e.g. "不要用 X" must be stored as-is, never drop 不/不要/别'),
        type: z.enum(MEMORY_TYPES).default('fact').describe('Memory type'),
        priority: z.number().int().min(0).max(100).optional().describe('Importance 0-100, default 50'),
        scope: z.enum(WRITE_SCOPES).optional().describe('Write scope: project (default) / global'),
      },
      outputSchema: textResultSchema,
      annotations: {"idempotentHint": true},
    },
    async ({ content, type, priority, scope }) => {
      try {
        const result = memoryService.captureCandidate(
          { content, type, priority },
          { scope: normalizeWriteScope(scope) },
          { confirmed: true },
        )
        return text(
          result.deduplicated
            ? `已合并到已有记忆（未新增）：[${result.atom.type}] ${result.atom.content}${result.atom.scope ? `（${displayScope(result.atom.scope)} 层）` : ''}`
            : `已记住（${displayScope(result.atom.scope)} 层）：[${result.atom.type}] ${result.atom.content}`,
        )
      } catch (error) {
        return text(`记忆写入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  )

  server.registerTool(
    'memory_extract',
        {
      title: 'Extract memories from conversation',
      description:
        'Feed recent conversation messages to the engine for automatic memory extraction (LLM or rule mode). ' +
        'Extracted items default to pending (anti-poisoning), confirm via memory_pending + memory_confirm. ' +
        'Suitable for host session-end hooks or periodic extraction. Falls back to rule mode (zero external calls) when LLM is not configured.',
      inputSchema: {
        messages: z.array(messageSchema).min(1).max(100).describe('Conversation messages (chronological)'),
        sessionId: z.string().optional().describe('Source session ID (for traceability)'),
        scope: z.enum(WRITE_SCOPES).optional().describe('Candidate write scope: project (default) / global'),
      },
      outputSchema: textResultSchema,
      annotations: {"idempotentHint": true},
    },
    async ({ messages, sessionId, scope }) => {
      try {
        const result = await memoryService.extractFromConversation({
          messages: messages as Array<{ role: 'user' | 'assistant'; content: string }>,
          sessionId,
          scope: normalizeWriteScope(scope),
        } as never)
        if (result.mode === 'none') {
          return text('未提取到记忆（提取模式为 off 或无有效消息）。')
        }
        return text(
          `提取完成 mode=${result.mode}：新增 ${result.storedCount} 条（待确认），纠正候选 ${result.corrections} 条。\n` +
            `待确认列表请用 memory_pending 查看。`,
        )
      } catch (error) {
        return text(`提取失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  )

  // ===== 主动记忆：检索 =====

  server.registerTool(
    'memory_recall',
        {
      title: 'Recall memories',
      description:
        'Search long-term memories by keywords (keyword + embedding hybrid; falls back to keyword when embedding is unavailable). ' +
        'Returns matching entries with type, importance, and similarity. Use at the start of any task to inject relevant context.',
      inputSchema: {
        query: z.string().min(1).describe('Search keyword/question'),
        limit: z.number().int().min(1).max(20).default(5).describe('Max results, default 5'),
        type: z.enum(MEMORY_TYPES).optional().describe('Filter by type'),
        scope: z.enum(READ_SCOPES).optional().describe('Read scope: auto merged (default) / project / global'),
      },
      outputSchema: textResultSchema,
      annotations: {"readOnlyHint": true, "idempotentHint": true},
    },
    async ({ query, limit, type, scope }) => {
      try {
        const result = await memoryService.searchAsync({ query, limit, type, scope: normalizeReadScope(scope) })
        if (result.hits.length === 0) return text('未找到相关记忆。')
        const lines = result.hits.map((h, i) => {
          const atom = h.atom
          const meta = atom.confirmed ? '' : '（待确认）'
          const shared = h.scope === 'global' || atom.scope === 'global' ? ' [shared]' : ''
          return `${i + 1}. [${atom.type}]${meta}${shared} ${atom.content} (优先级 ${atom.priority}, 相关度 ${(h.score * 100).toFixed(0)}%)`
        })
        return text(`相关记忆（${result.hits.length} 条）：\n` + lines.join('\n'))
      } catch (error) {
        return text(`检索失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  )

  server.registerTool(
    'memory_pending',
        {
      title: 'Pending memories & corrections',
      description:
        'List automatically extracted but unconfirmed items (anti-poisoning: only enter recall after user confirmation). Two kinds:\n' +
        '1. Pending memories (atom): handle with memory_confirm / memory_reject\n' +
        '2. Pending corrections: handle with correction_confirm / correction_reject',
      inputSchema: {},
      outputSchema: textResultSchema,
      annotations: {"readOnlyHint": true, "idempotentHint": true},
    },
    async () => {
      const pending = memoryService.pendingAtoms()
      const pendingCorrections = memoryService.corrections('pending')
      const lines: string[] = []
      if (pending.length > 0) {
        lines.push(`待确认记忆（${pending.length} 条）：`)
        for (const a of pending) {
          lines.push(`- atom ${a.id} [${a.type}] ${a.content}（确认: memory_confirm, 拒绝: memory_reject）`)
        }
      }
      if (pendingCorrections.length > 0) {
        lines.push(`待确认行为纠正（${pendingCorrections.length} 条）：`)
        for (const c of pendingCorrections) {
          lines.push(`- correction ${c.id} ${c.rule}（确认: correction_confirm, 拒绝: correction_reject）`)
        }
      }
      if (lines.length === 0) return text('没有待确认的记忆或纠正。')
      return text(lines.join('\n'))
    },
  )

  server.registerTool(
    'memory_confirm',
        {
      title: 'Confirm memory',
      description: 'Confirm a pending memory (enters recall; correction/preference/sop types also refresh the user persona).',
      inputSchema: { id: z.string().describe('Memory ID (from memory_pending)') },
      outputSchema: textResultSchema,
      annotations: {"idempotentHint": true},
    },
    async ({ id }) => {
      const atom = memoryService.confirmAtomById(id)
      return atom ? text(`已确认：[${atom.type}] ${atom.content}`) : text(`未找到记忆 ${id}`)
    },
  )

  server.registerTool(
    'memory_reject',
        {
      title: 'Reject memory',
      description: 'Reject and delete a pending memory (incorrect extraction or poisoned content).',
      inputSchema: { id: z.string().describe('Memory ID (from memory_pending)') },
      outputSchema: textResultSchema,
      annotations: {"destructiveHint": true, "idempotentHint": true},
    },
    async ({ id }) => {
      const ok = memoryService.rejectAtomById(id)
      return text(ok ? `已删除记忆 ${id}` : `未找到记忆 ${id}`)
    },
  )

  // ===== 主动记忆：画像 / 场景 / 统计 =====

  server.registerTool(
    'persona_get',
        {
      title: 'Get user persona',
      description:
        'Read the L3 user persona markdown (stable summary of user preferences/behavior rules). ' +
        'Suitable for injecting into system prompts or initialization context. ' +
        'Returns the merged view by default (global base persona + current project overrides, with per-line scope).',
      inputSchema: {
        scope: z.enum(READ_SCOPES).optional().describe('Read scope: auto merged (default) / project / global'),
      },
      outputSchema: textResultSchema,
      annotations: {"readOnlyHint": true, "idempotentHint": true},
    },
    async ({ scope }) => {
      const persona = memoryService.personaRaw(normalizeReadScope(scope) as 'auto' | 'project' | 'global')
      if (!persona) return text('尚未生成用户画像。')
      // P2-4：超载提示与 persona 原文分离，避免污染注入内容；提示只出现在详情 JSON
      const overload = memoryService.personaOverloadHint()
      const detail = overload.overloaded
        ? `\n⚠️ 画像已超载（${overload.lineCount} 行 / ${overload.sectionCount} 章节），建议用 persona_save 精简重整。${overload.hint}`
        : ''
      return {
        content: [{ type: 'text', text: persona }],
        structuredContent: { text: persona, overloaded: overload.overloaded, reorganizationHint: detail.trim() },
      }
    },
  )

  server.registerTool(
    'persona_save',
        {
      title: 'Save user persona',
      description:
        'Manually save/overwrite persona markdown. Defaults to the current project layer (overrides that project part of the merged view); ' +
        'scope=global writes the global base persona. For maintaining the persona or project-specific behavior rules.',
      inputSchema: {
        content: z.string().min(1).max(10000).describe('Persona markdown content'),
        scope: z.enum(WRITE_SCOPES).optional().describe('Write scope: project (default) / global'),
      },
      outputSchema: textResultSchema,
      annotations: {"idempotentHint": true},
    },
    async ({ content, scope }) => {
      try {
        memoryService.savePersona(content, normalizeWriteScope(scope))
        return text(`已保存画像（${normalizeWriteScope(scope)} 层）。`)
      } catch (error) {
        return text(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  )

  server.registerTool(
    'scene_summary',
        {
      title: 'Recent hot scenes',
      description: 'Read recent hot-scene summaries (timing signal for proactivity: what is being worked on recently, how hot).',
      inputSchema: { limit: z.number().int().min(1).max(10).default(3).describe('Number of scenes, default 3') },
      outputSchema: textResultSchema,
      annotations: {"readOnlyHint": true, "idempotentHint": true},
    },
    async ({ limit }) => {
      const summary = memoryService.hotScenesSummary(limit)
      if (!summary) return text('暂无热点场景。')
      // 人话化：heat 是近 7 天该场景相关记忆出现次数，atoms 是该场景关联记忆条数
      const lines = summary
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const m = l.match(/^- \[(.*?)\] heat=(\d+) atoms=(\d+)$/)
          if (!m) return l
          const title = m[1].trim().length > 40 ? m[1].trim().slice(0, 38) + '…' : m[1].trim()
          return `- ${title}（近 7 天出现 ${m[2]} 次，关联 ${m[3]} 条记忆）`
        })
      return text(`近期热点场景（${lines.length} 个）：\n` + lines.join('\n'))
    },
  )

  server.registerTool(
    'memory_stats',
        {
      title: 'Memory stats',
      description: 'View memory system statistics (atom count, type distribution, pending items, persona status).',
      inputSchema: {},
      outputSchema: textResultSchema,
      annotations: {"readOnlyHint": true, "idempotentHint": true},
    },
    async () => {
      const s = memoryService.stats()
      const activity = memoryService.memoryActivity()
      const review = memoryService.memoryReviewOpportunity()
      const parts: string[] = [`共 ${s.atomCount} 条记忆`]
      const byType = s.byType as Record<string, number>
      const typeLabels: Record<string, string> = {
        preference: '偏好',
        fact: '事实',
        correction: '行为纠正',
        sop: '流程',
        todo_context: '待办上下文',
        event: '事件',
      }
      const typeSummary = Object.entries(byType)
        .filter(([, n]) => (n as number) > 0)
        .map(([k, n]) => `${typeLabels[k] ?? k} ${n}`)
      if (typeSummary.length) parts.push(typeSummary.join('、'))
      parts.push(s.sceneCount > 0 ? `热点场景 ${s.sceneCount} 个` : '暂无热点场景')
      const pendingTotal = (s.pendingAtoms ?? 0) + (s.pendingCorrections ?? 0)
      parts.push(pendingTotal > 0 ? `待确认 ${pendingTotal} 条` : '无待确认')
      parts.push(s.personaExists ? '画像已生成' : '画像未生成')
      parts.push(`记忆${activity.daysSinceLastUpdate === 0 ? '今天有更新' : `${activity.daysSinceLastUpdate} 天未更新（今日 ${activity.todayEntries} 条动态）`}`)
      const oneLine = parts.join(' · ')
      const jsonDetail = { ...s, activity, review }
      return text(`${oneLine}${review ? '\n' + review.message : ''}\n详情（JSON）：${safeJson(jsonDetail)}`)
    },
  )

  // ===== 主动建议 =====

  server.registerTool(
    'suggest_now',
        {
      title: 'Evaluate suggestions',
      description:
        'Evaluate whether a conversation excerpt deserves proactive suggestions (correction / followup / automation / skill / todo). ' +
        'Core principle: silence is also a skill. At most 1 per call, session budget limits, none during do-not-disturb hours. ' +
        'Returns newly created suggestions (may be empty). ' +
        'trigger: session_end (default) / session_mid (realtime, strong signals only, max 1) / manual.',
      inputSchema: {
        messages: z.array(messageSchema).min(1).max(200).describe('Conversation messages (chronological)'),
        sessionId: z.string().optional().describe('Session ID (for budget dedup)'),
        trigger: z
          .enum(['session_end', 'session_mid', 'manual'])
          .optional()
          .describe('Trigger point: session_end=end of session (default) / session_mid=realtime (strong signals only) / manual'),
      },
      outputSchema: textResultSchema,
      annotations: {"idempotentHint": true},
    },
    async ({ messages, sessionId, trigger }) => {
      try {
        // P1-1：暴露 evaluateNow trigger，让宿主动态控制评估时机（不只 session_end 语义）
        const records = await suggestService.evaluateNow({
          trigger: trigger ?? 'session_end',
          sessionId,
          messages: messages as Array<{ role: string; content: string }>,
        })
        if (records.length === 0) return text('本次评估无新建议（该沉默时沉默）。')
        const r = records[0]
        return text(
          `新建议（${r.kind}）：${r.title}\n${r.reason}\n` +
            `建议 ID：${r.id}（接受: suggest_accept, 忽略: suggest_ignore）`,
        )
      } catch (error) {
        return text(`建议评估失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  )

  server.registerTool(
    'suggest_list',
        {
      title: 'List suggestions',
      description: 'List suggestion records, filterable by status (suggested / accepted / ignored / never).',
      inputSchema: { status: z.enum(SUGGEST_STATUS).optional().describe('Status filter') },
      outputSchema: textResultSchema,
      annotations: {"readOnlyHint": true, "idempotentHint": true},
    },
    async ({ status }) => {
      const records = suggestService.listSuggestionsForUI(status)
      if (records.length === 0) return text('暂无建议记录。')
      const lines = records.slice(0, 50).map(
        (r) => `- [${r.status}] ${r.id} (${r.kind}) ${r.title} — ${r.reason}`,
      )
      return text(`建议记录（${records.length} 条）：\n` + lines.join('\n'))
    },
  )

  server.registerTool(
    'suggest_accept',
        {
      title: 'Accept suggestion',
      description:
        'Accept a suggestion. For memory_correction types, writes a behavior correction and refreshes the persona (accept = explicit approval). ' +
        'For automation/todo types, tries to actually create it (requires host-injected executor), otherwise returns executable instructions. ' +
        'Pass host to label the current host (e.g. claude-code / kimi) for fallback wording.',
      inputSchema: {
        id: z.string().describe('Suggestion ID (from suggest_now / suggest_list)'),
        host: z.string().optional().describe('Current host name (claude-code / kimi / cline / cursor / proma) for fallback wording'),
      },
      outputSchema: textResultSchema,
      annotations: {"idempotentHint": true},
    },
    async ({ id, host }) => {
      const result = await suggestService.handleSuggestionFeedback(id, 'accepted', { host: host ?? 'mcp' })
      if (!result.ok) return text(`接受失败：${result.error ?? '未知错误'}`)
      // M6：返回动作执行结果（"已创建定时任务 #xxx" / 降级指令），不再只是"已记录"
      const execMsg = result.result?.message ? `\n${result.result.message}` : ''
      return text(`已接受建议 ${id}。${execMsg}`)
    },
  )

  server.registerTool(
    'suggest_ignore',
        {
      title: 'Ignore suggestion',
      description: 'Ignore a suggestion (counts toward frequency learning: similar suggestions converge in weight; repeated ignores auto-silence that type).',
      inputSchema: { id: z.string().describe('Suggestion ID (from suggest_now / suggest_list)') },
      outputSchema: textResultSchema,
      annotations: {"idempotentHint": true},
    },
    async ({ id }) => {
      const result = await suggestService.handleSuggestionFeedback(id, 'ignored')
      return result.ok ? text(`已忽略建议 ${id}。`) : text(`忽略失败：${result.error ?? '未知错误'}`)
    },
  )

  server.registerTool(
    'card_list',
    {
      title: 'List action cards',
      description:
        'List unified ActionCards (cross-source action inbox). Current source is suggestion engine; future agent / automation / bridge sources land here. ' +
        'Card status uses unified semantics: pending / accepted / dismissed / resolved.',
      inputSchema: { status: z.enum(['pending', 'accepted', 'dismissed', 'resolved']).optional().describe('Card status filter') },
      outputSchema: textResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ status }) => {
      const cards = suggestService.listActionCards(status)
      if (cards.length === 0) return text('暂无待处理卡片。')
      const shown = cards.slice(0, 50)
      const lines = shown.map(
        (c) =>
          `- [${c.status}] [${c.priority}] ${c.id} (${c.source}) ${c.title} — ${c.summary}${c.expiresAt ? ` (过期: ${new Date(c.expiresAt).toLocaleString()})` : ''}`,
      )
      const suffix = cards.length > shown.length ? `（仅显示前 50 条，共 ${cards.length} 条）` : ''
      return text(`ActionCards（${cards.length} 条）：\n` + lines.join('\n') + suffix)
    },
  )

  server.registerTool(
    'card_get',
    {
      title: 'Get action card detail',
      description: 'Get a single ActionCard by id with full fields (source / priority / target / privacy / duplicateKey / evidence).',
      inputSchema: { id: z.string().describe('ActionCard id (from card_list)') },
      outputSchema: textResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const card = suggestService.getActionCardById(id)
      if (!card) return text(`未找到卡片 ${id}`)
      const lines = [
        `卡片 ${card.id}`,
        `- source: ${card.source}`,
        `- title: ${card.title}`,
        `- summary: ${card.summary}`,
        `- priority: ${card.priority}`,
        `- status: ${card.status}`,
        `- privacy: ${card.privacy}`,
        `- allowedActions: ${card.allowedActions.join(', ') || '无'}`,
        `- target: ${card.target ? `${card.target.kind}:${card.target.id}` : '无'}`,
        `- duplicateKey: ${card.duplicateKey}`,
        `- evidence: ${card.evidence ?? '无'}`,
        `- expiresAt: ${card.expiresAt ? new Date(card.expiresAt).toLocaleString() : '无'}`,
        `- feedbackAt: ${card.feedbackAt ? new Date(card.feedbackAt).toLocaleString() : '无'}`,
        `- createdAt: ${new Date(card.createdAt).toLocaleString()}`,
      ]
      return text(lines.join('\n'))
    },
  )

  server.registerTool(
    'correction_confirm',
        {
      title: 'Confirm behavior correction',
      description:
        'Confirm a pending behavior correction (from corrections.json, usually extracted by memory_extract rule mode). ' +
        'On confirmation: writes a correction memory and refreshes the persona. ID comes from memory_pending correction entries.',
      inputSchema: { id: z.string().describe('Correction ID (from memory_pending)') },
      outputSchema: textResultSchema,
      annotations: {"idempotentHint": true},
    },
    async ({ id }) => {
      const ok = memoryService.confirmCorrection(id)
      return ok ? text(`已确认纠正 ${id}（已写入记忆并回流画像）。`) : text(`未找到纠正 ${id}`)
    },
  )

  server.registerTool(
    'correction_reject',
        {
      title: 'Reject behavior correction',
      description:
        'Reject a pending behavior correction (incorrect extraction or poisoned content). ' +
        'ID comes from memory_pending correction entries.',
      inputSchema: { id: z.string().describe('Correction ID (from memory_pending)') },
      outputSchema: textResultSchema,
      annotations: {"destructiveHint": true, "idempotentHint": true},
    },
    async ({ id }) => {
      const ok = memoryService.rejectCorrection(id)
      return ok ? text(`已拒绝纠正 ${id}。`) : text(`未找到纠正 ${id}`)
    },
  )

  // ===== 模板能力（Kimi 等只支持 Tools 的宿主也可用） =====

  server.registerTool(
    'daily_review',
        {
      title: 'Daily review',
      description:
        'Generate a daily review guide: organize today\'s work into long-term memories and generate improvement suggestions. ' +
        'The returned template guides you through memory_recall / memory_extract / scene_summary / suggest_now. ' +
        'Suitable at session end or on a daily schedule.',
      inputSchema: { date: z.string().optional().describe('Review date (default today)') },
      outputSchema: textResultSchema,
      annotations: {"readOnlyHint": true, "idempotentHint": true},
    },
    async ({ date }) => {
      return text(buildDailyReviewText(date))
    },
  )

  server.registerTool(
    'onboarding_guide',
        {
      title: 'Onboarding guide',
      description:
        'Cold-start guide: teaches this session how to use ProactiveAgent memory & suggestion tools (when to use memory_capture/recall/extract, ' +
        'how to confirm pending memories, restraint principle). Call once on first mount in a new environment/project.',
      inputSchema: {},
      outputSchema: textResultSchema,
      annotations: {"readOnlyHint": true, "idempotentHint": true},
    },
    async () => {
      return text(buildOnboardingText())
    },
  )
}
