/**
 * Codex HostAdapter 实现（M3）
 *
 * 依据（有据事实，2026-08-12）：
 * - Codex 生命周期 hooks 需手动接入（Codex 官方 config 文档），命令指向
 *   dist/hooks/event-capture.js（ProactiveAgent 通用事件入口）。
 * - 感知维度通过 event-capture 统一协议接入：stdin { event, tool: "codex", ... }。
 *
 * ⚠️ 待实测：本机未安装 Codex CLI；hooks 配置格式、真实触发待实测。
 * 能力矩阵诚实声明，不伪造。
 */

import type { HostAdapter, HostHookInput, HostMessage } from './types'

/** Codex 会话读取：未调研（返回空，收尾沉淀在 Codex 下不可用） */
export function readCodexSession(_input: { sessionId?: string; cwd?: string }): { messages: HostMessage[]; path?: string } {
  return { messages: [] }
}

/** Codex HostAdapter（感知经 event-capture 通用入口；表达/注入未支持） */
export const codexAdapter: HostAdapter = {
  id: 'codex',
  capabilities: {
    hooks: { partial: '生命周期 hooks 需手动接入（Codex 官方 config，命令指向 dist/hooks/event-capture.js，tool=codex）；本机未安装 Codex，真实触发待实测' },
    resources: true,
    prompts: { partial: 'MCP Prompts 支持未实测' },
    sessionRead: { partial: '会话文件格式未调研（readSession 暂返回空）' },
    plugin: false,
    systemPrompt: { partial: 'AGENTS.md 支持（未实测）' },
    midSessionInjection: false,
    inHostNotification: false,
  },
  hooks: {
    eventMap: {
      // event-capture 通用协议事件名（Codex hooks 命令回调传入）
      start: 'start',
      message: 'msg',
      msg: 'msg',
      end: 'end',
      commit: 'commit',
    },
    configFormat: 'json',
    renderConfig(hooksDir, serverName) {
      // Codex hooks 接入指引（event-capture 通用入口）
      void serverName
      return [
        '# Codex hooks 接入（感知维度）',
        '# 在 Codex 配置中为生命周期事件添加 hooks（官方 config），命令指向：',
        `#   node ${hooksDir}/event-capture.js`,
        '# 并传入 JSON：{ "event": "start|message|end|commit", "tool": "codex", "text": "...", "session_id": "...", "cwd": "..." }',
        '# 详见 docs/developers/adapter-guide.md',
      ].join('\n')
    },
  },
  expression: {
    kind: 'stdout-text',
    renderSuggestion() {
      // Codex 无 hooks stdout 注入到模型上下文机制；表达降级为 daemon 桌面通知
      return ''
    },
  },
  injection: {
    channel: 'hook-stdout',
    renderInjection() {
      return ''
    },
  },
  readSession: readCodexSession,
}
