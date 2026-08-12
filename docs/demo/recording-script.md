# ProactiveAgent 30 秒演示录屏脚本（0.9.x「守护进程主动开口」）

> 目标：Show HN / Reddit / README 首屏的 30 秒 GIF，wow 点是 **daemon 无人值守主动弹通知**。
> 前置：演示数据已生成（见下）+ QuickTime Player + 一个装着 Claude Code 的目录（可选）。
> 素材：面板静态快照 `docs/demo/today-panel.html`（浏览器打开可截图）。

## 第一步：重建演示数据（一条命令）

```bash
export PROACTIVE_DATA_DIR=/tmp/pa-demo
npx proactive-mcp demo-data          # 生成 5 记忆 + 4 建议 + 2 任务 + 画像 + 疲劳 2/6
npx proactive-mcp --today            # 起面板 http://127.0.0.1:8737/today（录屏前可先打开）
```

> ⚠️ 数据隔离在 /tmp/pa-demo，绝不碰真实记忆。录完 `npx proactive-mcp demo-data --clean` 清理。

## 第二步：通知链路自检（录屏前先验证一次，保证一遍成）

```bash
export PROACTIVE_DATA_DIR=/tmp/pa-demo
PROACTIVE_DAEMON_COOLDOWN_MIN=0 npx proactive-mcp daemon   # 冷却设 0 便于演示时快速触发
```

另开终端等 daemon 跑一轮（默认 60 分钟太久 → 用 env 缩短）：

```bash
export PROACTIVE_DATA_DIR=/tmp/pa-demo
PROACTIVE_DAEMON_INTERVAL_MIN=1 PROACTIVE_TODAY_PORT=8737 npx proactive-mcp daemon
```

通知应弹出（macOS 通知中心出现「主动建议 · …」）。若没弹，检查：suggestions 里还有 suggested 状态建议（demo-data 有 4 条）；DND 时段会跳过（`proactive-mcp doctor` 可看）。

## 第三步：30 秒分镜

| 时间 | 画面 | 字幕（后期可加） |
|---|---|---|
| 0-6s | 终端：`npx proactive-mcp demo-data` 跑完（展示记忆/建议/任务输出） | 一条命令重建演示 |
| 6-12s | 终端：`npx proactive-mcp daemon` 启动（显示 pid + 面板地址） | 常驻守护进程 |
| 12-18s | 切到桌面，**等 macOS 通知弹出**：「主动建议 · 跟进建议：创建跟进提醒（明天 09:00）」 | 没人问它，它自己开口了 |
| 18-24s | 点击通知 → 浏览器打开 /today 面板（4 条建议卡片 + 接受/忽略按钮） | 该开口时开口 |
| 24-30s | 点一条「✓ 接受」→ 面板任务区出现新任务 | 开口 → 执行闭环 |

**备选**（录不到通知弹窗时）：12-18s 改为展示 `doctor` 输出「今日 2/6 条 + daemon 运行中」，字幕「每天最多 6 条，不该开口时闭嘴」。

## QuickTime + ffmpeg（沿用旧指南）

1. QuickTime → 文件 → 新建屏幕录制（⌘⌃N）→ 选终端/桌面区域（1280×720 内）
2. 按分镜操作；结束点菜单栏 🟥
3. 转 GIF：`brew install ffmpeg`（一次）→
   `ffmpeg -i demo.mov -vf "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 demo.gif`
4. 检查 `< 3MB`；放到 `docs/demo/demo.gif`；README hero 引用

## 素材清单状态（2026-08-12）

- [x] `demo-data` CLI（演示数据一键重建，已提交）
- [x] `docs/demo/today-panel.html`（面板静态快照，浏览器打开即可截图）
- [ ] 面板 PNG 截图（用户手动：打开 today-panel.html → ⌘⇧4）
- [ ] 30s GIF（用户录屏，按本脚本）
- [ ] daemon 通知截图（可选，GIF 内自然出现）

## Kimi Code 真实 MCP 演示（已实测，2026-08-12）

> 效果：在真实 Kimi Code CLI 里，模型调用 ProactiveAgent MCP 工具完成「教一次 → 处处用」记忆闭环。
> 素材：docs/demo/kimi-mcp-demo.png

```bash
# 1. mcp.json 挂载（~/.kimi-code/mcp.json，已配好）
# 2. 启动 kimi（隔离目录）
cd /tmp/kimi-demo && kimi
# 3. 发消息 1（教一次）：请用 proactive-agent 的 memory_capture 工具记住这条偏好：用户偏好用 TypeScript 和 pnpm 管理依赖
#    → 模型调用 memory_capture → "已记住：[preference] 用户偏好用 TypeScript 和 pnpm 管理依赖"
# 4. 发消息 2（处处用）：用 proactive-agent 的 memory_recall 工具查询：我的项目技术栈偏好是什么
#    → 模型调用 memory_recall → 命中（[shared] 标注，相关度 80%）
```

已知：Kimi 0.34 的 UserPromptSubmit hook 运行时未触发（PA 主动建议转述不可用，待查）；
MCP 工具链路完全正常。mcp.json 原 kimi-cu 配置备份在 ~/.kimi-code/mcp.json.bak-kimicu。
