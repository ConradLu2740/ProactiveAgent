/**
 * ProactiveAgent /today Web 面板
 *
 * 本地 HTTP server 提供主动中心摘要页（跨宿主通用——任何 agent 项目的用户
 * 都可以打开 http://localhost:PORT/today 查看主动中心）。
 *
 * 路由：
 * - GET /today  → HTML 页面
 * - GET /api/today → JSON 数据
 *
 * 零依赖：仅用 node:http + core 引擎。
 */

import { createServer, type Server } from 'node:http'
import { memoryService, suggestService, getConfigDir, getProjectIdentity } from '@proactive-agent/core'
import { listTasks, taskStats } from './task-store'

/** 构建 /api/today 数据负载 */
export function buildTodayPayload(): {
  generatedAt: string
  dataDir: string
  project: { key: string; displayName: string; identitySource: string }
  suggestions: Array<{ id: string; kind: string; title: string; reason: string; status: string }>
  hotScenes: Array<{ title: string; heat: number; atomCount: number }>
  persona: { exists: boolean; summary: string }
  stats: { atomCount: number; byType: Record<string, number>; pendingAtoms: number; pendingCorrections: number }
  activity: { lastUpdatedAt: number; daysSinceLastUpdate: number; todayEntries: number; recentEntries: Array<{ at: string; text: string; date: string }> }
  review: { daysSince: number; reviewDue: boolean; message: string } | undefined
  personaOverload: { overloaded: boolean; lineCount: number; sectionCount: number; hint: string }
  tasks: { pending: number; done: number; items: Array<{ id: string; kind: string; title: string; status: string }> }
  roi: {
    funnel: { suggested: number; accepted: number; ignored: number; never: number }
    byType: Array<{ kind: string; suggested: number; accepted: number; rate: number }>
    acceptRate: number
    disturbRate: number
    sufficient: boolean
    shouldReduceBudget: boolean
    days: number
  }
} {
  const suggestions = suggestService
    .listSuggestionsForUI('suggested')
    .slice(0, 10)
    .map((r) => ({ id: r.id, kind: r.kind, title: r.title, reason: r.reason, status: r.status }))
  const hotScenes = memoryService.getHotScenes({ limit: 6 }).map((s) => ({
    title: s.title,
    heat: s.heat,
    atomCount: s.atomIds.length,
  }))
  const personaRaw = memoryService.personaRaw()
  const persona = memoryService.persona()
  const stats = memoryService.stats()
  const activity = memoryService.memoryActivity()
  const review = memoryService.memoryReviewOpportunity()
  const personaOverload = memoryService.personaOverloadHint()
  const tasks = listTasks()
  const ts = taskStats()
  const roi = suggestService.getSuggestionRoiStats()
  const identity = getProjectIdentity()
  return {
    generatedAt: new Date().toISOString(),
    dataDir: getConfigDir(),
    // P2-3：面板展示当前项目标识（多项目隔离时明确数据范围）
    project: { key: identity.key, displayName: identity.displayName, identitySource: identity.identitySource },
    suggestions,
    hotScenes,
    persona: { exists: !!personaRaw, summary: persona.summary ?? '' },
    stats: {
      atomCount: stats.atomCount,
      byType: stats.byType ?? {},
      pendingAtoms: stats.pendingAtoms ?? 0,
      pendingCorrections: stats.pendingCorrections ?? 0,
    },
    activity: {
      lastUpdatedAt: activity.lastUpdatedAt,
      daysSinceLastUpdate: activity.daysSinceLastUpdate,
      todayEntries: activity.todayEntries,
      recentEntries: activity.recentEntries.map((e) => ({ at: e.at, text: e.text, date: e.date })),
    },
    review,
    personaOverload,
    tasks: {
      pending: ts.pending,
      done: ts.done,
      items: tasks.slice(0, 10).map((t) => ({ id: t.id, kind: t.kind, title: t.title, status: t.status })),
    },
    roi,
  }
}

const KIND_LABEL: Record<string, string> = {
  correction: '纠正建议',
  followup: '跟进建议',
  automation: '自动化建议',
  skill: '技能建议',
  todo: '待办建议',
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 构建 /today HTML 页面（内联样式，无外部依赖；带 15s 自动刷新） */
export function buildTodayHtml(): string {
  const p = buildTodayPayload()
  const dateStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  const suggestionCards = p.suggestions.length
    ? p.suggestions
        .map(
          (s) => `
        <div class="card sug">
          <div class="sug-kind">${esc(KIND_LABEL[s.kind] ?? s.kind)}</div>
          <div class="sug-title">${esc(s.title)}</div>
          <div class="sug-reason">${esc(s.reason)}</div>
          <div class="sug-id">${esc(s.id)}</div>
        </div>`,
        )
        .join('')
    : '<div class="empty">暂无待处理建议 —— 该沉默时沉默。</div>'

  const sceneItems = p.hotScenes.length
    ? p.hotScenes
        .map(
          (s) => `
        <div class="card scene">
          <div class="scene-title">${esc(s.title)}</div>
          <div class="scene-meta">热度 ${s.heat} · ${s.atomCount} 条记忆</div>
        </div>`,
        )
        .join('')
    : '<div class="empty">暂无热点场景。</div>'

  const taskItems = p.tasks.items.length
    ? p.tasks.items
        .map(
          (t) => `
        <div class="card task">
          <div class="sug-kind">${esc(t.kind === 'automation' ? '定时任务' : '待办')}</div>
          <div class="sug-title">${esc(t.title)}</div>
          <div class="sug-id">#${esc(t.id)} · ${t.status === 'done' ? '已完成' : '待处理'}</div>
        </div>`,
        )
        .join('')
    : '<div class="empty">暂无已落地任务（接受 automation/todo 建议后自动创建）。</div>'

  const byType = Object.entries(p.stats.byType)
    .filter(([, n]) => (n as number) > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ProactiveAgent · 主动中心</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f1115; color: #e6e8eb; padding: 24px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 4px; color: #fff; }
  .sub { color: #8b93a1; font-size: 12px; margin-bottom: 24px; }
  h2 { font-size: 14px; margin: 20px 0 10px; color: #9aa4b2; font-weight: 600; }
  .card { background: #171b22; border: 1px solid #242a35; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
  .sug-kind { display: inline-block; font-size: 11px; color: #4dabf7; background: rgba(77,171,247,.12); border-radius: 4px; padding: 2px 8px; margin-bottom: 6px; }
  .sug-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .sug-reason { font-size: 13px; color: #aab2c0; line-height: 1.5; }
  .sug-id { font-size: 11px; color: #5c6470; margin-top: 8px; font-family: ui-monospace, monospace; }
  .scene-title { font-size: 14px; font-weight: 600; }
  .scene-meta { font-size: 12px; color: #8b93a1; margin-top: 4px; }
  .empty { color: #5c6470; font-size: 13px; padding: 12px 2px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .stat { background: #171b22; border: 1px solid #242a35; border-radius: 10px; padding: 12px 16px; }
  .stat-n { font-size: 22px; font-weight: 700; color: #4dabf7; }
  .stat-l { font-size: 12px; color: #8b93a1; margin-top: 2px; }
  .persona { font-size: 13px; line-height: 1.6; color: #aab2c0; white-space: pre-wrap; }
  a { color: #4dabf7; }
</style>
</head>
<body>
  <h1>ProactiveAgent · 主动中心</h1>
  <div class="sub" id="meta-time">${esc(dateStr)} · 数据目录 ${esc(p.dataDir)}</div>
  <div class="sub" id="meta-project">项目 ${esc(p.project.displayName)}（key=${esc(p.project.key)} · ${esc(p.project.identitySource)}）</div>

  <h2>待处理建议（<span id="sug-count">${p.suggestions.length}</span>）</h2>
  <div id="suggestions">
    ${suggestionCards}
  </div>

  <h2>近期热点场景</h2>
  <div id="scenes">
    ${sceneItems}
  </div>

  <h2>已落地任务（<span id="task-count">${p.tasks.pending}</span> 待处理）</h2>
  <div id="tasks">
    ${taskItems}
  </div>

  <h2>记忆动态</h2>
  <div id="review-box" class="card" style="border-color:#ffa94d55;color:#ffa94d;font-size:13px;${p.review ? '' : 'display:none;'}">${p.review ? esc(p.review.message) : ''}</div>
  <div class="card">
    <div class="sug-kind" id="activity-summary">今日 ${p.activity.todayEntries} 条动态 · 距上次更新 ${p.activity.daysSinceLastUpdate} 天</div>
    <div id="activity-overload" style="margin-top:6px;">${p.personaOverload.overloaded ? `<div class="sub" style="color:#ffa94d;">⚠️ 画像已超载（${p.personaOverload.lineCount} 行 / ${p.personaOverload.sectionCount} 章节），建议精简重整。</div>` : ''}</div>
    <div id="activity-list">${p.activity.recentEntries.length
      ? p.activity.recentEntries
          .map((e) => `<div class="scene-meta" style="margin-top:4px;">[${esc(e.date)}] ${esc(e.text)}</div>`)
          .join('')
      : '<div class="empty">暂无记忆动态——沉淀记忆后这里会显示变更记录。</div>'}</div>
  </div>

  <h2>记忆统计</h2>
  <div class="grid">
    <div class="stat"><div class="stat-n" id="stats-count">${p.stats.atomCount}</div><div class="stat-l">原子记忆</div></div>
    <div class="stat"><div class="stat-n" id="stats-pending">${p.stats.pendingAtoms + p.stats.pendingCorrections}</div><div class="stat-l">待确认（记忆+纠正）</div></div>
  </div>
  <div class="sub" id="stats-bytype" style="margin-top:8px;">${esc(byType)}</div>

  <h2>建议 ROI（近 ${p.roi.days} 天）</h2>
  <div class="grid">
    <div class="stat"><div class="stat-n" style="color:#8b93a1">${p.roi.funnel.suggested}</div><div class="stat-l">建议数</div></div>
    <div class="stat"><div class="stat-n" style="color:#51cf66">${Math.round(p.roi.acceptRate * 100)}%</div><div class="stat-l">接受率（${p.roi.funnel.accepted} 接受 / ${p.roi.funnel.accepted + p.roi.funnel.ignored + p.roi.funnel.never} 反馈）</div></div>
  </div>
  <div class="grid" style="margin-top:10px;">
    <div class="stat"><div class="stat-n" style="color:#ffa94d">${p.roi.funnel.ignored}</div><div class="stat-l">忽略</div></div>
    <div class="stat"><div class="stat-n" style="color:#ff6b6b">${p.roi.funnel.never}</div><div class="stat-l">永不建议</div></div>
  </div>
  <div id="roi-types" style="margin-top:10px;">
    ${p.roi.byType
      .map(
        (t) =>
          `<div class="card" style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;"><span>${esc(KIND_LABEL[t.kind] ?? t.kind)}</span><span style="font-size:12px;color:#8b93a1">${t.accepted}/${t.suggested} 接受 · ${Math.round(t.rate * 100)}%</span></div>`,
      )
      .join('')}
  </div>
  <div id="roi-alert" style="margin-top:10px;">${p.roi.sufficient && p.roi.shouldReduceBudget ? '<div class="card" style="border-color:#ff6b6b55;color:#ffa94d;font-size:13px;">⚠️ 接受率低于 30%，已自动提高建议门槛（减少打扰）。</div>' : p.roi.sufficient ? '<div class="card" style="color:#8b93a1;font-size:13px;">接受率正常，保持当前节奏。</div>' : '<div class="card" style="color:#5c6470;font-size:13px;">反馈样本不足（&lt;5），暂不评估打扰水平。</div>'}</div>

  <h2>用户画像</h2>
  <div class="card">
    <div class="persona" id="persona">${p.persona.exists ? esc(p.persona.summary || '（已生成，无摘要）') : '尚未生成用户画像。'}</div>
  </div>

  <div class="sub" style="margin-top:24px;">API: <a href="/api/today">/api/today</a> · 每 15 秒自动刷新 · 由 @proactive-agent/mcp 提供</div>
<script>
const KIND = { correction:'纠正建议', followup:'跟进建议', automation:'自动化建议', skill:'技能建议', todo:'待办建议' };
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function render(p){
  document.getElementById('meta-time').textContent = new Date().toLocaleString('zh-CN') + ' · 数据目录 ' + p.dataDir;
  document.getElementById('meta-project').textContent = '项目 ' + p.project.displayName + '（key=' + p.project.key + ' · ' + p.project.identitySource + '）';
  const sug = document.getElementById('suggestions');
  sug.innerHTML = p.suggestions.length
    ? p.suggestions.map(s=>'<div class="card sug"><div class="sug-kind">'+esc(KIND[s.kind]||s.kind)+'</div><div class="sug-title">'+esc(s.title)+'</div><div class="sug-reason">'+esc(s.reason)+'</div><div class="sug-id">'+esc(s.id)+'</div></div>').join('')
    : '<div class="empty">暂无待处理建议 —— 该沉默时沉默。</div>';
  document.getElementById('sug-count').textContent = p.suggestions.length;
  document.getElementById('scenes').innerHTML = p.hotScenes.length
    ? p.hotScenes.map(s=>'<div class="card scene"><div class="scene-title">'+esc(s.title)+'</div><div class="scene-meta">热度 '+s.heat+' · '+s.atomCount+' 条记忆</div></div>').join('')
    : '<div class="empty">暂无热点场景。</div>';
  const tasks = p.tasks||{items:[],pending:0};
  document.getElementById('task-count').textContent = tasks.pending;
  document.getElementById('tasks').innerHTML = (tasks.items||[]).length
    ? tasks.items.map(t=>'<div class="card task"><div class="sug-kind">'+(t.kind==='automation'?'定时任务':'待办')+'</div><div class="sug-title">'+esc(t.title)+'</div><div class="sug-id">#'+esc(t.id)+' · '+(t.status==='done'?'已完成':'待处理')+'</div></div>').join('')
    : '<div class="empty">暂无已落地任务（接受 automation/todo 建议后自动创建）。</div>';
  const bt = Object.entries(p.stats.byType||{}).filter(([,n])=>n>0).map(([k,n])=>k+' '+n).join(' · ');
  document.getElementById('stats-bytype').textContent = bt;
  document.getElementById('stats-count').textContent = p.stats.atomCount;
  document.getElementById('stats-pending').textContent = (p.stats.pendingAtoms||0) + (p.stats.pendingCorrections||0);
  // 记忆动态 + 复查（v0.8.0）
  const reviewBox = document.getElementById('review-box');
  if (reviewBox) { reviewBox.textContent = p.review ? p.review.message : ''; reviewBox.style.display = p.review ? '' : 'none'; }
  const actSummary = document.getElementById('activity-summary');
  if (actSummary && p.activity) actSummary.textContent = '今日 ' + p.activity.todayEntries + ' 条动态 · 距上次更新 ' + p.activity.daysSinceLastUpdate + ' 天';
  const actOverload = document.getElementById('activity-overload');
  if (actOverload && p.personaOverload) {
    actOverload.innerHTML = p.personaOverload.overloaded
      ? '<div class="sub" style="color:#ffa94d;">⚠️ 画像已超载（' + p.personaOverload.lineCount + ' 行 / ' + p.personaOverload.sectionCount + ' 章节），建议精简重整。</div>'
      : '';
  }
  const actList = document.getElementById('activity-list');
  if (actList && p.activity) {
    actList.innerHTML = (p.activity.recentEntries && p.activity.recentEntries.length)
      ? p.activity.recentEntries.map(e => '<div class="scene-meta" style="margin-top:4px;">[' + esc(e.date) + '] ' + esc(e.text) + '</div>').join('')
      : '<div class="empty">暂无记忆动态——沉淀记忆后这里会显示变更记录。</div>';
  }
  document.getElementById('persona').textContent = p.persona.exists ? (p.persona.summary || '（已生成，无摘要）') : '尚未生成用户画像。';
  // ROI 区（M8）
  const roi = p.roi||{};
  const fu = roi.funnel||{suggested:0,accepted:0,ignored:0,never:0};
  const accepted = fu.accepted, feedback = fu.accepted+fu.ignored+fu.never;
  const rate = feedback>0 ? Math.round((fu.accepted/feedback)*100) : 0;
  const sugEls = document.querySelectorAll('.stat-n');
  if (sugEls.length>=4) {
    sugEls[2].textContent = fu.suggested;
    sugEls[3].textContent = rate+'%';
  }
  const bt2 = document.querySelectorAll('.stat-n');
  if (bt2.length>=6) { bt2[4].textContent = fu.ignored; bt2[5].textContent = fu.never; }
  const rt = document.getElementById('roi-types');
  if (rt && roi.byType) {
    rt.innerHTML = roi.byType.map(t=>'<div class="card" style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;"><span>'+esc(KIND[t.kind]||t.kind)+'</span><span style="font-size:12px;color:#8b93a1">'+t.accepted+'/'+t.suggested+' 接受 · '+Math.round(t.rate*100)+'%</span></div>').join('');
  }
  const ra = document.getElementById('roi-alert');
  if (ra) {
    if (roi.sufficient && roi.shouldReduceBudget) ra.innerHTML = '<div class="card" style="border-color:#ff6b6b55;color:#ffa94d;font-size:13px;">⚠️ 接受率低于 30%，已自动提高建议门槛（减少打扰）。</div>';
    else if (roi.sufficient) ra.innerHTML = '<div class="card" style="color:#8b93a1;font-size:13px;">接受率正常，保持当前节奏。</div>';
    else ra.innerHTML = '<div class="card" style="color:#5c6470;font-size:13px;">反馈样本不足（&lt;5），暂不评估打扰水平。</div>';
  }
}
async function refresh(){
  try { const r = await fetch('/api/today'); render(await r.json()); }
  catch(e){ console.error('[today] refresh failed', e); }
}
setInterval(refresh, 15000);
refresh();
</script>
</body>
</html>`
}

/** 启动本地主动中心 server（默认端口 8737） */
export function startTodayServer(port = 8737): Server {
  const server = createServer((req, res) => {
    try {
      if (req.url === '/api/today') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(buildTodayPayload(), null, 2))
        return
      }
      // POST /api/evaluate — 宿主 push（R1）：把最近消息推过来触发会话中评估（timer 同款抑制）
      if (req.url === '/api/evaluate' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk: Buffer) => (body += chunk.toString()))
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}') as { messages?: Array<{ role: string; content: string }>; sessionId?: string }
            const messages = (parsed.messages ?? []).filter((m) => m && typeof m.content === 'string')
            void suggestService
              .evaluateNow({ trigger: 'timer', messages, sessionId: parsed.sessionId })
              .then((records) => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: true, generated: records.length }, null, 2))
              })
              .catch((error) => {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
              })
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
          }
        })
        return
      }
      // /today 或 / → HTML
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(buildTodayHtml())
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`主动中心生成失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // 端口占用检测：先打印“启动中”，listen 成功后再打印“已启动”，
  // 避免用户误以为自己的实例已经起来（真实情况可能是旧实例在监听）。
  console.error(`[proactive-mcp] 主动中心启动中: http://127.0.0.1:${port}/today`)
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[proactive-mcp] ⚠️ 端口 ${port} 已被占用，未能启动主动中心。`)
      console.error(`  可能已有另一个主动中心在运行（可能是旧实例/其他项目）。`)
      console.error(`  可用环境变量换端口：PROACTIVE_TODAY_PORT=8739 proactive-mcp --today`)
      process.exit(1)
    } else {
      throw err
    }
  })
  server.listen(port, '127.0.0.1')
  server.once('listening', () => {
    console.error(`[proactive-mcp] 主动中心已启动: http://127.0.0.1:${port}/today`)
  })

  // 优雅关闭：收到 SIGTERM/SIGINT 时关闭 HTTP server 再退出，避免 npx 包装下
  // 杀包装进程后 node server 变成孤儿进程继续占用端口。
  const shutdown = (signal: NodeJS.Signals) => {
    console.error(`[proactive-mcp] 收到 ${signal}，正在关闭主动中心`)
    server.close(() => process.exit(0))
    // 兜底：close 回调不触发时强制退出，避免进程挂住
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  return server
}
