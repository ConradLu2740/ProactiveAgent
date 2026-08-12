/**
 * Notifier — 跨平台桌面通知 adapter（0.5 daemon「主动出口」）
 *
 * 统一接口 showNotification，任何宿主无关的主动 agent 都可调用：
 * - macOS   ：优先 terminal-notifier（brew install terminal-notifier，支持点击打开 URL）；
 *             缺失时降级 osascript display notification（原生通知中心，纯提示）
 * - Windows ：PowerShell 托盘气泡（NotifyIcon BalloonTip，尽力而为，无 AppId 依赖）
 * - Linux   ：notify-send（DBus）
 *
 * 设计约束：
 * - 通知失败绝不抛错（静默降级，返回 { ok:false }），保证 daemon 主循环不被通知拖垮
 * - runner 可注入，单测 mock 命令执行，不真弹系统通知
 */

import { execFile } from 'node:child_process'

export interface NotificationOptions {
  title: string
  body: string
  /** 点击通知时打开的 URL（macOS terminal-notifier 支持；其他平台尽力） */
  url?: string
}

export interface NotifyResult {
  ok: boolean
  error?: string
}

/** 命令执行器（可注入；默认 execFile + 10s 超时） */
export type NotifyRunner = (cmd: string, args: string[]) => Promise<NotifyResult>

const defaultRunner: NotifyRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (error) => {
      resolve(error ? { ok: false, error: error.message } : { ok: true })
    })
  })

/** AppleScript 字符串转义（osascript 双引号包裹场景；控制字符替换为空格避免语法错误） */
export function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
}

/** PowerShell 单引号字符串转义（控制字符替换为空格） */
export function escapePowerShell(s: string): string {
  return s.replace(/'/g, "''").replace(/[\u0000-\u001F\u007F]/g, ' ')
}

export interface Notifier {
  readonly platform: NodeJS.Platform
  show(options: NotificationOptions): Promise<NotifyResult>
}

/** 创建通知器（平台与 runner 可注入，便于测试） */
export function createNotifier(
  platform: NodeJS.Platform = process.platform,
  runner: NotifyRunner = defaultRunner,
): Notifier {
  return {
    platform,
    async show(options: NotificationOptions): Promise<NotifyResult> {
      try {
        switch (platform) {
          case 'darwin':
            return await notifyMacOS(options, runner)
          case 'win32':
            return await notifyWindows(options, runner)
          case 'linux':
            return await notifyLinux(options, runner)
          default:
            return { ok: false, error: `不支持的平台: ${platform}` }
        }
      } catch (error) {
        // 通知是尽力而为：任何异常都不上抛
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

async function notifyMacOS(options: NotificationOptions, runner: NotifyRunner): Promise<NotifyResult> {
  // 优先 terminal-notifier：点击通知可打开 URL（打开 /today 面板）
  const probe = await runner('which', ['terminal-notifier'])
  if (probe.ok) {
    const args = ['-title', options.title, '-message', options.body]
    if (options.url) args.push('-open', options.url)
    return runner('terminal-notifier', args)
  }
  // 降级 osascript 原生通知中心（无点击回调，纯提示）
  const script = `display notification "${escapeAppleScript(options.body)}" with title "${escapeAppleScript(options.title)}"`
  return runner('osascript', ['-e', script])
}

async function notifyWindows(options: NotificationOptions, runner: NotifyRunner): Promise<NotifyResult> {
  // 托盘气泡（BalloonTip）：无需注册 AppId，交互式桌面可用；脚本失败时降级提示
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = '${escapePowerShell(options.title)}'
$n.BalloonTipText = '${escapePowerShell(options.body)}'
$n.Visible = $true
$n.ShowBalloonTip(5000)
Start-Sleep -Seconds 7
$n.Dispose()
`
  return runner('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
}

async function notifyLinux(options: NotificationOptions, runner: NotifyRunner): Promise<NotifyResult> {
  return runner('notify-send', ['-a', 'ProactiveAgent', '-u', 'normal', options.title, options.body])
}

/** 便捷导出：当前平台默认通知器 */
export const notifier: Notifier = createNotifier()
