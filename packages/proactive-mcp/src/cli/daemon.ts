/**
 * proactive-mcp daemon — 守护进程 CLI 子命令（0.5）
 *
 * 用法：
 *   proactive-mcp daemon                # 前台运行（调试 / 手动）
 *   proactive-mcp daemon --install      # 安装自启（macOS launchd / Linux systemd user）
 *   proactive-mcp daemon --uninstall    # 移除自启
 *   proactive-mcp daemon --status       # 运行状态
 *   proactive-mcp daemon --stop         # 停止（SIGTERM 给 pid）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { runDaemon, isProcessAlive } from '../daemon'
import { getConfigDir } from '@proactive-agent/core'

const PLIST_PATH = join(homedir(), 'Library/LaunchAgents/com.proactive-agent.daemon.plist')
const SYSTEMD_PATH = join(homedir(), '.config/systemd/user/proactive-agent.service')
const LOG_PATH = join(getConfigDir(), 'daemon.log')

function statePath(): string {
  return join(getConfigDir(), 'daemon.json')
}

interface DaemonState {
  pid: number
  startedAt: number
  lastRunAt?: number
  lastNotifyAt?: number
  notifiedIds: string[]
}

function readState(): DaemonState | undefined {
  try {
    const p = statePath()
    if (!existsSync(p)) return undefined
    return JSON.parse(readFileSync(p, 'utf-8')) as DaemonState
  } catch {
    return undefined
  }
}

function printStatus(): number {
  const state = readState()
  if (!state) {
    console.log('daemon: 未运行（无状态文件）')
    return 0
  }
  const alive = isProcessAlive(state.pid)
  console.log(`daemon: ${alive ? '运行中' : '已停止（陈旧状态）'}`)
  console.log(`  pid:        ${state.pid}`)
  console.log(`  启动时间:   ${new Date(state.startedAt).toLocaleString()}`)
  if (state.lastRunAt) console.log(`  上次评估:   ${new Date(state.lastRunAt).toLocaleString()}`)
  if (state.lastNotifyAt) console.log(`  上次通知:   ${new Date(state.lastNotifyAt).toLocaleString()}`)
  console.log(`  已通知建议: ${state.notifiedIds.length} 条`)
  return alive ? 0 : 1
}

/** 读取进程命令行（darwin/linux；失败返回 undefined）——pid 复用防护（P1-3） */
function processCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      return out.trim()
    }
  } catch {
    // ps 不可用 / 无权限：返回 undefined，调用方降级为仅 pid 探测
  }
  return undefined
}

function stopDaemon(): number {
  const state = readState()
  if (!state || !isProcessAlive(state.pid)) {
    console.log('daemon: 未在运行')
    return 0
  }
  // P1-3：pid 可能被系统复用——能读到命令行时，校验它确实是 proactive daemon 再停
  const cmdline = processCommandLine(state.pid)
  if (cmdline !== undefined && !cmdline.includes('proactive') && !cmdline.includes('daemon')) {
    console.error(`daemon: pid=${state.pid} 不是 ProactiveAgent daemon（疑似 pid 复用），已拒绝停止：${cmdline.slice(0, 100)}`)
    return 1
  }
  try {
    process.kill(state.pid, 'SIGTERM')
    console.log(`daemon: 已发送停止信号（pid=${state.pid}）`)
    return 0
  } catch (error) {
    console.error(`daemon: 停止失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** 入口脚本（用户启动 proactive-mcp 的脚本路径，自启时复用） */
function entryScript(): string {
  return process.argv[1] ?? join(process.cwd(), 'packages/proactive-mcp/src/index.ts')
}

function installLaunchd(): number {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.proactive-agent.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${entryScript()}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`
  try {
    mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true })
    writeFileSync(PLIST_PATH, plist, 'utf-8')
    console.log(`daemon: 已写入 launchd 配置 ${PLIST_PATH}`)
    execFile('launchctl', ['load', '-w', PLIST_PATH], (error) => {
      if (error) {
        console.error(`daemon: launchctl load 失败（请手动执行）: ${error.message}`)
        console.error(`  launchctl load -w ${PLIST_PATH}`)
        return
      }
      console.log('daemon: 已安装并启动（登录时自动运行）')
    })
    return 0
  } catch (error) {
    console.error(`daemon: 安装失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function uninstallLaunchd(): number {
  try {
    if (existsSync(PLIST_PATH)) {
      execFile('launchctl', ['unload', '-w', PLIST_PATH], () => {
        // unload 失败不阻断删除
      })
      rmSync(PLIST_PATH, { force: true })
      console.log('daemon: 已移除 launchd 配置')
    } else {
      console.log('daemon: 未安装 launchd 配置')
    }
    return 0
  } catch (error) {
    console.error(`daemon: 卸载失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function installSystemd(): number {
  const unit = `[Unit]
Description=ProactiveAgent daemon
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${entryScript()} daemon
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
  try {
    mkdirSync(join(homedir(), '.config/systemd/user'), { recursive: true })
    writeFileSync(SYSTEMD_PATH, unit, 'utf-8')
    console.log(`daemon: 已写入 systemd user unit ${SYSTEMD_PATH}`)
    execFile('systemctl', ['--user', 'enable', '--now', 'proactive-agent.service'], (error) => {
      if (error) {
        console.error(`daemon: systemctl enable 失败（请手动执行）: ${error.message}`)
        console.error(`  systemctl --user enable --now proactive-agent.service`)
        return
      }
      console.log('daemon: 已安装并启动（登录时自动运行）')
    })
    return 0
  } catch (error) {
    console.error(`daemon: 安装失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function uninstallSystemd(): number {
  try {
    execFile('systemctl', ['--user', 'disable', '--now', 'proactive-agent.service'], () => {})
    rmSync(SYSTEMD_PATH, { force: true })
    console.log('daemon: 已移除 systemd unit')
    return 0
  } catch (error) {
    console.error(`daemon: 卸载失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** CLI 入口：返回进程退出码 */
export async function runDaemonCli(argv: string[]): Promise<number> {
  const flag = argv[1]
  if (flag === '--install') {
    if (process.platform === 'darwin') return installLaunchd()
    if (process.platform === 'linux') return installSystemd()
    console.error('daemon: 当前平台暂不支持自启安装（darwin/linux 支持）')
    return 1
  }
  if (flag === '--uninstall') {
    if (process.platform === 'darwin') return uninstallLaunchd()
    if (process.platform === 'linux') return uninstallSystemd()
    console.error('daemon: 当前平台暂不支持自启移除')
    return 1
  }
  if (flag === '--status') return printStatus()
  if (flag === '--stop') return stopDaemon()
  if (flag !== undefined && flag !== '--start') {
    console.error(`daemon: 未知参数 ${flag}（可用: --install / --uninstall / --status / --stop / --start）`)
    return 1
  }
  // 默认：前台运行
  await runDaemon()
  return 0
}
