# Changelog

## 0.2.0 (2026-08-06)

「开箱即用」批次：开发者体验改进（纯增量，不改变数据模型）。

### 新增

- **CLI 子命令收敛**：`init` / `doctor` / `stats` / `demo` / `--today` / `--version` 统一解析，`--help` 完整列举
- **`proactive-mcp doctor`**：健康检查——数据目录可写性 / LLM 配置同源链 / hooks 产物存在性 / 记忆索引可读 / 建议索引健康 / today 端口占用，✅⚠️❌ 输出
- **`proactive-mcp stats`**：记忆与建议统计快照（atom/类型/场景/待确认/画像/建议反馈/数据目录）
- **`proactive-mcp demo`**：教程式示例（隔离 /tmp/pa-demo-data 演示 capture→recall→suggest→persona，`--clean` 清理）
- **init 全家桶**：`proactive-mcp init` 除 .mcp.json 外，自动生成 Claude Code hooks 配置（.claude/settings.json，today-push/session-end 绝对路径自推断）+ `--dry-run` 预览

### 变更

- 发布脚本构建后自动自检 `--version` 与发布版本一致（防版本号漂移）

## 0.1.3 (2026-08-06)

首个 npm 公开发布版本（@proactive-agent/core + @proactive-agent/mcp 同步发布）。

### 修复

- 版本号统一：`proactive-mcp --version` 与 MCP `serverInfo.version` 改为由发布脚本
  `--define` 注入，与 npm 发布版本一致（此前硬编码 0.2.0 导致漂移）；构建后自动自检防止再次漂移
- /today 面板端口占用提示顺序修正：先打印“启动中”，listen 成功才打印“已启动”，
  端口被占用时明确提示“未能启动”并退出，避免用户误以为自己的实例已起来
- /today 面板支持 SIGTERM/SIGINT 优雅关闭（关闭 HTTP server 后退出），
  修复 npx 包装下杀包装进程后 node server 变孤儿进程继续占端口的问题
- `index.json` 注释/README 对齐：明确其为按需生成（写入开关/提取模式等配置时落盘），
  原子记忆实际存储于 `atoms/*.jsonl`

## 0.1.0 (2026-08-04)

首个公开发布版本。

### @proactive-agent/core — headless 主动引擎

- 主动记忆：显式 capture / LLM+规则提取（默认待确认防投毒）/ 混合检索（keyword+embedding）/ L2 场景聚类 / L3 用户画像（可溯源）
- 主动建议：信号提取 / 确定性规则（correction/followup/automation/skill/todo）/ 频率学习反馈 / 免打扰时段（DND）
- 宿主无关：零运行时依赖（bundle 单文件），provider 注入机制（automation 标题、建议广播）
- 数据：默认 `~/.proma-proactive/`（用户级一份共享），环境变量可覆盖

### @proactive-agent/mcp — MCP Server（stdio）

- 17 个工具：memory_capture/recall/extract/pending/confirm/reject、correction_confirm/reject、persona_get、scene_summary、memory_stats、suggest_now/list/accept/ignore、daily_review、onboarding_guide
- 3 个 resources（memory://today、//stats、//persona）+ 2 个 prompts（daily_review、onboarding）
- /today Web 面板（`proactive-mcp --today`，15s 自动刷新）+ Claude Code hooks（today-push / session-end）
- 一键安装：`proactive-mcp init` 生成 .mcp.json

### 已验证

- 真实挂载：Claude Code 2.1.197 / Kimi Code 0.31.1 / Proma（dogfooding）全部通过
- 测试：848+ pass，6 个基线环境失败（Electron 相关，与本包无关）
