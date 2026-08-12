/**
 * proactive-mcp ump-export / ump-import — UMP 互操作 CLI（0.7 L0）
 *
 * 用法：
 *   proactive-mcp ump-export [--path <file>] [--confirmed]   # 导出 PA 记忆为 UMP 文件
 *   proactive-mcp ump-import <file> [--confirm]             # 导入 UMP 文件到 PA（默认 pending）
 */

import { join } from 'node:path'
import { exportUmpFile, importUmpFile } from '../ump'

export function runUmpCli(argv: string[]): number {
  const sub = argv[0]
  if (sub === 'ump-export') {
    const pathIdx = argv.indexOf('--path')
    let outPath = pathIdx >= 0 ? (argv[pathIdx + 1] ?? '') : join(process.cwd(), '.ump', 'memory.ump.json')
    // --path 取值必须是参数而非其他 flag
    if (!outPath || outPath.startsWith('-')) outPath = join(process.cwd(), '.ump', 'memory.ump.json')
    try {
      const res = exportUmpFile(outPath, { confirmed: argv.includes('--confirmed') })
      console.log(`UMP 导出完成: ${res.count} 条记忆 → ${res.path}`)
      return 0
    } catch (error) {
      console.error(`ump-export 失败: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  if (sub === 'ump-import') {
    const inPath = argv[1]
    if (!inPath || inPath.startsWith('-')) {
      console.error('ump-import: 缺少 UMP 文件路径（用法: proactive-mcp ump-import <file> [--confirm]）')
      return 1
    }
    try {
      const res = importUmpFile(inPath, { confirmed: argv.includes('--confirm') })
      console.log(`UMP 导入完成: 新增 ${res.imported} 条（${res.pending} 条待确认），去重 ${res.deduplicated} 条${res.skipped > 0 ? `，跳过 ${res.skipped} 条（畸形/记忆功能未开启）` : ''} → ${res.path}`)
      return 0
    } catch (error) {
      console.error(`ump-import 失败: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  console.error('未知 UMP 子命令（可用: ump-export / ump-import）')
  return 1
}
