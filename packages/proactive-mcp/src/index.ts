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
import os from 'node:os'
import { registerTools } from './tools'
import { registerResources } from './resources'
import { registerPrompts } from './prompts'
import { startTodayServer } from './today'
import { runInit } from './cli-init'
import { runDoctor } from './cli/doctor'
import { runStats } from './cli/stats'
import { runDemo } from './cli/demo'
import { runMigrate } from './cli/migrate'
import { runExtract } from './cli/extract'

/**
 * 包版本。发布时由 scripts/publish-proactive.sh 通过 bun build
 * --define:PROACTIVE_MCP_VERSION 注入；本地开发（无注入）回退为 dev。
 */
declare const PROACTIVE_MCP_VERSION: string | undefined
const VERSION: string =
  typeof PROACTIVE_MCP_VERSION !== 'undefined' ? PROACTIVE_MCP_VERSION : '0.0.0-dev'

/** 创建并注册 ProactiveAgent MCP server（测试与 stdio 入口共用） */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'proactive-agent',
    version: VERSION,
  })
  registerTools(server)
  registerResources(server)
  registerPrompts(server)
  return server
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // --help / --version：探路入口（不进入 stdio MCP）
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`ProactiveAgent MCP Server

用法:
  proactive-mcp                # 以 stdio 方式启动 MCP server（供 agent 挂载）
  proactive-mcp init           # 一键生成挂载配置 + hooks（可选 --local / --kimi / --force / --dry-run）
  proactive-mcp doctor         # 健康检查（配置/数据/hooks/端口/项目身份）
  proactive-mcp stats          # 记忆与建议统计
  proactive-mcp demo           # 教程式示例（隔离数据，--clean 清理）
  proactive-mcp migrate        # 0.3.0 数据迁移 / 反向收敛（--merge-to-global / --status / --preview）
  proactive-mcp extract        # 对已有项目提取记忆（冷启动引导；--dry-run 预览 / --global 写共享层）
  proactive-mcp --today        # 启动本地主动中心 Web 面板（端口 PROACTIVE_TODAY_PORT，默认 8737）

数据目录: 默认 ~/.proma-proactive/（0.3.0 起按项目隔离，显式共享用 global）
更多: https://github.com/ConradLu2740/ProactiveAgent`)
    return
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION)
    return
  }
  // init：一键生成挂载配置
  if (argv.includes('init')) {
    runInit(argv)
    return
  }
  // doctor：健康检查
  if (argv.includes('doctor')) {
    const code = await runDoctor()
    process.exitCode = code
    return
  }
  // stats：记忆与建议统计
  if (argv.includes('stats')) {
    runStats()
    return
  }
  // demo：教程式示例（--clean 清理演示数据）
  if (argv.includes('demo')) {
    await runDemo(argv.includes('--clean'))
    return
  }
  // migrate：旧数据迁移 / 反向收敛
  if (argv.includes('migrate')) {
    const code = runMigrate(argv)
    process.exitCode = code
    return
  }
  // extract：对已有项目提取记忆（冷启动引导）
  if (argv.includes('extract')) {
    runExtract(argv)
    return
  }
  // --today：启动本地主动中心 Web 面板（不进入 stdio MCP）
  if (argv.includes('--today')) {
    const port = Number(process.env.PROACTIVE_TODAY_PORT ?? 8737)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`[proactive-mcp] 无效端口: ${process.env.PROACTIVE_TODAY_PORT}（需 1-65535 的整数）`)
      process.exit(1)
    }
    await startTodayServer(port)
    return
  }

  // 未知首参数：友好提示而非静默进入 stdio（避免用户手滑后进程永久挂起）
  const KNOWN = new Set(['init', 'doctor', 'stats', 'demo', 'migrate', 'extract', '--today', '--help', '-h', '--version', '-v'])
  const first = argv[0]
  if (first && !first.startsWith('-') && !KNOWN.has(first)) {
    console.error(`未知子命令: ${first}`)
    console.error('可用命令: init · doctor · stats · demo · migrate · extract · --today · --help · --version')
    process.exit(1)
  }
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // 启动成功提示（stderr，避免污染 stdio 协议）
  console.error('[proactive-mcp] ProactiveAgent MCP server 已启动')
  // 0.3.0：stdio 启动时自动迁移旧数据（只读命令不触发），并打印项目身份到 stderr 便于诊断
  try {
    const { migrateLegacyData, getProjectIdentity, isEscapeGlobal } = await import('@proactive-agent/core')
    const mig = migrateLegacyData()
    if (mig.status === 'migrated') {
      console.error(`[proactive-mcp] 旧数据已迁移到 global 层（${mig.detail ?? ''}）`)
    }
    if (!isEscapeGlobal()) {
      const ident = getProjectIdentity()
      console.error(`[proactive-mcp] 项目: ${ident.displayName}（${ident.identitySource}，key=${ident.key}）`)
    } else {
      console.error('[proactive-mcp] 逃生模式: PROACTIVE_SCOPE=global（全部读写全局单层）')
    }
  } catch {
    // 迁移/身份打印失败不阻塞 server 启动
  }
  const dataDir = process.env.PROACTIVE_DATA_DIR || process.env.PROMA_MEMORY_DIR || '~/.proma-proactive/'
  const expanded = dataDir.startsWith('~') ? dataDir.replace(/^~/, os.homedir()) : dataDir
  console.error(`[proactive-mcp] 数据目录: ${expanded}`)
}

main().catch((error) => {
  console.error('[proactive-mcp] 启动失败:', error)
  process.exit(1)
})
