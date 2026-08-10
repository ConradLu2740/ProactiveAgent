/**
 * Memory Store — 长期记忆持久化层
 *
 * 存储布局（local-first，对齐 Proma 惯例）：
 * ```text
 * ~/.proma/memory/
 *   index.json            # 记忆索引（按需生成：写入开关/提取模式等配置时落盘；原子写 + .bak 容错）
 *   profile.md            # L3 用户画像
 *   atoms/{YYYY-MM-DD}.jsonl   # L1 原子记忆，按天分文件（append-only）
 *   scenes/{sceneId}.md   # L2 场景块
 *   corrections.json      # 行为纠正候选（待审批）
 *   memory_log/{YYYY-MM-DD}.md # 每日记忆变更日志
 * ```
 *
 * 设计原则：
 * - 同步优先（对齐 automation-manager 的 read/write-through 缓存模式）
 * - 崩溃安全（复用 safe-file 的原子写 + .tmp/.bak 容错）
 * - atoms 只追加；去重/更新在读取层做（fingerprint 定位后标记 superseded 或直接替换）
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { resetIndexCache } from './inverted-index'
import {
  getMemoryRootDir,
  getMemoryIndexPath,
  getMemoryAtomsDir,
  getMemoryAtomsDayPath,
  getMemoryScenesDir,
  getPersonaPath,
  getCorrectionsPath,
  getMemoryLogDir,
} from '../paths'
import { currentLayerKey, GLOBAL_KEY, isEscapeGlobal, isSingleLayerMode, getGlobalMemoryRootDir } from '../project'
import { readJsonFileSafe, writeJsonFileAtomic, writeTextFileAtomic } from '../safe-file'
import { readArchivedCount } from './ttl'
import type {
  MemoryAtom,
  MemoryAtomType,
  MemoryCorrection,
  MemoryStats,
  PersonaProfile,
  SceneBlock,
} from '../shared-types'

/** 记忆索引文件格式 */
interface MemoryIndex {
  version: number
  /** 最近一次 L1 提取时间（epoch ms） */
  lastExtractionAt: number
  /** 记忆启用状态 */
  enabled: boolean
  /** 提取模式：llm=LLM 提取（外发）、rule=仅规则版（零外发）、off=关闭提取 */
  extractionMode?: 'llm' | 'rule' | 'off'
  /** 是否把 persona 画像注入系统提示（默认 true；用户可关闭） */
  personaInjectionEnabled?: boolean
}

const INDEX_VERSION = 1

// ===== 日期工具 =====

/** 返回本地日期 key：YYYY-MM-DD */
export function localDateKey(ts: number = Date.now()): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ===== ID / 指纹 =====

/** 指纹归一化删除的语义虚词（LLM 措辞差异："是/使用/作为"等）
 * 注意：**绝不包含否定词**（不要/别/别再等）——否定是核心语义（硬约束）。
 * 长词放前避免"使用/作为"被拆成"用/作"。 */
const FINGERPRINT_STRIP =
  '作为|使用|采用|进行|需要|希望|想要|开始|打算|关于|以及|并且|而且|但是|因为|所以|然后|一个|一些|我们|你们|他们|的|了|是|和|与|及|或|在|用|做|它|他|她|这|那|会|要|能|可以|应该|可能|大概|现在|今天|帮|请|我|你'

/**
 * 归一化内容为指纹：小写 → 去标点空白 → 去语义虚词 → 截断。
 * 目的：让 LLM 不同措辞的等价表达收敛到同一指纹，支持跨批去重。
 */
export function fingerprintContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）《》【】,.!?;:"'()<>\[\]]/g, '')
    .replace(new RegExp(`(?:${FINGERPRINT_STRIP})`, 'g'), '')
    .slice(0, 120)
}

/** 生成 atom ID */
function generateAtomId(): string {
  return `atom_${Date.now()}_${randomUUID().slice(0, 8)}`
}

/** 生成 correction ID */
function generateCorrectionId(): string {
  return `corr_${Date.now()}_${randomUUID().slice(0, 8)}`
}

/** 判断两条记忆是否"实质重复"：指纹相同，或内容包含度 ≥ 0.9 */
export function isDuplicate(a: MemoryAtom, b: MemoryAtom): boolean {
  if (a.fingerprint && b.fingerprint && a.fingerprint === b.fingerprint) return true
  const ac = a.content.toLowerCase()
  const bc = b.content.toLowerCase()
  if (ac.length === 0 || bc.length === 0) return false
  const short = ac.length <= bc.length ? ac : bc
  const long = ac.length <= bc.length ? bc : ac
  if (short.length / long.length < 0.6) return false
  return long.includes(short) || short.includes(long)
}

// ===== 目录初始化 =====

function ensureMemoryDirs(): void {
  for (const dir of [getMemoryRootDir(), getMemoryAtomsDir(), getMemoryScenesDir(), getMemoryLogDir()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

// ===== 索引（0.3.0 键化：按层隔离缓存，防跨项目串数据） =====

type LayerKey = string // projectKey 或 GLOBAL_KEY

const memoryIndexCache = new Map<LayerKey, MemoryIndex | null>()
const correctionsCache = new Map<LayerKey, CorrectionsIndex | null>()

/** 清空全部内存缓存（测试/切换项目身份时调用） */
export function resetMemoryCache(): void {
  memoryIndexCache.clear()
  correctionsCache.clear()
}

function readIndex(): MemoryIndex {
  const key = currentLayerKey()
  if (memoryIndexCache.has(key)) return memoryIndexCache.get(key)!
  const data = readJsonFileSafe<MemoryIndex>(getMemoryIndexPath())
  if (!data || typeof data.version !== 'number') {
    const fresh: MemoryIndex = { version: INDEX_VERSION, lastExtractionAt: 0, enabled: true, extractionMode: 'llm', personaInjectionEnabled: true }
    memoryIndexCache.set(key, fresh)
    return fresh
  }
  if (data.version > INDEX_VERSION) {
    memoryIndexCache.set(key, data)
    return data
  }
  const norm: MemoryIndex = {
    version: INDEX_VERSION,
    lastExtractionAt: data.lastExtractionAt ?? 0,
    enabled: data.enabled ?? true,
    extractionMode: data.extractionMode ?? 'llm',
    personaInjectionEnabled: data.personaInjectionEnabled ?? true,
  }
  memoryIndexCache.set(key, norm)
  return norm
}

function writeIndex(index: MemoryIndex): void {
  const key = currentLayerKey()
  try {
    ensureMemoryDirs()
    memoryIndexCache.set(key, index)
    writeJsonFileAtomic(getMemoryIndexPath(), index)
  } catch (error) {
    memoryIndexCache.delete(key)
    console.error('[Memory] 写入索引失败:', error)
    throw new Error('写入记忆索引失败')
  }
}

/** 记忆是否启用（可在 index.json 中关闭） */
export function isMemoryEnabled(): boolean {
  return readIndex().enabled
}

/** 开关记忆 */
export function setMemoryEnabled(enabled: boolean): void {
  const index = readIndex()
  index.enabled = enabled
  writeIndex(index)
}

/** 当前提取模式 */
export function getExtractionMode(): 'llm' | 'rule' | 'off' {
  return readIndex().extractionMode ?? 'llm'
}

/** 设置提取模式 */
export function setExtractionMode(mode: 'llm' | 'rule' | 'off'): void {
  const index = readIndex()
  index.extractionMode = mode
  writeIndex(index)
}

/** persona 画像是否注入系统提示 */
export function isPersonaInjectionEnabled(): boolean {
  return readIndex().personaInjectionEnabled ?? true
}

/** 开关 persona 注入 */
export function setPersonaInjectionEnabled(enabled: boolean): void {
  const index = readIndex()
  index.personaInjectionEnabled = enabled
  writeIndex(index)
}

/** 最近一次提取时间 */
export function getLastExtractionAt(): number {
  return readIndex().lastExtractionAt
}

/** 标记提取完成 */
export function markExtractionCompleted(at: number = Date.now()): void {
  const index = readIndex()
  index.lastExtractionAt = at
  writeIndex(index)
}

// ===== L1 Atoms =====

/** 写入一条原子记忆（append 到当天文件；scope 指定目标层） */
export function writeAtom(
  atom: Omit<MemoryAtom, 'id' | 'createdAt' | 'updatedAt' | 'confirmed'> & { id?: string; confirmed?: boolean },
  opts: { scope?: 'project' | 'global' } = {},
): MemoryAtom {
  ensureMemoryDirs()
  const now = Date.now()
  const full: MemoryAtom = {
    ...atom,
    id: atom.id ?? generateAtomId(),
    createdAt: now,
    updatedAt: now,
    confirmed: atom.confirmed ?? (atom.type !== 'correction'),
    fingerprint: atom.fingerprint ?? fingerprintContent(atom.content),
    scope: opts.scope ?? 'project',
  }
  const atomsDir = opts.scope === 'global' ? getGlobalAtomsDir() : getMemoryAtomsDir()
  if (!existsSync(atomsDir)) mkdirSync(atomsDir, { recursive: true })
  const filePath = join(atomsDir, localDateKey() + '.jsonl')
  const line = JSON.stringify(full)
  const content = (existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '') + line + '\n'
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content, 'utf-8')
  try {
    // POSIX rename 原子替换
    renameSync(tmpPath, filePath)
  } catch (error) {
    console.error('[Memory] 写入 atom 失败:', error)
    throw new Error('写入记忆条目失败')
  }
  // M9：数据变更后使倒排索引缓存失效
  resetIndexCache()
  return full
}

/** 读取单层全部 L1 atoms（跨天文件，按创建时间倒序） */
function readLayerAtoms(layerRoot: string, opts: { includeUnconfirmed?: boolean } = {}): MemoryAtom[] {
  if (!existsSync(layerRoot)) return []
  const atoms: MemoryAtom[] = []
  for (const file of readdirSync(layerRoot)) {
    if (!file.endsWith('.jsonl')) continue
    const filePath = join(layerRoot, file)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const atom = JSON.parse(line) as MemoryAtom
          if (!opts.includeUnconfirmed && !atom.confirmed) continue
          atoms.push(atom)
        } catch {
          // 跳过损坏行
        }
      }
    } catch {
      // 跳过不可读文件
    }
  }
  return atoms.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 读取 L1 atoms，支持 scope（0.3.0）：
 * - project：当前项目层
 * - global：全局共享层
 * - auto（默认）：项目层 + global 层合并，按 fingerprint 去重、项目优先，global 条目标注 scope='global'
 */
export function readAllAtoms(opts: { includeUnconfirmed?: boolean; scope?: 'project' | 'global' | 'auto' } = {}): MemoryAtom[] {
  const scope = opts.scope ?? 'auto'
  // 单层模式（PROMA_MEMORY_DIR 显式 或 逃生 PROACTIVE_SCOPE=global）：全部数据在 getMemoryRootDir()/atoms，读写一致
  if (isSingleLayerMode() || isEscapeGlobal()) {
    return readLayerAtoms(getMemoryAtomsDir(), opts).map((a) => ({ ...a, scope: 'project' as const }))
  }
  if (scope === 'global') {
    return readLayerAtoms(getGlobalAtomsDir(), opts).map((a) => ({ ...a, scope: 'global' as const }))
  }
  if (scope === 'project') {
    return readLayerAtoms(getMemoryAtomsDir(), opts).map((a) => ({ ...a, scope: 'project' as const }))
  }
  // auto：双层合并，fingerprint 去重、project 优先
  const projectAtoms = readLayerAtoms(getMemoryAtomsDir(), opts).map((a) => ({ ...a, scope: 'project' as const }))
  const globalAtoms = readLayerAtoms(getGlobalAtomsDir(), opts).map((a) => ({ ...a, scope: 'global' as const }))
  const seen = new Set<string>()
  const merged: MemoryAtom[] = []
  for (const a of [...projectAtoms, ...globalAtoms]) {
    const fp = a.fingerprint ?? fingerprintContent(a.content)
    if (seen.has(fp)) continue
    seen.add(fp)
    merged.push(a)
  }
  return merged.sort((a, b) => b.createdAt - a.createdAt)
}

/** global 层 atoms 目录 */
function getGlobalAtomsDir(): string {
  return join(getGlobalMemoryRootDir(), 'atoms')
}

/** 按 ID 查 atom */
export function getAtomById(id: string): MemoryAtom | undefined {
  return readAllAtoms({ includeUnconfirmed: true }).find((a) => a.id === id)
}

/**
 * 尝试写入 atom，若与已有条目重复则更新已有条目并返回 { deduplicated: true, atom: 已有条目 }
 * 用于提取管道，避免 LLM 每轮重复提取同一事实。
 *
 * 0.3.0 scope 语义（对抗审查 #1 修正）：
 * - 跨层去重只影响 pending 提取（confirmed=false）：目标 project 且 global 有同指纹 → 跳过写入返回 source:'global'
 * - 显式 capture（confirmed=true）只查目标层内部去重，跨层重复时正常写入本层（项目覆盖语义），不吞写
 */
export function writeAtomWithDedup(
  atom: Omit<MemoryAtom, 'id' | 'createdAt' | 'updatedAt' | 'confirmed'> & { id?: string; confirmed?: boolean },
  opts: { scope?: 'project' | 'global'; forceScope?: boolean } = {},
): { deduplicated: boolean; atom: MemoryAtom; source?: 'project' | 'global' } {
  const confirmed = atom.confirmed ?? true
  const scope = opts.scope ?? 'project'
  const candidateFingerprint = fingerprintContent(atom.content)

  // 1. 目标层内部去重（写任何层都先查本层）
  const layerAtoms = readLayerAtoms(scope === 'global' ? getGlobalAtomsDir() : getMemoryAtomsDir(), { includeUnconfirmed: true })
  for (const prev of layerAtoms) {
    const prevFingerprint = prev.fingerprint ?? fingerprintContent(prev.content)
    if (isDuplicate(
      { ...prev, fingerprint: prevFingerprint } as MemoryAtom,
      { ...atom, fingerprint: candidateFingerprint, id: '', createdAt: 0, updatedAt: 0, confirmed: true } as MemoryAtom,
    )) {
      const updated: MemoryAtom = {
        ...prev,
        content: atom.content.length > prev.content.length ? atom.content : prev.content,
        priority: Math.max(prev.priority, atom.priority ?? 50),
        updatedAt: Date.now(),
        sessionId: atom.sessionId ?? prev.sessionId,
        workspaceSlug: atom.workspaceSlug ?? prev.workspaceSlug,
        scope: scope,
        metadata: { ...(prev.metadata ?? {}), ...(atom.metadata ?? {}) },
      }
      updateAtomById(prev.id, updated, scope)
      return { deduplicated: true, atom: updated, source: scope }
    }
  }

  // 2. 跨层去重：仅 pending 自动提取（confirmed=false）时检查另一层
  if (!confirmed) {
    const otherScope: 'project' | 'global' = scope === 'global' ? 'project' : 'global'
    const otherAtoms = readLayerAtoms(otherScope === 'global' ? getGlobalAtomsDir() : getMemoryAtomsDir(), { includeUnconfirmed: true })
    for (const prev of otherAtoms) {
      const prevFingerprint = prev.fingerprint ?? fingerprintContent(prev.content)
      if (isDuplicate(
        { ...prev, fingerprint: prevFingerprint } as MemoryAtom,
        { ...atom, fingerprint: candidateFingerprint, id: '', createdAt: 0, updatedAt: 0, confirmed: true } as MemoryAtom,
      )) {
        return { deduplicated: true, atom: prev, source: otherScope }
      }
    }
  }

  return { deduplicated: false, atom: writeAtom({ ...atom, scope }, { scope }) }
}

/** 替换某条 atom（按 id；找不到则追加） */
/** 列出待确认的自动提取记忆（pending atoms） */
export function listPendingAtoms(): MemoryAtom[] {
  return readAllAtoms({ includeUnconfirmed: true })
    .filter((a) => !a.confirmed)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 分页浏览全部记忆（记忆看板视图）。
 * 支持按类型过滤、按时间/优先级排序。
 */
export function listAtomsPaged(opts: {
  page?: number
  pageSize?: number
  type?: MemoryAtomType | 'all'
  sort?: 'newest' | 'priority'
  /** undefined=全部，true=仅已确认，false=仅待确认 */
  confirmed?: boolean
} = {}): { atoms: MemoryAtom[]; total: number; page: number; pageSize: number; totalPages: number } {
  const { page = 1, pageSize = 20, type = 'all', sort = 'newest', confirmed } = opts
  const safePage = Math.max(1, Math.floor(page))
  const safeSize = Math.min(Math.max(1, Math.floor(pageSize)), 100)
  let atoms = readAllAtoms({ includeUnconfirmed: true })
  if (confirmed !== undefined) atoms = atoms.filter((a) => a.confirmed === confirmed)
  if (type !== 'all') atoms = atoms.filter((a) => a.type === type)
  atoms = [...atoms].sort((a, b) =>
    sort === 'priority'
      ? (b.priority ?? 0) - (a.priority ?? 0) || b.createdAt - a.createdAt
      : b.createdAt - a.createdAt,
  )
  const total = atoms.length
  const totalPages = Math.max(1, Math.ceil(total / safeSize))
  const start = (safePage - 1) * safeSize
  return { atoms: atoms.slice(start, start + safeSize), total, page: safePage, pageSize: safeSize, totalPages }
}

/** 确认一条待确认记忆（用户认可后注入） */
export function confirmAtom(id: string): MemoryAtom | undefined {
  const atom = getAtomById(id)
  if (!atom) return undefined
  const updated: MemoryAtom = { ...atom, confirmed: true, updatedAt: Date.now() }
  // 🟡-4：按 atom 自身 scope 更新（迁移后 global 的 pending 不会在项目层产生副本）
  updateAtomById(id, updated, atom.scope === 'global' ? 'global' : 'project')
  return updated
}

/** 拒绝并删除一条待确认记忆 */
export function deleteAtom(id: string): boolean {
  // 🟡-4：按 atom 自身 scope 定位层（readAllAtoms auto 已带 scope）
  const target = getAtomById(id)
  const atomsDir = target?.scope === 'global' ? getGlobalAtomsDir() : getMemoryAtomsDir()
  const files = existsSync(atomsDir) ? readdirSync(atomsDir).filter((f) => f.endsWith('.jsonl')) : []
  for (const file of files) {
    const filePath = join(atomsDir, file)
    const lines = readFileSync(filePath, 'utf-8').split('\n')
    const kept = lines.filter((line) => {
      if (!line?.trim()) return false
      try {
        const parsed = JSON.parse(line) as MemoryAtom
        return parsed.id !== id
      } catch {
        return true
      }
    })
    if (kept.length !== lines.length) {
      const tmpPath = filePath + '.tmp'
      writeFileSync(tmpPath, kept.join('\n'), 'utf-8')
      renameSync(tmpPath, filePath)
      resetIndexCache()
      return true
    }
  }
  return false
}

export function updateAtomById(id: string, atom: MemoryAtom, scope?: 'project' | 'global'): MemoryAtom {
  ensureMemoryDirs()
  const atomsDir = scope === 'global' ? getGlobalAtomsDir() : getMemoryAtomsDir()
  // 找到该 atom 所在文件
  const files = existsSync(atomsDir) ? readdirSync(atomsDir).filter((f) => f.endsWith('.jsonl')) : []
  for (const file of files) {
    const filePath = join(atomsDir, file)
    const lines = readFileSync(filePath, 'utf-8').split('\n')
    let changed = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line?.trim()) continue
      try {
        const parsed = JSON.parse(line) as MemoryAtom
        if (parsed.id === id) {
          lines[i] = JSON.stringify(atom)
          changed = true
          break
        }
      } catch {
        // 跳过损坏行
      }
    }
    if (changed) {
      const tmpPath = filePath + '.tmp'
      writeFileSync(tmpPath, lines.join('\n'), 'utf-8')
      renameSync(tmpPath, filePath)
      resetIndexCache()
      return atom
    }
  }
  return writeAtom(atom, { scope })
}

// ===== L2 Scenes =====

/** 写入/更新一个场景块（markdown 文件） */
export function writeSceneBlock(scene: SceneBlock, markdown: string): SceneBlock {
  ensureMemoryDirs()
  const filePath = join(getMemoryScenesDir(), `${scene.id}.md`)
  writeJsonFileAtomic(filePath, { scene, markdown })
  return scene
}

/** 读取全部场景块 */
export function readAllScenes(): SceneBlock[] {
  if (!existsSync(getMemoryScenesDir())) return []
  const scenes: SceneBlock[] = []
  for (const file of readdirSync(getMemoryScenesDir())) {
    if (!file.endsWith('.md')) continue
    try {
      const data = readJsonFileSafe<{ scene: SceneBlock; markdown: string }>(join(getMemoryScenesDir(), file))
      if (data?.scene) scenes.push(data.scene)
    } catch {
      // 跳过损坏
    }
  }
  return scenes.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ===== L3 Persona =====

/** 读取 persona 原文（scope 指定层；默认当前项目层） */
export function readPersonaRaw(scope?: 'project' | 'global'): string | undefined {
  const filePath = scope === 'global' ? globalPersonaPath() : getPersonaPath()
  if (!existsSync(filePath)) return undefined
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return undefined
  }
}

/** global 层 persona 路径 */
function globalPersonaPath(): string {
  return join(getGlobalMemoryRootDir(), 'profile.md')
}

/** 写入 persona（scope 指定层）。自动带溯源版本标记 */
export function writePersona(markdown: string, scope?: 'project' | 'global'): void {
  ensureMemoryDirs()
  const body = markdown.trim()
  const header = `<!-- persona-version: 2 (src traceability) -->\n\n`
  const content = body.startsWith('<!-- persona-version:') ? body : header + body
  const filePath = scope === 'global' ? globalPersonaPath() : getPersonaPath()
  if (scope === 'global') {
    const dir = getGlobalMemoryRootDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  writeTextFileAtomic(filePath, content)
}

/** 检测 persona 是否为溯源版本（带 persona-version: 2 标记）。旧版返回 false 表示需要重生成。 */
export function isPersonaTraceable(): boolean {
  const raw = readPersonaRaw()
  if (!raw) return false
  return /persona-version:\s*2/.test(raw)
}

/** 删除 persona（用户控制：不再注入画像） */
export function deletePersona(scope?: 'project' | 'global'): boolean {
  const filePath = scope === 'global' ? globalPersonaPath() : getPersonaPath()
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 从 persona markdown 解析结构化摘要（供注入/展示）
 * 简易解析：一级标题 + 列表项；不追求完美，解析失败时返回空 profile。
 */
export function parsePersonaProfile(raw?: string): PersonaProfile {
  if (!raw) return { preferences: [], interactionRules: [], evolution: [], updatedAt: 0 }
  const preferences: string[] = []
  const interactionRules: string[] = []
  const evolution: string[] = []
  let section = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    // 识别一级与二级标题作为 section 名
    if (/^#{1,3}\s+/.test(trimmed)) {
      section = trimmed.replace(/^#{1,3}\s+/, '')
      continue
    }
    if (!trimmed.startsWith('- ') && !trimmed.startsWith('* ')) continue
    const item = trimmed.replace(/^[-*]\s+/, '').trim()
    if (!item) continue
    if (/偏好|preference|喜欢|偏好/i.test(section)) preferences.push(item)
    else if (/交互|协议|规则|protocol|rule|interaction/i.test(section)) interactionRules.push(item)
    else if (/演进|轨迹|evolution|阶段/i.test(section)) evolution.push(item)
  }
  // 粗取姓名与一句话定位
  let name: string | undefined
  let summary: string | undefined
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]?.trim() ?? ''
    const next = lines[i + 1]?.trim()
    if (!name && /^#+\s*用户/.test(t) && next && !next.startsWith('#')) {
      name = next.slice(0, 40)
    }
    if (!summary && /^#+\s*一句话/.test(t) && next && !next.startsWith('#')) {
      summary = next.slice(0, 120)
    }
  }
  return { name, summary, preferences, interactionRules, evolution, updatedAt: Date.now() }
}

// ===== Corrections =====

interface CorrectionsIndex {
  version: number
  corrections: MemoryCorrection[]
}

const CORRECTIONS_VERSION = 1

/** 纠正记录容量上限（防无限膨胀） */
const MAX_CORRECTIONS = 300

let cachedCorrections: CorrectionsIndex | null = null

function readCorrections(scope?: 'project' | 'global'): CorrectionsIndex {
  // 层语义 → 缓存键：project 用 currentLayerKey()（当前项目），global 用 GLOBAL_KEY
  const key = scope === 'global' ? GLOBAL_KEY : currentLayerKey()
  if (correctionsCache.has(key)) return correctionsCache.get(key)!
  const data = readJsonFileSafe<CorrectionsIndex>(correctionsPathForScope(scope))
  if (!data || !Array.isArray(data.corrections)) {
    const fresh: CorrectionsIndex = { version: CORRECTIONS_VERSION, corrections: [] }
    correctionsCache.set(key, fresh)
    return fresh
  }
  // schema 校验：过滤非法纠正记录，限制数量上限
  data.corrections = data.corrections.filter(isValidCorrection).slice(0, MAX_CORRECTIONS)
  correctionsCache.set(key, data)
  return data
}

/** corrections 路径按 scope 路由（global 层单独文件；默认当前层） */
function correctionsPathForScope(scope?: 'project' | 'global'): string {
  if (scope === 'global') {
    return join(getGlobalMemoryRootDir(), 'corrections.json')
  }
  return getCorrectionsPath()
}

/** 合法纠正记录：必须有 id、rule、status，状态为已知枚举 */
function isValidCorrection(r: unknown): r is MemoryCorrection {
  if (!r || typeof r !== 'object') return false
  const rec = r as Record<string, unknown>
  return (
    typeof rec.id === 'string' && rec.id.length > 0 &&
    typeof rec.rule === 'string' &&
    (rec.status === 'pending' || rec.status === 'active' || rec.status === 'rejected' || rec.status === 'superseded')
  )
}

function writeCorrections(index: CorrectionsIndex, scope?: 'project' | 'global'): void {
  // 与 readCorrections 同语义：project → currentLayerKey()，global → GLOBAL_KEY
  const key = scope === 'global' ? GLOBAL_KEY : currentLayerKey()
  try {
    correctionsCache.set(key, index)
    writeJsonFileAtomic(correctionsPathForScope(scope), index)
  } catch (error) {
    correctionsCache.delete(key)
    console.error('[Memory] 写入 corrections 失败:', error)
    throw new Error('写入行为纠正失败')
  }
}

/** 新增一条纠正候选（默认 pending） */
export function addCorrection(input: { raw: string; rule: string; sessionId?: string; scope?: 'project' | 'global' }): MemoryCorrection {
  ensureMemoryDirs()
  const scope = input.scope
  const index = readCorrections(scope)
  const correction: MemoryCorrection = {
    id: generateCorrectionId(),
    raw: input.raw,
    rule: input.rule,
    sessionId: input.sessionId,
    createdAt: Date.now(),
    status: 'pending',
  }
  index.corrections.unshift(correction)
  writeCorrections(index, scope)
  return correction
}

/** 读取纠正列表（可按状态过滤） */
export function listCorrections(status?: MemoryCorrection['status'], scope?: 'project' | 'global'): MemoryCorrection[] {
  const index = readCorrections(scope)
  const list = status ? index.corrections.filter((c) => c.status === status) : index.corrections
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
}

/** 更新纠正状态（确认/拒绝/替代） */
export function updateCorrectionStatus(id: string, status: MemoryCorrection['status'], scope?: 'project' | 'global'): MemoryCorrection | undefined {
  const index = readCorrections(scope)
  const target = index.corrections.find((c) => c.id === id)
  if (!target) return undefined
  target.status = status
  writeCorrections(index, scope)
  return target
}

/** 删除纠正（仅当用户明确要求时由上层调用） */
export function deleteCorrection(id: string): boolean {
  const index = readCorrections()
  const before = index.corrections.length
  index.corrections = index.corrections.filter((c) => c.id !== id)
  if (index.corrections.length === before) return false
  writeCorrections(index)
  return true
}

/** 清空全部记忆（atoms + corrections + persona，保留 index 与配置） */
export function clearAllMemory(): void {
  // 清空 atoms 按天文件
  if (existsSync(getMemoryAtomsDir())) {
    for (const file of readdirSync(getMemoryAtomsDir())) {
      if (file.endsWith('.jsonl')) {
        try {
          unlinkSync(join(getMemoryAtomsDir(), file))
        } catch {
          // 忽略单文件删除失败
        }
      }
    }
  }
  // 清空 corrections
  writeCorrections({ version: 1, corrections: [] })
  // 删除 persona（可重新生成）
  const profilePath = join(getMemoryRootDir(), 'profile.md')
  if (existsSync(profilePath)) {
    try {
      unlinkSync(profilePath)
    } catch {
      // 忽略
    }
  }
  resetIndexCache()
}

// ===== Stats / 清理 =====

/** 计算记忆统计 */
export function getMemoryStats(): MemoryStats {
  ensureMemoryDirs()
  const atoms = readAllAtoms({ includeUnconfirmed: true })
  const confirmed = atoms.filter((a) => a.confirmed)
  const byType: Record<MemoryAtomType, number> = {
    fact: 0,
    preference: 0,
    correction: 0,
    sop: 0,
    todo_context: 0,
    event: 0,
  }
  for (const a of confirmed) {
    if (byType[a.type] !== undefined) byType[a.type] += 1
  }
  return {
    atomCount: confirmed.length,
    byType,
    sceneCount: readAllScenes().length,
    pendingCorrections: listCorrections('pending').length,
    pendingAtoms: atoms.filter((a) => !a.confirmed).length,
    personaExists: !!readPersonaRaw(),
    rootDir: getMemoryRootDir(),
    lastExtractionAt: getLastExtractionAt(),
    // M9：归档数（惰性 require 避免与 ttl 的循环依赖；跟随 getGlobalAtomsDir 模式）
    archivedCount: (() => {
      try {
        return readArchivedCount()
      } catch {
        return 0
      }
    })(),
  }
}

/** 追加一行记忆日志（markdown） */
export function appendMemoryLog(entry: string): void {
  ensureMemoryDirs()
  const filePath = join(getMemoryLogDir(), `${localDateKey()}.md`)
  const line = `- ${new Date().toISOString()} ${entry}\n`
  const content = (existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '') + line
  writeFileSync(filePath, content, 'utf-8')
}

// ===== 记忆动态（v0.8.0：对标 Proma v0.17.0 memory watcher 可视化） =====

/** 单条记忆日志条目 */
export interface MemoryLogEntry {
  /** 日志时间（ISO） */
  at: string
  /** 日志文本（去前缀） */
  text: string
  /** 所在日志日期 YYYY-MM-DD */
  date: string
}

/** 记忆活动摘要（today 面板 / CLI stats / memory_stats 用） */
export interface MemoryActivitySummary {
  /** 最近一次记忆更新时间（epoch ms，0 = 无记忆） */
  lastUpdatedAt: number
  /** 距今天数（不足 1 天记 0） */
  daysSinceLastUpdate: number
  /** 今天新增/变更条数（memory_log 当日条目数） */
  todayEntries: number
  /** 最近 3 条日志条目（跨天，最新在前） */
  recentEntries: MemoryLogEntry[]
}

/** 读取最近 N 天记忆日志（默认 7 天） */
export function readMemoryLogRecent(days = 7, maxEntries = 50): MemoryLogEntry[] {
  const entries: MemoryLogEntry[] = []
  const logDir = getMemoryLogDir()
  if (!existsSync(logDir)) return entries
  const todayKey = localDateKey()
  for (let i = 0; i < days; i += 1) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    const dateKey = localDateKey(d.getTime())
    const filePath = join(logDir, `${dateKey}.md`)
    if (!existsSync(filePath)) continue
    let content = ''
    try { content = readFileSync(filePath, 'utf-8') } catch { continue }
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*-\s+(\S+)\s+(.+)$/)
      if (!match) continue
      entries.push({ at: match[1], text: match[2].trim(), date: dateKey })
      if (entries.length >= maxEntries) return entries
    }
  }
  return entries
}

/** 记忆活动摘要：最近更新时间取「最新日志时间 ∨ 最近 atom 写入时间」中较晚者 */
export function getMemoryActivity(): MemoryActivitySummary {
  const entries = readMemoryLogRecent(30, 200)
  const latestLogAt = entries[0] ? new Date(entries[0].at).getTime() : 0
  // 最近 atom 写入时间（按天文件 mtime 取最大）
  let latestAtomAt = 0
  const atomsDir = getMemoryAtomsDir()
  if (existsSync(atomsDir)) {
    try {
      for (const name of readdirSync(atomsDir)) {
        if (!name.endsWith('.jsonl')) continue
        try { latestAtomAt = Math.max(latestAtomAt, statSync(join(atomsDir, name)).mtimeMs) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  const lastUpdatedAt = Math.max(latestLogAt, latestAtomAt)
  const daysSinceLastUpdate = lastUpdatedAt > 0 ? Math.max(0, Math.floor((Date.now() - lastUpdatedAt) / (24 * 60 * 60 * 1000))) : 0
  const todayKey = localDateKey()
  // P2-5：todayEntries 独立统计当日日志文件行数，与 recentEntries（maxEntries=200 截断）解耦，避免超长日志被截断
  let todayEntries = 0
  const todayLogPath = join(getMemoryLogDir(), `${todayKey}.md`)
  if (existsSync(todayLogPath)) {
    try {
      const content = readFileSync(todayLogPath, 'utf-8')
      todayEntries = content.split('\n').filter((l) => /^\s*-\s+\S+\s+/.test(l)).length
    } catch { /* ignore */ }
  }
  return { lastUpdatedAt, daysSinceLastUpdate, todayEntries, recentEntries: entries.slice(0, 3) }
}
