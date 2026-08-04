/**
 * @proactive-agent/mcp — ProactiveAgent MCP Server
 *
 * 通过 stdio 暴露 MCP server，任何支持 MCP 的 agent 均可挂载：
 * - Claude Code:  claude mcp add proactive-agent -- bunx @proactive-agent/mcp
 * - Cline:        MCP 设置里添加 stdio server
 *
 * 数据存储：默认 ~/.proma-proactive/（用户级一份共享，跨工具复用）。
 * 可用 PROACTIVE_DATA_DIR（或 PROMA_MEMORY_DIR 兼容旧数据）环境变量覆盖。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerTools } from './tools'
import { registerResources } from './resources'
import { registerPrompts } from './prompts'
import { startTodayServer } from './today'
import { runInit } from './cli-init'

/** 创建并注册 ProactiveAgent MCP server（测试与 stdio 入口共用） */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'proactive-agent',
    version: '0.2.0',
  })
  registerTools(server)
  registerResources(server)
  registerPrompts(server)
  return server
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // init：一键生成挂载配置
  if (argv.includes('init')) {
    runInit(argv)
    return
  }
  // --today：启动本地主动中心 Web 面板（不进入 stdio MCP）
  if (argv.includes('--today')) {
    const port = Number(process.env.PROACTIVE_TODAY_PORT ?? 8737)
    startTodayServer(port)
    return
  }
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // 启动成功提示（stderr，避免污染 stdio 协议）
  console.error('[proactive-mcp] ProactiveAgent MCP server 已启动')
  console.error(
    `[proactive-mcp] 数据目录: ${process.env.PROACTIVE_DATA_DIR || process.env.PROMA_MEMORY_DIR || '~/.proma-proactive/'}`,
  )
}

main().catch((error) => {
  console.error('[proactive-mcp] 启动失败:', error)
  process.exit(1)
})
