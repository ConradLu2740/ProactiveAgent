/**
 * Project Constraint — 项目约束提取与冲突检测（2026-08-20）
 *
 * 目标：项目里明确「用 pnpm」→ 自动记住（项目级约束）；后期出现对立指令「用 npm」
 * → 主动提醒。约束提取用 LLM（用户指定：规则匹配准确性不足）；冲突命中用规则
 * （对立词对 + use/avoid 语义）——确定性，不靠 LLM 决定是否提醒。
 *
 * 隐私：会话原文只传给配置的 LLM（与 Proma 行为一致）；不进日志/通知/镜像。
 */

import { callLlm } from '@proactive-agent/core'
import type { SessionMessage } from './session-reader'

export interface ProjectConstraint {
  /** use=使用（应选）；avoid=避免（不应选） */
  action: 'use' | 'avoid'
  /** 规范化 subject（小写去空白，如 pnpm / typescript） */
  subject: string
  reason?: string
  confidence: number
}

/** 已存入项目层记忆的约束 */
export interface StoredConstraint {
  subject: string
  action: 'use' | 'avoid'
  decidedAt: number
  atomId: string
}

export interface ProjectConflict {
  projectKey: string
  projectName: string
  existing: StoredConstraint
  incoming: { subject: string; action: 'use' | 'avoid'; at: number }
}

// ===== 对立词对表（subject → 对立 subject 集；可扩展） =====

const OPPOSITE_SUBJECTS: Record<string, string[]> = {
  pnpm: ['npm', 'yarn'],
  npm: ['pnpm', 'yarn'],
  yarn: ['pnpm', 'npm'],
  bun: ['node', 'nodejs'],
  node: ['bun'],
  nodejs: ['bun'],
  typescript: ['javascript', 'js'],
  javascript: ['typescript', 'ts'],
  ts: ['javascript', 'js'],
  js: ['typescript', 'ts'],
  postgres: ['mysql'],
  postgresql: ['mysql'],
  mysql: ['postgres', 'postgresql'],
  docker: ['kubernetes', 'k8s'],
  kubernetes: ['docker'],
  k8s: ['docker'],
  react: ['vue', 'svelte'],
  vue: ['react'],
  svelte: ['react'],
  vitest: ['jest'],
  jest: ['vitest'],
  eslint: ['biome'],
  biome: ['eslint'],
}

/** 规范化 subject：小写 + 去空白/连字符/斜杠/点（typescript/TypeScript/ts 各自保留为键） */
export function normalizeSubject(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s\-_./\\]+/g, '')
}

/** 是否对立 subject（双向检查） */
export function isOppositeSubject(a: string, b: string): boolean {
  return (OPPOSITE_SUBJECTS[a] ?? []).includes(b) || (OPPOSITE_SUBJECTS[b] ?? []).includes(a)
}

/**
 * 冲突判定（纯规则，确定性）：
 * - 同一 subject：use X vs avoid X → 冲突（"用 pnpm" vs "不要用 pnpm"）
 * - 对立 subject：use A vs use B（A、B 对立，如 pnpm vs npm）→ 冲突
 * - avoid 与对立 use 不视为强冲突（"避免 pnpm" 不阻止用 npm）
 */
export function detectConflicts(
  incoming: ProjectConstraint[],
  existing: StoredConstraint[],
  ctx: { projectKey: string; projectName: string; at: number },
): ProjectConflict[] {
  const conflicts: ProjectConflict[] = []
  for (const inc of incoming) {
    for (const ex of existing) {
      const sameSubject = inc.subject === ex.subject
      const opposite = isOppositeSubject(inc.subject, ex.subject)
      const conflict =
        (sameSubject && inc.action !== ex.action) ||
        (opposite && inc.action === 'use' && ex.action === 'use')
      if (conflict) {
        conflicts.push({
          projectKey: ctx.projectKey,
          projectName: ctx.projectName,
          existing: ex,
          incoming: { subject: inc.subject, action: inc.action, at: ctx.at },
        })
      }
    }
  }
  return conflicts
}

/** 冲突去重键（项目 + 排序后的 subject 对 + 方向） */
export function conflictKey(conflict: ProjectConflict): string {
  const pair = [conflict.existing.subject, conflict.incoming.subject].sort().join('|')
  return `${conflict.projectKey}:${pair}:${conflict.existing.action}:${conflict.incoming.action}`
}

// ===== LLM 提取 =====

export function buildExtractPrompt(projectName: string): string {
  return `你从一段项目开发会话中提取「项目决策/约束」。

项目：${projectName}

约束是团队或用户明确决定的开发规范，例如：
- "用 pnpm" → { "action": "use", "subject": "pnpm" }
- "不要用 npm" → { "action": "avoid", "subject": "npm" }
- "统一用 TypeScript" → { "action": "use", "subject": "typescript" }

规则：
1. 只提取明确决策性语句（"用 / 统一用 / 以后用 / 不要用 / 禁止用 / 改用 / 坚持用"等）；
   闲聊、疑问、探索性讨论、无关内容一律不提取。
2. 否定必须保留："不要用 npm" 是 avoid npm，绝不能变成 use npm。
3. subject 用规范名（小写：typescript / javascript / postgresql 等）。
4. 若整段会话与项目「${projectName}」无关，返回 { "relevant": false }。
5. confidence 0-1：决策越明确越高。

输出严格 JSON（不要多余文字）：
{ "relevant": true, "constraints": [ { "action": "use", "subject": "pnpm", "reason": "可选", "confidence": 0.9 } ] }`
}

export interface ExtractResult {
  relevant: boolean
  constraints: ProjectConstraint[]
}

/** 解析 LLM 返回（容忍 markdown fence 与多余文字，取第一个 JSON 对象） */
export function parseConstraintsResponse(raw: string): ExtractResult | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as {
      relevant?: boolean
      constraints?: Array<{
        action?: unknown
        subject?: unknown
        reason?: unknown
        confidence?: unknown
      }>
    }
    const constraints: ProjectConstraint[] = Array.isArray(parsed.constraints)
      ? parsed.constraints
          .filter(
            (c): c is NonNullable<typeof c> & { action: 'use' | 'avoid'; subject: string } =>
              !!c &&
              (c.action === 'use' || c.action === 'avoid') &&
              typeof c.subject === 'string' &&
              c.subject.trim().length > 0,
          )
          .map((c) => ({
            action: c.action,
            subject: normalizeSubject(c.subject),
            reason: typeof c.reason === 'string' ? c.reason : undefined,
            confidence:
              typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.5,
          }))
      : []
    return { relevant: parsed.relevant !== false, constraints }
  } catch {
    return null
  }
}

/**
 * 从会话消息提取项目约束（LLM）。
 * LLM 未配置 / 调用失败 / 解析失败 → 返回 null（调用方降级为跳过本轮）。
 */
export async function extractConstraintsFromSession(
  messages: SessionMessage[],
  projectName: string,
): Promise<ExtractResult | null> {
  if (messages.length === 0) return null
  const text = messages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
    .join('\n\n')
  const raw = await callLlm(buildExtractPrompt(projectName), text, {
    temperature: 0.2,
    maxTokens: 4096,
  })
  if (!raw) return null
  return parseConstraintsResponse(raw)
}
