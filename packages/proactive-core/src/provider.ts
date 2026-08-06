/**
 * 外部宿主能力注入（proactive-core 宿主无关的关键）
 *
 * 引擎本体（memory/ + suggest/）不依赖任何宿主；少数需要"宿主能力"的
 * 点通过 provider 注入解耦：
 * - automationTitles：suggest 去重源。Proma Electron 注入真实 listAutomations；
 *   外部宿主（Claude Code / Cline / Cursor 等）不设 → 空列表，不阻断建议生成。
 */

let automationTitlesProvider: () => string[] = () => []

/** 设置 automation 标题提供者（仅 Proma Electron 需要；外部宿主可不设置） */
export function setAutomationTitlesProvider(p: () => string[]): void {
  automationTitlesProvider = p
}

/** 读取 automation 标题（去重源），provider 异常时安全降级为空 */
export function getAutomationTitles(): string[] {
  try {
    return automationTitlesProvider() ?? []
  } catch {
    return []
  }
}

// ===== 建议变更广播（Electron renderer 刷新用，外部宿主无需注册） =====
// 注：原先 core 内直接 require('@proma/shared') 广播 renderer，导致 bundle 内联
// AGPL 的 @proma/shared 实现代码（MIT 发布会 license 冲突）。改为 provider 注入后
// core 零 runtime 依赖 @proma/shared，Electron 通过 setSuggestionsChangedListener 注册真实广播。

let suggestionsChangedListener: (() => void) | null = null

/** 注册建议变更监听（Proma Electron 注入真实 renderer 广播；外部宿主可忽略） */
export function setSuggestionsChangedListener(listener: (() => void) | null): void {
  suggestionsChangedListener = listener
}

/** 触发建议变更广播（provider 未注册时安全 no-op） */
export function notifySuggestionsChangedProvider(): void {
  try {
    suggestionsChangedListener?.()
  } catch {
    // 广播失败不影响引擎主流程
  }
}

// ===== 建议动作执行器（M6：接受即执行） =====
// 宿主注入真实创建能力后，suggest_accept 不再只是"记录反馈"，而是真正创建
// automation/todo。外部宿主不注入 → 降级返回可执行指令文本（保持现状）。

/** 宿主动作执行结果 */
export interface HostActionResult {
  ok: boolean
  /** 创建后的引用 ID（如 automation id / todo id） */
  refId?: string
  /** 面向用户的反馈文本（"已创建任务 #12"） */
  message: string
}

/** 宿主执行器接口：M6 定义的最小契约 */
export interface HostActionExecutor {
  /** 创建定时任务（Kimi CronCreate / Proma automation / 其他宿主 API） */
  createAutomation?(input: {
    title: string
    prompt: string
    cron?: string
    dueAt?: number
  }): Promise<HostActionResult>
  /** 创建待办（宿主 todo 系统） */
  createTodo?(input: { title: string; notes?: string; dueAt?: number }): Promise<HostActionResult>
}

let actionExecutorProvider: (() => HostActionExecutor | null) | null = null

/** 注册宿主动作执行器提供者（宿主接入点；不注入则接受建议时降级为指令文本） */
export function setActionExecutorProvider(provider: (() => HostActionExecutor | null) | null): void {
  actionExecutorProvider = provider
}

/** 读取宿主执行器（无 provider 或异常 → null，调用方降级） */
export function getActionExecutor(): HostActionExecutor | null {
  try {
    return actionExecutorProvider?.() ?? null
  } catch {
    return null
  }
}
