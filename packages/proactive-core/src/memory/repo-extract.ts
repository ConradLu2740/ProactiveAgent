/**
 * 仓库级记忆提取（0.4.0「引导闭环」）
 *
 * 冷启动引导：对开发者已有项目做一次记忆提取，让第一次使用就感受到"它懂我的项目"。
 *
 * 提取源（设计决策 1，方案 D）：
 * - 底座：README.md / docs/ 目录 / package.json / 近期 git log（零风险、纯规则、零外发）
 * - 增强：TODO/FIXME 扫描 → todo_context（语义最明确、误报最低、对 suggest 引擎价值最高）
 *
 * 管线：collector（采集原始文本）→ normalizer（规则归一为 MemoryCandidate）→
 *       captureCandidates（pending 防投毒，用户确认后进入召回）
 *
 * MVP 边界：纯规则零外发、默认 pending、限额硬约束（文件≤200 / TODO≤20 / README 截断）、
 *           明确不做 AST 与源码注释全文入库（V2 可加 LLM 提炼）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { MemoryCandidate } from '../shared-types'
import { captureCandidates } from './service'
import { findProjectRoot } from '../project'

export interface RepoExtractOptions {
  /** 项目根（默认 findProjectRoot(process.cwd())） */
  root?: string
  /** 是否包含 TODO/FIXME 扫描（默认 true） */
  scanTodos?: boolean
  /** 文件扫描上限（防大仓库失控，默认 200） */
  maxFiles?: number
  /** TODO 条数上限（默认 20） */
  maxTodos?: number
  /** 输出候选（不写入，dry-run 用） */
  dryRun?: boolean
  /** 写入 scope（默认 project） */
  scope?: 'project' | 'global'
}

export interface RepoExtractResult {
  /** 提取到的候选（含 TODO） */
  candidates: MemoryCandidate[]
  /** 实际写入数（dryRun 时恒 0） */
  storedCount: number
  /** TODO 数量（单独统计供输出摘要） */
  todoCount: number
  /** 扫描源统计 */
  sources: { readme: boolean; docs: number; manifest: string | null; gitLog: number; todos: number; structure: number }
  /** 探测到的语言（缺失诊断用） */
  language: string | null
  errors: string[]
}

/** 语言 → 清单文件候选（覆盖非 JS 生态，0.4.1） */
const MANIFESTS: Array<{ lang: string; file: string; parse: (d: Record<string, unknown>) => { name?: string; description?: string; deps: string[] } }> = [
  {
    lang: 'JavaScript/TypeScript',
    file: 'package.json',
    parse: (d) => ({
      name: typeof d.name === 'string' ? d.name : undefined,
      description: typeof d.description === 'string' ? d.description : undefined,
      deps: Object.keys((d.dependencies as Record<string, string>) ?? {}).concat(Object.keys((d.devDependencies as Record<string, string>) ?? {})),
    }),
  },
  {
    lang: 'Python',
    file: 'pyproject.toml',
    parse: (d) => {
      // 简化解析：项目名/描述/依赖从 toml 文本提取
      const raw = d as unknown as { _raw?: string }
      const nameMatch = raw._raw?.match(/^name\s*=\s*["']([^"']+)["']/m)
      const descMatch = raw._raw?.match(/^description\s*=\s*["']([^"']+)["']/m)
      // 只取 [dependencies] 段内的行（避免匹配到 [project] 下的 key）
      const depSection = raw._raw?.match(/\[dependencies\][\s\S]*?(?=\[[a-zA-Z]|$)/)?.[0] ?? ''
      const deps = Array.from(depSection.matchAll(/^\s*([a-zA-Z0-9_.-]+)\s*[=~<>]/gm) ?? []).map((m) => m[1]).slice(0, 8)
      return {
        name: nameMatch?.[1],
        description: descMatch?.[1],
        deps,
      }
    },
  },
  {
    lang: 'Python',
    file: 'requirements.txt',
    parse: (d) => {
      const raw = d as unknown as { _raw?: string }
      return { deps: (raw._raw?.split('\n') ?? []).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/[=~<>]/)[0]?.trim() ?? '').filter(Boolean).slice(0, 8) }
    },
  },
  {
    lang: 'Rust',
    file: 'Cargo.toml',
    parse: (d) => {
      const raw = d as unknown as { _raw?: string }
      const nameMatch = raw._raw?.match(/^name\s*=\s*["']([^"']+)["']/m)
      return { name: nameMatch?.[1], deps: Array.from(raw._raw?.matchAll(/^([a-zA-Z0-9_-]+)\s*=\s*[\{0-9"]/gm) ?? []).map((m) => m[1]).filter((x) => x !== 'name' && x !== 'version').slice(0, 8) }
    },
  },
  {
    lang: 'Go',
    file: 'go.mod',
    parse: (d) => {
      const raw = d as unknown as { _raw?: string }
      const nameMatch = raw._raw?.match(/^module\s+(\S+)/m)
      return { name: nameMatch?.[1]?.split('/').pop(), deps: Array.from(raw._raw?.matchAll(/^\s*([a-zA-Z0-9_.\/-]+)\s+v[0-9]/gm) ?? []).map((m) => m[1]).slice(0, 8) }
    },
  },
  {
    lang: 'Ruby',
    file: 'Gemfile',
    parse: (d) => {
      const raw = d as unknown as { _raw?: string }
      return { deps: Array.from(raw._raw?.matchAll(/^\s*gem\s+["']([^"']+)["']/gm) ?? []).map((m) => m[1]).slice(0, 8) }
    },
  },
]

// ===== collector：采集源 =====

function readFileSafe(p: string, maxBytes = 30_000): string | undefined {
  try {
    const buf = readFileSync(p, 'utf-8')
    return buf.length > maxBytes ? buf.slice(0, maxBytes) : buf
  } catch {
    return undefined
  }
}

function collectReadme(root: string): { found: boolean; text?: string } {
  for (const name of ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README']) {
    const p = join(root, name)
    if (existsSync(p)) {
      const text = readFileSafe(p)
      return { found: true, text }
    }
  }
  return { found: false }
}

function collectDocs(root: string, maxFiles: number): { files: number; texts: string[] } {
  const docsDir = join(root, 'docs')
  if (!existsSync(docsDir)) return { files: 0, texts: [] }
  const texts: string[] = []
  let count = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || count >= maxFiles) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (count >= maxFiles) return
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) {
          if (name === 'node_modules' || name.startsWith('.') || name === 'dist' || name === 'build') continue
          walk(p, depth + 1)
        } else if (/\.(md|mdx|txt)$/.test(name)) {
          const text = readFileSafe(p, 20_000)
          if (text) {
            texts.push(`# ${name}\n${text}`)
            count += 1
          }
        }
      } catch {
        // 跳过不可读
      }
    }
  }
  walk(docsDir, 0)
  return { files: count, texts }
}

function collectManifest(root: string): { found: boolean; file: string | null; lang: string | null; name?: string; description?: string; deps: string[]; scripts: string[] } {
  // 按顺序探测各生态清单文件（0.4.1 语言感知）
  for (const m of MANIFESTS) {
    const p = join(root, m.file)
    if (!existsSync(p)) continue
    try {
      if (m.file.endsWith('.json')) {
        const data = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
        const parsed = m.parse(data)
        return {
          found: true,
          file: m.file,
          lang: m.lang,
          name: parsed.name,
          description: parsed.description,
          deps: parsed.deps,
          scripts: typeof data.scripts === 'object' && data.scripts !== null ? Object.values(data.scripts as Record<string, string>) : [],
        }
      }
      // toml / txt / mod：把原始文本塞进 _raw 再走 parse
      const raw = readFileSync(p, 'utf-8')
      const parsed = m.parse({ _raw: raw } as Record<string, unknown>)
      return { found: true, file: m.file, lang: m.lang, name: parsed.name, description: parsed.description, deps: parsed.deps, scripts: [] }
    } catch {
      return { found: false, file: m.file, lang: m.lang, deps: [], scripts: [] }
    }
  }
  return { found: false, file: null, lang: null, deps: [], scripts: [] }
}

/** 探测项目主语言（按源码文件扩展名统计；排除清单/配置） */
function detectLanguage(root: string): string | null {
  const counts = new Map<string, number>()
  const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.rb', '.java', '.kt', '.swift', '.php', '.c', '.cpp', '.h', '.hpp', '.cs', '.vue', '.svelte'])
  let scanned = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || scanned >= 50) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (scanned >= 50) return
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build' || name.startsWith('.')) continue
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p, depth + 1)
        else {
          const ext = extname(name).toLowerCase()
          if (SOURCE_EXT.has(ext)) counts.set(ext, (counts.get(ext) ?? 0) + 1)
          scanned += 1
        }
      } catch {
        // 跳过
      }
    }
  }
  walk(root, 0)
  const EXT_LANG: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
    '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.rb': 'Ruby', '.java': 'Java',
    '.kt': 'Kotlin', '.swift': 'Swift', '.php': 'PHP', '.c': 'C', '.cpp': 'C++', '.cs': 'C#',
  }
  let best: { lang: string; count: number } | null = null
  for (const [ext, lang] of Object.entries(EXT_LANG)) {
    const count = counts.get(ext) ?? 0
    if (count > 0 && (!best || count > best.count)) best = { lang, count }
  }
  return best?.lang ?? null
}

/** 轻量结构信号：顶层目录 + 源码文件扩展名（0.4.1 ③；只统计源码扩展名，排除清单/配置） */
function collectStructure(root: string): { dirs: string[]; extensions: string[] } {
  const dirs: string[] = []
  const exts = new Map<string, number>()
  const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.rb', '.java', '.kt', '.swift', '.php', '.c', '.cpp', '.h', '.hpp', '.cs', '.vue', '.svelte'])
  try {
    for (const name of readdirSync(root)) {
      const p = join(root, name)
      const st = statSync(p)
      if (st.isDirectory() && !name.startsWith('.') && !['node_modules', 'dist', 'build', 'coverage'].includes(name)) {
        dirs.push(name)
      } else if (st.isFile()) {
        const ext = extname(name).toLowerCase()
        if (SOURCE_EXT.has(ext)) exts.set(ext, (exts.get(ext) ?? 0) + 1)
      }
    }
  } catch {
    // 跳过
  }
  return {
    dirs: dirs.slice(0, 10),
    extensions: [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e]) => e),
  }
}

function collectGitLog(root: string, max = 30): { count: number; messages: string[] } {
  try {
    const out = execFileSync('git', ['log', '--oneline', '-n', String(max)], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const messages = out.split('\n').filter((l) => l.trim()).slice(0, max)
    return { count: messages.length, messages }
  } catch {
    return { count: 0, messages: [] }
  }
}

const TODO_REGEX = /\b(TODO|FIXME|HACK|XXX)\b[:\-]?\s*([^\n]{0,120})/gi

function collectTodos(root: string, maxFiles: number, maxTodos: number): { count: number; items: string[] } {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', '.turbo'])
  const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.lock', '.map', '.min.js'])
  const items: string[] = []
  let scanned = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || scanned >= maxFiles || items.length >= maxTodos) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (scanned >= maxFiles || items.length >= maxTodos) return
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) {
          walk(p, depth + 1)
        } else {
          const ext = extname(name)
          if (SKIP_EXT.has(ext)) continue
          scanned += 1
          const text = readFileSafe(p, 50_000)
          if (!text) continue
          for (const m of text.matchAll(TODO_REGEX)) {
            const label = m[1]?.toUpperCase() ?? 'TODO'
            const detail = (m[2] ?? '').trim()
            if (detail.length < 3) continue
            items.push(`${label}: ${detail}（${name}）`)
            if (items.length >= maxTodos) break
          }
        }
      } catch {
        // 跳过不可读
      }
    }
  }
  walk(root, 0)
  return { count: items.length, items }
}

// ===== normalizer：规则归一为候选 =====

function normalizeReadme(text?: string, pkgName?: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = []
  if (!text) return out
  // 项目名/描述 → fact
  const firstLine = text.split('\n').find((l) => /^#\s+/.test(l.trim()))
  if (firstLine) {
    const name = firstLine.replace(/^#\s+/, '').trim().slice(0, 80)
    if (name.length >= 2) {
      out.push({ content: `项目 ${name}（README 标题）`, type: 'fact', priority: 70 })
    }
  }
  // 首个非空段落（描述）→ fact
  const descMatch = text.match(/([^\n#]{20,200})/)
  if (descMatch) {
    const desc = descMatch[1].trim()
    if (desc.length >= 20 && !desc.startsWith('```')) {
      out.push({ content: `项目简介：${desc.slice(0, 150)}`, type: 'fact', priority: 60 })
    }
  }
  // 技术栈关键词 → fact
  const techs = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'React', 'Next.js', 'Vue', 'Node.js', 'Bun', 'Docker', 'PostgreSQL', 'MySQL', 'Redis']
  for (const t of techs) {
    if (text.includes(t) && !out.some((c) => c.content.includes(t))) {
      out.push({ content: `项目使用 ${t}`, type: 'fact', priority: 50 })
    }
  }
  return out
}

function normalizePackage(pkg: { name?: string; description?: string; deps: string[]; scripts: string[] }): MemoryCandidate[] {
  const out: MemoryCandidate[] = []
  if (pkg.name && !pkg.name.startsWith('@')) {
    out.push({ content: `项目包名：${pkg.name}`, type: 'fact', priority: 70 })
  }
  if (pkg.description && pkg.description.length >= 5) {
    out.push({ content: `项目描述：${pkg.description.slice(0, 150)}`, type: 'fact', priority: 60 })
  }
  if (pkg.deps.length > 0) {
    const tech = pkg.deps.filter((d) => !d.startsWith('@types')).slice(0, 8).join(', ')
    if (tech) out.push({ content: `依赖技术栈：${tech}`, type: 'fact', priority: 55 })
  }
  // 测试/构建脚本信号 → sop
  const scriptText = pkg.scripts.join(' ')
  if (/test|spec|vitest|jest/.test(scriptText)) {
    out.push({ content: '项目有测试脚本（scripts 含 test/spec/vitest/jest）', type: 'sop', priority: 50 })
  }
  if (/lint|eslint|format|prettier/.test(scriptText)) {
    out.push({ content: '项目有 lint/format 脚本（代码风格约束）', type: 'sop', priority: 45 })
  }
  return out
}

function normalizeGitLog(messages: string[]): MemoryCandidate[] {
  const out: MemoryCandidate[] = []
  // 统计近期提交模式 → event（不发散，只提取稳定信号）
  const fixCount = messages.filter((m) => /fix|bug|修复|hotfix/i.test(m)).length
  const featCount = messages.filter((m) => /feat|feature|新增|add/i.test(m)).length
  if (messages.length >= 5) {
    if (fixCount >= 2) out.push({ content: `近期提交以修复为主（${fixCount}/${messages.length} 条 fix）`, type: 'event', priority: 45 })
    if (featCount >= 2) out.push({ content: `近期提交以新增功能为主（${featCount}/${messages.length} 条 feat）`, type: 'event', priority: 45 })
  }
  return out
}

// ===== 主入口 =====

export function extractRepoMemory(opts: RepoExtractOptions = {}): RepoExtractResult {
  const root = opts.root ? resolve(opts.root) : findProjectRoot(process.cwd())
  const maxFiles = opts.maxFiles ?? 200
  const maxTodos = opts.maxTodos ?? 20
  const errors: string[] = []
  const candidates: MemoryCandidate[] = []

  // 1. README
  const readme = collectReadme(root)
  candidates.push(...normalizeReadme(readme.text, undefined))

  // 2. docs/
  const docs = collectDocs(root, maxFiles)

  // 3. 语言感知清单文件（0.4.1：package.json / pyproject.toml / Cargo.toml / go.mod / Gemfile 等）
  const manifest = collectManifest(root)
  candidates.push(...normalizePackage(manifest))

  // 4. git log
  const git = collectGitLog(root)
  candidates.push(...normalizeGitLog(git.messages))

  // 5. TODO/FIXME 扫描（可选）
  let todoCount = 0
  if (opts.scanTodos !== false) {
    const todos = collectTodos(root, maxFiles, maxTodos)
    todoCount = todos.count
    for (const item of todos.items.slice(0, maxTodos)) {
      candidates.push({ content: `待办：${item.slice(0, 120)}`, type: 'todo_context', priority: 65 })
    }
  }

  // 6. 轻量结构信号（0.4.1：零文档项目也有项目指纹）
  const structure = collectStructure(root)
  const language = detectLanguage(root)
  if (structure.extensions.length > 0) {
    candidates.push({ content: `项目源码以 ${structure.extensions.join(', ')} 文件为主`, type: 'fact', priority: 40 })
  }
  if (structure.dirs.includes('src') && structure.dirs.includes('tests')) {
    candidates.push({ content: '项目有 src/ + tests/ 目录组织', type: 'fact', priority: 45 })
  }
  if (structure.dirs.includes('docs')) {
    candidates.push({ content: '项目有 docs/ 文档目录', type: 'fact', priority: 40 })
  }

  // 去重（同 content）
  const seen = new Set<string>()
  const dedup = candidates.filter((c) => {
    const k = c.content
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // 写入（pending 防投毒）或 dry-run
  let storedCount = 0
  if (!opts.dryRun && dedup.length > 0) {
    const result = captureCandidates(dedup, { scope: opts.scope }, { confirmed: false })
    storedCount = result.storedCount
  }

  return {
    candidates: dedup,
    storedCount,
    todoCount,
    sources: {
      readme: readme.found,
      docs: docs.files,
      manifest: manifest.file,
      gitLog: git.count,
      todos: todoCount,
      structure: structure.dirs.length + structure.extensions.length,
    },
    language,
    errors,
  }
}
