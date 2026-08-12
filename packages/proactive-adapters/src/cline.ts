/**
 * Cline HostAdapter 实现（M3）
 *
 * 依据（有据事实，2026-08-12）：
 * - Cline hooks 走 SDK Plugins 机制（官方文档）；或任意支持命令回调的工具指向
 *   dist/hooks/event-capture.js（ProactiveAgent 通用事件入口）。
 * - 感知维度通过 event-capture 统一协议接入：stdin { event, tool: "cline", ... }。
 *
 * ⚠️ 待实测：本机未安装 Cline；hooks 命令回调真实触发、payload 字段待实测。
 * 能力矩阵诚实声明，不伪造。
 */

import type { HostAdapter, HostHookInput, HostMessage } from './types'

/** Cline 会话读取：未调研（返回空，收尾沉淀在 Cline 下不可用） */
export function readClineSession(_input: { sessionId?: string; cwd?: string }): { messages: HostMessage[]; path?: string } {
  return { messages: [] }
}

/** Cline HostAdapter（感知经 event-capture 通用入口；表达/注入未支持） */
export const clineAdapter: HostAdapter = {
  id: 'cline',
  capabilities: {
    hooks: { partial: '走 Cline hooks 命令回调（指向 dist/hooks/event-capture.js，tool=cline）或 SDK Plugins 机制；本机未安装 Cline，真实触发待实测' },
    resources: true,
    prompts: { partial: 'MCP Prompts 支持未实测' },
    sessionRead: { partial: '会话文件格式未调研（readSession 暂返回空）' },
    plugin: false,
    systemPrompt: { partial: '.clinerules 文件支持（未实测）' },
    midSessionInjection: false,
    inHostNotification: false,
  },
  hooks: {
    eventMap: {
      // event-capture 通用协议事件名（Cline 命令回调传入）
      start: 'start',
      message: 'msg',
      msg: 'msg',
      end: 'end',
      commit: 'commit',
    },
    configFormat: 'json',
    renderConfig(hooksDir, serverName) {
      // Cline hooks 命令回调接入指引（event-capture 通用入口）
      void serverName
      return [
        '# Cline hooks 接入（感知维度）',
        '# 在 Cline 的 hooks 设置中，为生命周期事件添加命令回调：',
        `#   node ${hooksDir}/event-capture.js`,
        '# 并传入 JSON：{ "event": "start|message|end|commit", "tool": "cline", "text": "...", "session_id": "...", "cwd": "..." }',
        '# 详见 docs/developers/adapter-guide.md',
      ].join('\n')
    },
  },
  expression: {
    kind: 'stdout-text',
    renderSuggestion() {
      // Cline 无 hooks stdout 注入到模型上下文机制；表达降级为 daemon 桌面通知
      return ''
    },
  },
  injection: {
    channel: 'hook-stdout',
    renderInjection() {
      return ''
    },
  },
  readSession: readClineSession,
}
