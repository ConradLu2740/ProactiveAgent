/**
 * ProactiveAgent MCP Server — 工具注册
 *
 * 对外暴露的 Tools（pull 能力）：
 * - memory_capture / memory_recall / memory_extract / memory_pending / memory_confirm / memory_reject
 * - persona_get / scene_summary / memory_stats
 * - suggest_now / suggest_list / suggest_accept / suggest_ignore
 *
 * 所有 handler 返回 MCP CallToolResult（text 内容）。
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { memoryService, suggestService } from '@proactive-agent/core'
import { buildDailyReviewText, buildOnboardingText } from './prompts'

const MEMORY_TYPES = ['fact', 'preference', 'correction', 'sop', 'todo_context', 'event'] as const
const SUGGEST_STATUS = ['suggested', 'accepted', 'ignored', 'never'] as const

function text(msg: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: msg }] }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']).describe('消息角色'),
  content: z.string().describe('消息内容'),
})

export function registerTools(server: McpServer): void {
  // ===== 主动记忆：写入 =====

  server.registerTool(
    'memory_capture',
    {
      title: '记住一条记忆',
      description:
        '显式沉淀一条长期记忆（立即生效，进入召回）。适合用户明确表达偏好/事实/流程/纠正时主动调用。' +
        '内容应简洁、自包含、可独立理解。类型：fact 事实 / preference 偏好 / correction 纠正 / sop 流程 / todo_context 任务上下文 / event 事件。',
      inputSchema: {
        content: z.string().min(1).max(2000).describe('记忆内容'),
        type: z.enum(MEMORY_TYPES).default('fact').describe('记忆类型'),
        priority: z.number().int().min(0).max(100).optional().describe('重要度 0-100，默认 50'),
      },
    },
    async ({ content, type, priority }) => {
      try {
        const result = memoryService.captureCandidate(
          { content, type, priority },
          {},
          { confirmed: true },
        )
        return text(
          result.deduplicated
            ? `已合并到已有记忆（未新增）：[${result.atom.type}] ${result.atom.content}`
            : `已记住：[${result.atom.type}] ${result.atom.content}`,
        )
      } catch (error) {
        return text(`记忆写入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  )

  server.registerTool(
    'memory_extract',
    {
      title: '从对话中提取记忆',
      description:
        '把最近一段对话消息交给引擎自动提取记忆（LLM 或规则模式）。' +
        '提取结果默认 pending（待确认，防投毒），需要后续用 memory_pending + memory_confirm 确认。' +
        '适合宿主在会话结束钩子或定期把消息交给引擎。LLM 未配置时自动降级规则模式（零外发）。',
      inputSchema: {
        messages: z.array(messageSchema).min(1).max(100).describe('对话消息（按时间顺序）'),
        sessionId: z.string().optional().describe('来源会话 ID（可回溯）'),
      },
    },
    async ({ messages, sessionId }) => {
      try {
        const result = await memoryService.extractFromConversation({
          messages: messages as Array<{ role: 'user' | 'assistant'; content: string }>,
          sessionId,
        })
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
      title: '检索记忆',
      description:
        '按关键词检索长期记忆（keyword + embedding 混合，embedding 不可用时降级 keyword）。' +
        '返回匹配的记忆条目、类型、重要度与相似度。适合在任何任务开始时检索相关上下文注入。',
      inputSchema: {
        query: z.string().min(1).describe('检索关键词/问题'),
        limit: z.number().int().min(1).max(20).default(5).describe('返回条数上限，默认 5'),
        type: z.enum(MEMORY_TYPES).optional().describe('按类型过滤'),
      },
    },
    async ({ query, limit, type }) => {
      try {
        const result = await memoryService.searchAsync({ query, limit, type })
        if (result.hits.length === 0) return text('未找到相关记忆。')
        const lines = result.hits.map((h, i) => {
          const atom = h.atom
          const meta = atom.confirmed ? '' : '（待确认）'
          return `${i + 1}. [${atom.type}]${meta} ${atom.content} (优先级 ${atom.priority}, 相关度 ${(h.score * 100).toFixed(0)}%)`
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
      title: '待确认记忆与纠正',
      description:
        '列出自动提取但尚未确认的内容（防投毒：需用户确认后才进入召回）。两类：\n' +
        '1. 待确认记忆（atom）：用 memory_confirm / memory_reject 处理\n' +
        '2. 待确认行为纠正（correction）：用 correction_confirm / correction_reject 处理',
      inputSchema: {},
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
      title: '确认记忆',
      description: '确认一条待确认记忆（确认后进入召回；correction/preference/sop 类型会同步刷新用户画像）。',
      inputSchema: { id: z.string().describe('记忆 ID（来自 memory_pending）') },
    },
    async ({ id }) => {
      const atom = memoryService.confirmAtomById(id)
      return atom ? text(`已确认：[${atom.type}] ${atom.content}`) : text(`未找到记忆 ${id}`)
    },
  )

  server.registerTool(
    'memory_reject',
    {
      title: '拒绝记忆',
      description: '拒绝并删除一条待确认记忆（错误提取或投毒内容）。',
      inputSchema: { id: z.string().describe('记忆 ID（来自 memory_pending）') },
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
      title: '读取用户画像',
      description: '读取 L3 用户画像 markdown（稳定的用户偏好/行为规则摘要）。适合宿主注入系统提示或初始化上下文。',
      inputSchema: {},
    },
    async () => {
      const persona = memoryService.personaRaw()
      return persona ? text(persona) : text('尚未生成用户画像。')
    },
  )

  server.registerTool(
    'scene_summary',
    {
      title: '近期热点场景',
      description: '读取最近热点场景摘要（主动性的时机信号：最近在做什么、热度多高）。',
      inputSchema: { limit: z.number().int().min(1).max(10).default(3).describe('返回场景数，默认 3') },
    },
    async ({ limit }) => {
      const summary = memoryService.hotScenesSummary(limit)
      return summary ? text(summary) : text('暂无热点场景。')
    },
  )

  server.registerTool(
    'memory_stats',
    {
      title: '记忆统计',
      description: '查看记忆系统统计（atom 数量、类型分布、待确认、画像状态）。',
      inputSchema: {},
    },
    async () => {
      const s = memoryService.stats()
      return text(safeJson(s))
    },
  )

  // ===== 主动建议 =====

  server.registerTool(
    'suggest_now',
    {
      title: '评估是否产生建议',
      description:
        '评估一段会话消息是否值得给出主动建议（correction 纠正 / followup 跟进 / automation 自动化 / skill 技能 / todo 待办）。' +
        '核心原则：该沉默时沉默。单次最多 1 条，同会话有预算限制，免打扰时段不产生。返回本次新增建议（可能为空）。',
      inputSchema: {
        messages: z.array(messageSchema).min(1).max(200).describe('本会话的对话消息（按时间顺序）'),
        sessionId: z.string().optional().describe('会话 ID（用于预算去重）'),
      },
    },
    async ({ messages, sessionId }) => {
      try {
        const records = await suggestService.evaluateSessionSuggestions(
          messages as Array<{ role: string; content: string }>,
          { sessionId },
        )
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
      title: '列出建议',
      description: '列出建议记录，可按状态过滤（suggested 待处理 / accepted 已接受 / ignored 已忽略 / never 永不建议）。',
      inputSchema: { status: z.enum(SUGGEST_STATUS).optional().describe('状态过滤') },
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
      title: '接受建议',
      description: '接受一条建议。对 memory_correction 类型会直接写入行为纠正并回流用户画像（用户点接受 = 明确认可）。',
      inputSchema: { id: z.string().describe('建议 ID（来自 suggest_now / suggest_list）') },
    },
    async ({ id }) => {
      const result = suggestService.handleSuggestionFeedback(id, 'accepted')
      return result.ok ? text(`已接受建议 ${id}。`) : text(`接受失败：${result.error ?? '未知错误'}`)
    },
  )

  server.registerTool(
    'suggest_ignore',
    {
      title: '忽略建议',
      description: '忽略一条建议（计入频率学习：同类建议权重收敛；多次忽略后该类型自动静默）。',
      inputSchema: { id: z.string().describe('建议 ID（来自 suggest_now / suggest_list）') },
    },
    async ({ id }) => {
      const result = suggestService.handleSuggestionFeedback(id, 'ignored')
      return result.ok ? text(`已忽略建议 ${id}。`) : text(`忽略失败：${result.error ?? '未知错误'}`)
    },
  )

  server.registerTool(
    'correction_confirm',
    {
      title: '确认行为纠正',
      description:
        '确认一条待确认的行为纠正（来自 corrections.json，通常是 memory_extract 规则模式提取）。' +
        '确认后生效：写入 correction 记忆并回流用户画像。ID 来自 memory_pending 返回的 correction 条目。',
      inputSchema: { id: z.string().describe('纠正 ID（来自 memory_pending）') },
    },
    async ({ id }) => {
      const ok = memoryService.confirmCorrection(id)
      return ok ? text(`已确认纠正 ${id}（已写入记忆并回流画像）。`) : text(`未找到纠正 ${id}`)
    },
  )

  server.registerTool(
    'correction_reject',
    {
      title: '拒绝行为纠正',
      description:
        '拒绝一条待确认的行为纠正（错误提取或投毒内容）。' +
        'ID 来自 memory_pending 返回的 correction 条目。',
      inputSchema: { id: z.string().describe('纠正 ID（来自 memory_pending）') },
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
      title: '每日复盘模板',
      description:
        '生成每日复盘指引：把今天的工作整理为长期记忆并生成改进建议。' +
        '返回的模板文本会引导你按步骤调用 memory_recall / memory_extract / scene_summary / suggest_now 完成复盘。' +
        '适合会话结束时或每日定时触发。',
      inputSchema: { date: z.string().optional().describe('复盘日期（默认今天）') },
    },
    async ({ date }) => {
      return text(buildDailyReviewText(date))
    },
  )

  server.registerTool(
    'onboarding_guide',
    {
      title: 'ProactiveAgent 使用说明',
      description:
        '冷启动说明：教会本会话如何用好 ProactiveAgent 的记忆与建议工具（何时用 memory_capture/recall/extract、' +
        '如何确认待确认记忆、克制原则）。新环境/新项目第一次挂载时调用一次。',
      inputSchema: {},
    },
    async () => {
      return text(buildOnboardingText())
    },
  )
}
