/**
 * HostAdapter 统一接口（M1：harness 适配层核心）
 *
 * 设计依据：.context/pa-harness-adapter-design.md（2026-08-12）
 * - 5 维度：感知 Perception / 表达 Expression / 上下文注入 Injection / 会话读取 SessionRead / 配置分发 Distribution
 * - capabilities 能力矩阵（参考 jido_harness AdapterSpec / harnery profile）：
 *   判断逻辑用能力而非宿主名，诚实声明不伪造；partial 必须带 note。
 *
 * 2026-08-12 参考项目对照（harness-adapter 工作区 docs/harness-adapter-reference.md）：
 * - jido_harness：AdapterSpec 元数据即验证、29 种规范事件、provider_event 逃生口
 * - harnery：19 维能力声明、env 删除而非置空、timedOut 独立标记
 * - agent-harness：plugin 定协议 / adapter 定覆盖 / artifacts 记事实
 */

/** 宿主标识（与 event-store AgentTool 对齐，+ 'proma' 内嵌宿主） */
export type HostId = 'claude' | 'kimi' | 'cursor' | 'cline' | 'codex' | 'continue' | 'proma'

/** 能力值：true / false / partial（必须带 note 说明限制） */
export type Capability = boolean | { partial: string }

/** 宿主能力矩阵：判断逻辑用能力而非宿主名 */
export interface HostCapabilities {
  /** hooks 事件（SessionStart/UserPromptSubmit/SessionEnd…） */
  hooks: Capability
  /** MCP Resources 支持（Kimi ❌ → 提示词/模板不得引用 memory://*） */
  resources: Capability
  /** MCP Prompts 支持（Kimi ❌ → 模板能力必须同时暴露为 tools） */
  prompts: Capability
  /** 会话记录读取（transcript JSONL / wire.jsonl） */
  sessionRead: Capability
  /** 插件/市场分发（plugin zip / marketplace） */
  plugin: Capability
  /** systemPrompt 注入通道（plugin systemPrompt / CLAUDE.md / rules 文件） */
  systemPrompt: Capability
  /** 会话中建议注入通道 */
  midSessionInjection: 'stdout-text' | 'notification-xml' | 'banner-event' | false
  /** 宿主内通知（非 daemon 桌面通知） */
  inHostNotification: Capability
}

/** 会话消息（统一格式） */
export interface HostMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 建议记录（表达渲染输入，SuggestionRecord 的子集） */
export interface HostSuggestion {
  id: string
  kind: string
  title: string
  reason: string
}

/** 注入上下文（会话开始画像/建议/场景渲染输入） */
export interface InjectionContext {
  suggestions: HostSuggestion[]
  scenes: Array<{ title: string; heat: number }>
  personaSummary: string
  topMemories: string[]
}

/** hooks 事件映射：宿主事件名 → PA 事件类型 */
export type HostEventMap = Record<string, 'start' | 'msg' | 'end' | 'commit' | 'notify' | 'handle'>

/** 统一宿主适配器（@proactive-agent/adapters 目标形态） */
export interface HostAdapter {
  id: HostId
  /** 能力矩阵（诚实声明，不伪造） */
  capabilities: HostCapabilities

  /** 感知：hooks 事件名 → PA 事件类型映射 */
  hooks: {
    eventMap: HostEventMap
    /** hooks 配置文件格式 */
    configFormat: 'toml' | 'json' | 'claude-settings'
    /** 生成 hooks 配置片段（指向 adapter 脚本） */
    renderConfig(hooksDir: string, serverName: string): string
  }

  /** 表达：PA 建议如何注入会话 */
  expression: {
    kind: 'stdout-text' | 'notification-xml' | 'banner-event'
    /** 渲染一条（组）建议为宿主可消费的注入内容；无内容返回空字符串（该沉默时沉默） */
    renderSuggestion(records: HostSuggestion[]): string
  }

  /** 上下文注入：会话开始时给模型注入画像/建议 */
  injection: {
    channel: 'hook-stdout' | 'system-prompt' | 'rules-file'
    /** 渲染注入内容；无内容返回空字符串（不打扰） */
    renderInjection(ctx: InjectionContext): string
  }

  /** 会话读取：定位并解析会话记录（收尾沉淀用） */
  readSession(input: { sessionId?: string; cwd?: string }): { messages: HostMessage[]; path?: string }
}

/** hooks 脚本 stdin 输入（跨宿主字段集；用于宿主识别与参数透传） */
export interface HostHookInput {
  prompt?: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  /** Kimi 注入的会话事实（snake_case：is_steer 存在 = Kimi externalHooks） */
  is_steer?: boolean
  session_title?: string
  /** Kimi 事件基座字段（0.35：hook_event_name/session_id/client_type） */
  client_type?: string
  /** Cursor 加载 Claude Code 兼容 hooks 时传入（camelCase） */
  sessionId?: string
  hookEventName?: string
}

/** 从 hooks stdin 输入判断宿主（P1-1：Cursor 兼容 Claude Code hooks 时避免全部标记为 claude） */
export function detectHostId(input: HostHookInput): HostId {
  if (input.is_steer !== undefined || input.client_type === 'kimi_code_cli') return 'kimi'
  if (input.sessionId !== undefined || input.hookEventName !== undefined) return 'cursor'
  return 'claude'
}
