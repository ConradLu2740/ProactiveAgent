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
import { memoryService, suggestService, getConfigDir } from '@proactive-agent/core'

/** 构建 /api/today 数据负载 */
export function buildTodayPayload(): {
  generatedAt: string
  dataDir: string
  suggestions: Array<{ id: string; kind: string; title: string; reason: string; status: string }>
  hotScenes: Array<{ title: string; heat: number; atomCount: number }>
  persona: { exists: boolean; summary: string }
  stats: { atomCount: number; byType: Record<string, number>; pendingAtoms: number; pendingCorrections: number }
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
  return {
    generatedAt: new Date().toISOString(),
    dataDir: getConfigDir(),
    suggestions,
    hotScenes,
    persona: { exists: !!personaRaw, summary: persona.summary ?? '' },
    stats: {
      atomCount: stats.atomCount,
      byType: stats.byType ?? {},
      pendingAtoms: stats.pendingAtoms ?? 0,
      pendingCorrections: stats.pendingCorrections ?? 0,
    },
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

  <h2>待处理建议（<span id="sug-count">${p.suggestions.length}</span>）</h2>
  <div id="suggestions">
    ${suggestionCards}
  </div>

  <h2>近期热点场景</h2>
  <div id="scenes">
    ${sceneItems}
  </div>

  <h2>记忆统计</h2>
  <div class="grid">
    <div class="stat"><div class="stat-n" id="stats-count">${p.stats.atomCount}</div><div class="stat-l">原子记忆</div></div>
    <div class="stat"><div class="stat-n" id="stats-pending">${p.stats.pendingAtoms + p.stats.pendingCorrections}</div><div class="stat-l">待确认（记忆+纠正）</div></div>
  </div>
  <div class="sub" id="stats-bytype" style="margin-top:8px;">${esc(byType)}</div>

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
  const sug = document.getElementById('suggestions');
  sug.innerHTML = p.suggestions.length
    ? p.suggestions.map(s=>'<div class="card sug"><div class="sug-kind">'+esc(KIND[s.kind]||s.kind)+'</div><div class="sug-title">'+esc(s.title)+'</div><div class="sug-reason">'+esc(s.reason)+'</div><div class="sug-id">'+esc(s.id)+'</div></div>').join('')
    : '<div class="empty">暂无待处理建议 —— 该沉默时沉默。</div>';
  document.getElementById('sug-count').textContent = p.suggestions.length;
  document.getElementById('scenes').innerHTML = p.hotScenes.length
    ? p.hotScenes.map(s=>'<div class="card scene"><div class="scene-title">'+esc(s.title)+'</div><div class="scene-meta">热度 '+s.heat+' · '+s.atomCount+' 条记忆</div></div>').join('')
    : '<div class="empty">暂无热点场景。</div>';
  const bt = Object.entries(p.stats.byType||{}).filter(([,n])=>n>0).map(([k,n])=>k+' '+n).join(' · ');
  document.getElementById('stats-bytype').textContent = bt;
  document.getElementById('stats-count').textContent = p.stats.atomCount;
  document.getElementById('stats-pending').textContent = (p.stats.pendingAtoms||0) + (p.stats.pendingCorrections||0);
  document.getElementById('persona').textContent = p.persona.exists ? (p.persona.summary || '（已生成，无摘要）') : '尚未生成用户画像。';
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
      // /today 或 / → HTML
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(buildTodayHtml())
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`主动中心生成失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[proactive-mcp] ⚠️ 端口 ${port} 已被占用。`)
      console.error(`  可能已有另一个主动中心在运行（可能是旧实例/其他项目）。`)
      console.error(`  可用环境变量换端口：PROACTIVE_TODAY_PORT=8739 proactive-mcp --today`)
      process.exit(1)
    } else {
      throw err
    }
  })
  server.listen(port, '127.0.0.1')
  console.error(`[proactive-mcp] 主动中心已启动: http://127.0.0.1:${port}/today`)
  return server
}
