/**
 * Cursor HostAdapter 实现（M2）
 *
 * 依据（有据事实，2026-08-12 核验）：
 * - Cursor 官方声明支持加载 Claude Code hooks（.claude/settings.json 自动映射，
 *   设置中开启 Claude Code 兼容后自动接入）——来源：ProactiveAgent printToolGuide 与
 *   历史调研（README"Cursor 官方支持加载 Claude Code hooks 自动映射"）。
 * - Cursor 加载 Claude Code 兼容 hooks 时传入 camelCase 字段（sessionId/hookEventName）——
 *   detectTool 的 cursor 分支（事件宿主标签识别已实现）。
 * - 事件映射：SessionStart→sessionStart、UserPromptSubmit→beforeSubmitPrompt、Stop→stop。
 *
 * ⚠️ 待实测项（本机未安装 Cursor + 官方文档当前版本无 hooks 直达页）：
 * - 真实 Cursor 会话中 hooks 是否触发、stdout 注入行为、payload 字段确认
 * - 会话文件格式（readSession 暂返回空，能力声明 partial）
 * 能力矩阵诚实声明：未验证的标 partial + note，不伪造。
 */

import type { HostAdapter, HostHookInput, HostMessage } from './types'
import { renderTextSuggestion, renderTodayInjection } from './claude'

/** Cursor 会话读取：未知（会话文件格式未调研），返回空；收尾沉淀在 Cursor 下暂不可用 */
export function readCursorSession(_input: { sessionId?: string; cwd?: string }): { messages: HostMessage[]; path?: string } {
  return { messages: [] }
}

/** Cursor HostAdapter（能力矩阵：Claude Code hooks 兼容声明，本机待实测） */
export const cursorAdapter: HostAdapter = {
  id: 'cursor',
  capabilities: {
    hooks: { partial: '官方声明兼容 Claude Code hooks（.claude/settings.json 自动映射，需设置开启第三方钩子兼容）；本机未安装 Cursor，真实触发待实测' },
    resources: true,
    prompts: { partial: 'Claude Code 兼容层下 Prompts 行为待实测' },
    sessionRead: { partial: '会话文件格式未调研（readSession 暂返回空，收尾沉淀在 Cursor 下不可用）' },
    plugin: true,
    systemPrompt: { partial: '支持 .cursor/rules 与全局 rules；plugin systemPrompt 通道待实测' },
    midSessionInjection: 'stdout-text',
    inHostNotification: false,
  },
  hooks: {
    eventMap: {
      sessionStart: 'start',
      beforeSubmitPrompt: 'msg',
      stop: 'end',
    },
    configFormat: 'claude-settings',
    renderConfig(hooksDir, serverName) {
      // Cursor 复用 Claude Code 风格 hooks 配置（官方兼容映射）
      void serverName
      const q = (p: string) => (/\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)
      return JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: `node ${q(`${hooksDir}/today-push.js`)}` }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${q(`${hooksDir}/user-prompt.js`)}` }] }],
            Stop: [{ hooks: [{ type: 'command', command: `node ${q(`${hooksDir}/session-end.js`)}` }] }],
          },
        },
        null,
        2,
      )
    },
  },
  expression: {
    kind: 'stdout-text',
    // 与 Claude 同构（stdout 文本注入）；渲染复用 claude adapter
    renderSuggestion: renderTextSuggestion,
  },
  injection: {
    channel: 'hook-stdout',
    renderInjection: renderTodayInjection,
  },
  readSession: readCursorSession,
}

/** 宿主识别辅助：Cursor 事件 payload 校验（camelCase 字段存在即 cursor，兼容旧检测） */
export function looksLikeCursorInput(input: HostHookInput): boolean {
  return input.sessionId !== undefined || input.hookEventName !== undefined
}
