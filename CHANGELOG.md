# Changelog

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
