/**
 * 项目身份解析与顶层数据管理（0.3.0「按项目记忆」）
 *
 * 按项目隔离 + 显式全局共享的数据模型核心：
 * - 项目身份解析（resolveProjectKey）：env > git remote > package name > path hash
 * - 项目边界查找（findProjectRoot）：.mcp.json > git root > cwd
 * - 旧数据迁移（migrateLegacyData）：0.1.x/0.2.x 全局数据 → global 层
 * - 顶层 index.json（schemaVersion:2）
 *
 * 设计依据：pa-dx-roadmap.md / pa-0.3.0-scope-design.md
 * 对抗审查修正已并入：realpath 进 hash、remote 归一化矩阵、逃生短路、迁移 lockfile。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'

export type Scope = 'project' | 'global' | 'auto'
export type WriteScope = 'project' | 'global'
export type ReadScope = Scope

// ===== 内部数据根目录（复制 paths.getConfigDir 逻辑，避免与 paths.ts 循环依赖） =====

function configDir(): string {
  const override = process.env.PROACTIVE_DATA_DIR?.trim() || process.env.PROMA_CONFIG_DIR?.trim()
  if (override) {
    if (!existsSync(override)) mkdirSync(override, { recursive: true })
    return override
  }
  const dir = join(homedir(), '.proma-proactive')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export const GLOBAL_KEY = '__global__'

export interface ProjectIdentity {
  key: string
  displayName: string
  identitySource: 'env' | 'git-remote' | 'package-name' | 'path-hash' | 'global'
  root?: string
}

export interface MigrationResult {
  status: 'already-v2' | 'migrated' | 'nothing-to-do' | 'failed'
  detail?: string
}

export interface TopLevelIndex {
  schemaVersion: number
  defaultScope: 'project'
  projects: string[]
  migration?: {
    from: string
    at: number
    sourceRoot: string
    movedFiles: string[]
    status: 'done' | 'failed'
    error?: string
  }
}

// ===== 进程内缓存（测试用可重置） =====

let cachedIdentity: ProjectIdentity | null = null

export function resetProjectIdentity(): void {
  cachedIdentity = null
}

/** 逃生开关：PROACTIVE_SCOPE=global 时是否强制全局单层 */
export function isEscapeGlobal(): boolean {
  return process.env.PROACTIVE_SCOPE?.trim() === 'global'
}

/** PROMA_MEMORY_DIR 显式设置时：单层 global 实例（D7） */
export function isSingleLayerMode(): boolean {
  return !!process.env.PROMA_MEMORY_DIR?.trim()
}

// ===== key 工具 =====

/** 从远端 URL 归一化出稳定 key 片段（对抗审查 1.1 修正：6 变体矩阵） */
export function normalizeGitRemote(url: string): string | undefined {
  const s = url.trim()
  if (!s) return undefined
  // 本地路径 / file:// → 无稳定远程
  if (/^\.{0,2}\//.test(s) || /^file:\/\//i.test(s)) return undefined
  // ssh://git@github.com:user/repo.git  → github.com:user/repo.git
  let rest = s
  // 去协议与用户信息
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  rest = rest.replace(/^[^@/]+@/, '')
  // ssh scp-like 语法：git@github.com:user/repo.git（协议前已是 host:path 形态）
  // host 部分统一小写
  const hostMatch = rest.match(/^([^:/]+)/)
  const host = hostMatch ? hostMatch[1].toLowerCase() : ''
  let path = rest.slice(host.length).replace(/^[:/]+/, '')
  // 去端口
  path = path.replace(/^(\d+)\//, '')
  // 去 .git 后缀
  path = path.replace(/\.git$/, '')
  // 归一化重复斜杠
  path = path.replace(/\/+/g, '-').replace(/-+/g, '-')
  if (!host || !path) return undefined
  return `${host}-${path}`
}

/** 清理 key 段（不可读字符替换）。🔴#5 修复：非 ASCII 全变 '-' 会碰撞 → 中文等用编码，保留可读前缀 */
export function sanitizeKeyPart(s: string): string {
  const ascii = s.replace(/[^a-zA-Z0-9._-]/g, '-')
  const hasNonAscii = ascii !== s || /[\u0080-\uFFFF]/.test(s)
  // 纯 ASCII 直接清理
  if (!hasNonAscii) {
    return ascii.replace(/-+/g, '-').slice(0, 60)
  }
  // 含非 ASCII（中文/emoji 等）：取可读 ascii 前缀 + 内容 hash，避免 '中文项目一'/'中文项目二' 都变 '-'
  const prefix = ascii.replace(/-+/g, '-').slice(0, 40) || 'non-ascii'
  return `${prefix}-${sha256Hex(s).slice(0, 8)}`.slice(0, 60)
}

function sha256Hex(input: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(input).digest('hex')
}

/** 稳定路径 hash（对抗审查 1.3 修正：先 realpath 归一化） */
export function pathHash(absRoot: string): string {
  try {
    const real = realpathSync(absRoot)
    return sha256Hex(normalize(real)).slice(0, 12)
  } catch {
    return sha256Hex(normalize(absRoot)).slice(0, 12)
  }
}

// ===== 项目边界查找 =====

const MAX_UP = 5

/** 向上最多 5 层找项目根：.mcp.json > git root > cwd */
export function findProjectRoot(startDir = process.cwd()): string {
  let dir = resolve(startDir)
  for (let i = 0; i <= MAX_UP; i++) {
    if (existsSync(join(dir, '.mcp.json'))) return dir
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(startDir)
}

function gitRemote(projectRoot: string): string | undefined {
  try {
    const out = execFileSync('git', ['remote', '-v'], { cwd: projectRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    const remotes: string[] = []
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/)
      if (m) remotes.push(`${m[1]}\t${m[2]}`)
    }
    if (remotes.length === 0) return undefined
    // 确定性排序：origin > upstream > 其余按名称字典序（对抗审查 1.2 修正）
    const byName = new Map<string, string>()
    for (const r of remotes) {
      const [name, url] = r.split('\t')
      if (!byName.has(name)) byName.set(name, url)
    }
    const pick = (names: string[]): string | undefined => {
      for (const n of names) {
        const v = byName.get(n)
        if (v !== undefined) return v
      }
      return undefined
    }
    const url = pick(['origin', 'upstream'])
    if (url) return url
    // 无 origin/upstream：按名称字典序取第一个（确定性）
    const sorted = [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    return sorted[0]?.[1]
  } catch {
    return undefined
  }
}

function nearestPackageName(startDir: string): { name?: string; root?: string } {
  let dir = resolve(startDir)
  for (let i = 0; i <= MAX_UP; i++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const data = JSON.parse(readFileSync(pkg, 'utf-8')) as { name?: string }
        if (data.name) return { name: data.name, root: dir }
      } catch {
        // 忽略损坏的 package.json
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return {}
}

function ensureProjectMeta(identity: ProjectIdentity): void {
  try {
    if (identity.key === GLOBAL_KEY) return
    const root = getProjectsRootDir()
    const metaPath = join(root, identity.key, 'meta.json')
    if (existsSync(metaPath)) return
    mkdirSync(dirname(metaPath), { recursive: true })
    const now = Date.now()
    writeFileSync(
      metaPath,
      JSON.stringify(
        { displayName: identity.displayName, identitySource: identity.identitySource, root: identity.root ?? null, firstSeenAt: now, updatedAt: now },
        null,
        2,
      ) + '\n',
      'utf-8',
    )
    ensureTopIndex()
  } catch {
    // meta 写入失败不阻塞主流程
  }
}

// ===== 顶层 index.json =====

export function getTopIndexPath(): string {
  return join(configDir(), 'index.json')
}

export function readTopIndex(): TopLevelIndex | undefined {
  try {
    if (!existsSync(getTopIndexPath())) return undefined
    const raw = readFileSync(getTopIndexPath(), 'utf-8')
    return JSON.parse(raw) as TopLevelIndex
  } catch {
    return undefined
  }
}

export function writeTopIndex(index: TopLevelIndex): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(getTopIndexPath(), JSON.stringify(index, null, 2) + '\n', 'utf-8')
}

function ensureTopIndex(): void {
  if (readTopIndex()?.schemaVersion === 2) return
  writeTopIndex({ schemaVersion: 2, defaultScope: 'project', projects: [] })
}

// ===== 身份解析主入口 =====

export function getProjectsRootDir(): string {
  return join(configDir(), 'projects')
}

/** 解析当前项目身份（进程内缓存；测试/逃生可重置） */
export function resolveProjectKey(opts: { explicit?: string; cwd?: string } = {}): ProjectIdentity {
  if (cachedIdentity) return cachedIdentity
  const identity = resolveProjectKeyUncached(opts)
  cachedIdentity = identity
  ensureProjectMeta(identity)
  return identity
}

function resolveProjectKeyUncached(opts: { explicit?: string; cwd?: string }): ProjectIdentity {
  // 1. 显式覆盖
  if (opts.explicit) return { key: sanitizeKeyPart(opts.explicit), displayName: opts.explicit, identitySource: 'env' }
  if (process.env.PROACTIVE_PROJECT?.trim()) {
    const name = process.env.PROACTIVE_PROJECT.trim()
    return { key: sanitizeKeyPart(name), displayName: name, identitySource: 'env' }
  }
  // 2. 逃生开关短路
  if (isEscapeGlobal() || isSingleLayerMode()) {
    return { key: GLOBAL_KEY, displayName: 'global', identitySource: 'global' }
  }
  const startDir = opts.cwd ?? process.cwd()
  // 3. 项目边界
  const projectRoot = findProjectRoot(startDir)
  // 4. git remote
  const remote = gitRemote(projectRoot)
  if (remote) {
    const norm = normalizeGitRemote(remote)
    if (norm) {
      return { key: `remote:${sanitizeKeyPart(norm)}`, displayName: norm, identitySource: 'git-remote', root: projectRoot }
    }
  }
  // 5. package.json name
  const pkg = nearestPackageName(startDir)
  if (pkg.name && pkg.root) {
    const clean = sanitizeKeyPart(pkg.name)
    // 同名冲突：追加 hash 后缀（对抗审查 1.6 修正：恒带后缀避免行为不一致）
    const suffix = pathHash(pkg.root).slice(0, 4)
    return { key: `name:${clean}-${suffix}`, displayName: pkg.name, identitySource: 'package-name', root: pkg.root }
  }
  // 6. path hash
  return { key: `path:${pathHash(projectRoot)}`, displayName: projectRoot, identitySource: 'path-hash', root: projectRoot }
}

/** 当前层 key（store/feedback 缓存键化用） */
export function currentLayerKey(): string {
  if (isEscapeGlobal() || isSingleLayerMode()) return GLOBAL_KEY
  return resolveProjectKey().key
}

// ===== 迁移（对抗审查 2.x 修正：lockfile + 存在即迁 + 幂等） =====

export function migrateLegacyData(): MigrationResult {
  const root = configDir()
  const top = readTopIndex()
  const oldMemory = join(root, 'memory')
  const oldSuggestions = join(root, 'suggestions.json')
  const oldSuggestionsBackup = join(root, 'suggestions.json.bak')
  const hasOld = existsSync(oldMemory) || existsSync(oldSuggestions)

  // 幂等判断（修复 🔴#1：不能只查 schemaVersion——doctor/stats 先跑会 ensureTopIndex 写成 v2 但没迁数据）
  if (top?.schemaVersion === 2 && !hasOld) {
    return { status: 'already-v2' }
  }
  if (top?.schemaVersion === 2 && hasOld) {
    // v2 标记但旧数据仍残留（此前被 ensureTopIndex 抢先写过 v2）：继续迁移
    return doMigrate(root, oldMemory, oldSuggestions, oldSuggestionsBackup)
  }
  if (top?.schemaVersion === undefined && !hasOld) {
    ensureTopIndex()
    return { status: 'nothing-to-do' }
  }
  // 有旧数据：执行迁移（含 lock 保护）
  return doMigrate(root, oldMemory, oldSuggestions, oldSuggestionsBackup)
}

/** 实际执行迁移（带 lockfile 防多进程竞争） */
function doMigrate(
  root: string,
  oldMemory: string,
  oldSuggestions: string,
  oldSuggestionsBackup: string,
): MigrationResult {
  // 迁移 lock：防多进程竞争
  const lockPath = join(root, '.migration.lock')
  if (existsSync(lockPath)) {
    return { status: 'failed', detail: `存在迁移锁 ${lockPath}（另一进程迁移中），跳过` }
  }

  // 写锁
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf-8')
  try {
    mkdirSync(join(root, 'global'), { recursive: true })
    const movedFiles: string[] = []
    // 存在即迁（对抗审查 2.1 修正：含 .bak）
    const candidates = [
      ['memory', oldMemory, join(root, 'global', 'memory')],
      ['suggestions.json', oldSuggestions, join(root, 'global', 'suggestions.json')],
      ['suggestions.json.bak', oldSuggestionsBackup, join(root, 'global', 'suggestions.json.bak')],
    ]
    for (const [label, from, to] of candidates) {
      if (existsSync(from)) {
        // 同文件系统原子移动；目标已存在则跳过（幂等）
        if (!existsSync(to)) {
          renameSync(from, to)
          movedFiles.push(label)
        }
      }
    }
    writeTopIndex({
      schemaVersion: 2,
      defaultScope: 'project',
      projects: [],
      migration: { from: '0.1.x-global', at: Date.now(), sourceRoot: root, movedFiles, status: 'done' },
    })
    return { status: 'migrated', detail: `moved: ${movedFiles.join(', ')}` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    writeTopIndex({
      schemaVersion: 2,
      defaultScope: 'project',
      projects: [],
      migration: { from: '0.1.x-global', at: Date.now(), sourceRoot: root, movedFiles: [], status: 'failed', error: msg },
    })
    return { status: 'failed', detail: msg }
  } finally {
    try {
      renameSync(lockPath, join(root, '.migration.lock.bak'))
    } catch {
      // lock 清理失败不阻塞
    }
  }
}

/** 反向：项目层合并回 global（--merge-to-global，beta 逃生通道） */
export function mergeProjectsToGlobal(opts: { preview?: boolean; project?: string } = {}): { preview: boolean; items: string[]; done: boolean } {
  const projectsRoot = getProjectsRootDir()
  const items: string[] = []
  let keys: string[] = []
  if (opts.project) {
    keys = [opts.project]
  } else if (existsSync(projectsRoot)) {
    keys = readdirSafe(projectsRoot).filter((k) => k !== '.DS_Store')
  }
  for (const key of keys) {
    const projMemory = join(projectsRoot, key, 'memory')
    const projSuggestions = join(projectsRoot, key, 'suggestions.json')
    const globalDir = getGlobalDir()
    const globalMemory = join(globalDir, 'memory')
    if (existsSync(projMemory) || existsSync(projSuggestions)) {
      items.push(key)
      if (!opts.preview) {
        // 🔴#2 修复：mkdir 先于 exists 判断导致 memory 永不移动 → 改为目录级数据合并
        // memory 目录：把项目层 atoms 按 fingerprint 去重后追加进 global
        try {
          mergeMemoryInto(projMemory, globalMemory)
        } catch (error) {
          items.push(`${key} (memory 合并失败: ${error instanceof Error ? error.message : String(error)})`)
        }
        // suggestions.json：目标不存在才 move（简单合并，避免覆盖用户已迁移数据）
        if (existsSync(projSuggestions) && !existsSync(join(globalDir, 'suggestions.json'))) {
          try {
            renameSync(projSuggestions, join(globalDir, 'suggestions.json'))
          } catch {
            // 同上
          }
        }
      }
    }
  }
  return { preview: !!opts.preview, items, done: !opts.preview }
}

/** 把项目层 memory 数据合并进 global（atoms 按 fingerprint 去重；scenes/corrections/profile 简单 move，冲突保留 global） */
function mergeMemoryInto(fromDir: string, toDir: string): void {
  if (!existsSync(fromDir)) return
  mkdirSync(toDir, { recursive: true })
  // atoms：读取项目层全部 atoms，与 global 层按 fingerprint 去重后追加写回
  const fromAtoms = join(fromDir, 'atoms')
  const toAtoms = join(toDir, 'atoms')
  if (existsSync(fromAtoms)) {
    mkdirSync(toAtoms, { recursive: true })
    const seen = new Set<string>()
    // 已有 global atoms 指纹
    for (const f of readFilesSafe(toAtoms).filter((f) => f.endsWith('.jsonl'))) {
      try {
        for (const line of readFileSync(join(toAtoms, f), 'utf-8').split('\n')) {
          if (!line.trim()) continue
          try {
            const a = JSON.parse(line) as { fingerprint?: string; content?: string }
            const fp = a.fingerprint ?? a.content
            if (fp) seen.add(fp)
          } catch {
            // 跳过损坏行
          }
        }
      } catch {
        // 跳过不可读
      }
    }
    // 追加项目层 atoms（去重）
    const toWrite: string[] = []
    for (const f of readFilesSafe(fromAtoms).filter((f) => f.endsWith('.jsonl'))) {
      try {
        for (const line of readFileSync(join(fromAtoms, f), 'utf-8').split('\n')) {
          if (!line.trim()) continue
          try {
            const a = JSON.parse(line) as { fingerprint?: string; content?: string; scope?: string }
            const fp = a.fingerprint ?? a.content
            if (!fp || seen.has(fp)) continue
            seen.add(fp)
            toWrite.push(JSON.stringify({ ...a, scope: 'global' }))
          } catch {
            // 跳过损坏行
          }
        }
      } catch {
        // 跳过不可读
      }
    }
    if (toWrite.length > 0) {
      const day = new Date().toISOString().slice(0, 10)
      const target = join(toAtoms, `${day}.jsonl`)
      const existing = existsSync(target) ? readFileSync(target, 'utf-8') : ''
      writeFileSync(target, existing + toWrite.join('\n') + '\n', 'utf-8')
    }
  }
  // scenes / corrections / profile：目标不存在才 move（目录/文件都直接 rename）
  for (const sub of ['scenes', 'corrections.json', 'profile.md', 'index.json', 'memory_log']) {
    const from = join(fromDir, sub)
    const to = join(toDir, sub)
    if (existsSync(from) && !existsSync(to)) {
      try {
        renameSync(from, to)
      } catch {
        // 目标冲突保留 global，项目层原样保留（不删）
      }
    }
  }
}

function readdirSafe(dir: string): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

/** 读取目录内所有文件名（含文件，不含子目录） */
function readFilesSafe(dir: string): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name)
  } catch {
    return []
  }
}

// ===== 兼容 paths 引用（避免循环依赖：paths.ts 引用 project.ts 时用动态 import 或反向导入） =====

/** 项目记忆根目录（按当前层路由） */
export function getProjectMemoryRootDir(key?: string): string {
  if (isEscapeGlobal() || isSingleLayerMode()) return join(configDir(), 'memory')
  const k = key ?? resolveProjectKey().key
  return join(getProjectsRootDir(), k, 'memory')
}

export function getGlobalDir(): string {
  return join(configDir(), 'global')
}

export function getGlobalMemoryRootDir(): string {
  return join(getGlobalDir(), 'memory')
}

export function getProjectSuggestionsPath(key?: string): string {
  if (isEscapeGlobal() || isSingleLayerMode()) return join(configDir(), 'suggestions.json')
  const k = key ?? resolveProjectKey().key
  return join(getProjectsRootDir(), k, 'suggestions.json')
}

export function getGlobalSuggestionsPath(): string {
  return join(getGlobalDir(), 'suggestions.json')
}

export function getProjectMetaPath(key: string): string {
  return join(getProjectsRootDir(), key, 'meta.json')
}

export function getProjectKey(opts?: { explicit?: string }): string {
  return resolveProjectKey(opts).key
}

export function getProjectIdentity(): ProjectIdentity {
  return resolveProjectKey()
}

export function listProjectKeys(): string[] {
  const top = readTopIndex()
  if (top?.projects?.length) return top.projects
  return readdirSafe(getProjectsRootDir())
}
