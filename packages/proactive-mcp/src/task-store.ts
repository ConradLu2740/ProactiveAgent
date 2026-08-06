/**
 * Task Store — 建议动作的本地落地层（P0-1 修复）
 *
 * 背景：v0.5.1 发布后没有任何宿主真正调用 setActionExecutorProvider，
 * suggest_accept 对 automation/todo 建议永远只返回"可执行指令文本"，
 * 接受建议 ≠ 真正创建任务（缺口分析 P0-1）。
 *
 * 本模块提供最小闭环：
 * - 接受 automation/todo 建议 → 写入本地任务队列（PROACTIVE_DATA_DIR/tasks.json）
 * - 返回真实资源引用（refId = 任务 ID），/today 面板可见
 * - 宿主未来注入真实执行器（如 Proma automation API）时，仍通过
 *   setActionExecutorProvider 优先走宿主；本模块作为默认兜底执行器。
 *
 * 数据格式（单文件，跨项目共用；任务本身是用户级资源）：
 *   { version: 1, tasks: [{ id, kind, title, prompt?, cron?, dueAt?, status, createdAt, projectHint? }] }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '@proactive-agent/core'

export type TaskKind = 'automation' | 'todo'

export interface TaskRecord {
  id: string
  kind: TaskKind
  title: string
  /** automation：执行指令；todo：补充说明 */
  prompt?: string
  cron?: string
  dueAt?: number
  status: 'pending' | 'done'
  createdAt: number
  projectHint?: string
}

interface TaskFile {
  version: 1
  tasks: TaskRecord[]
}

function taskPath(): string {
  return join(getConfigDir(), 'tasks.json')
}

function readTasks(): TaskFile {
  try {
    const p = taskPath()
    if (!existsSync(p)) return { version: 1, tasks: [] }
    const data = JSON.parse(readFileSync(p, 'utf-8')) as TaskFile
    return { version: 1, tasks: Array.isArray(data.tasks) ? data.tasks : [] }
  } catch {
    return { version: 1, tasks: [] }
  }
}

function writeTasks(file: TaskFile): void {
  try {
    const p = taskPath()
    mkdirSync(getConfigDir(), { recursive: true })
    writeFileSync(p, JSON.stringify(file, null, 2), 'utf-8')
  } catch (error) {
    // 写盘失败不抛到调用方（接受建议的主流程不能被本地存储拖垮）
    console.warn('[task-store] 写入任务失败:', error instanceof Error ? error.message : error)
  }
}

function newId(kind: TaskKind): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 列出任务（pending 在前，按创建时间倒序） */
export function listTasks(): TaskRecord[] {
  return readTasks().tasks
    .slice()
    .sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === 'pending' ? -1 : 1))
}

/** 创建一条 automation 任务（本地落地，可被宿主外部系统接管前的最小真实资源） */
export function addAutomation(input: {
  title: string
  prompt: string
  cron?: string
  dueAt?: number
  projectHint?: string
}): TaskRecord {
  const file = readTasks()
  const task: TaskRecord = {
    id: newId('automation'),
    kind: 'automation',
    title: input.title || '定时任务',
    prompt: input.prompt,
    cron: input.cron,
    dueAt: input.dueAt,
    status: 'pending',
    createdAt: Date.now(),
    projectHint: input.projectHint,
  }
  file.tasks.push(task)
  writeTasks(file)
  return task
}

/** 创建一条 todo 任务 */
export function addTodo(input: {
  title: string
  notes?: string
  dueAt?: number
  projectHint?: string
}): TaskRecord {
  const file = readTasks()
  const task: TaskRecord = {
    id: newId('todo'),
    kind: 'todo',
    title: input.title || '待办事项',
    prompt: input.notes,
    dueAt: input.dueAt,
    status: 'pending',
    createdAt: Date.now(),
    projectHint: input.projectHint,
  }
  file.tasks.push(task)
  writeTasks(file)
  return task
}

/** 标记完成（用户/宿主完成后调用） */
export function markTaskDone(id: string): boolean {
  const file = readTasks()
  const task = file.tasks.find((t) => t.id === id)
  if (!task) return false
  task.status = 'done'
  writeTasks(file)
  return true
}

/** 任务统计（/today 面板用） */
export function taskStats(): { pending: number; done: number; total: number } {
  const tasks = readTasks().tasks
  return {
    pending: tasks.filter((t) => t.status === 'pending').length,
    done: tasks.filter((t) => t.status === 'done').length,
    total: tasks.length,
  }
}
