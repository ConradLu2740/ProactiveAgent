# @proactive-agent/mcp

ProactiveAgent 的 MCP Server：把主动记忆（proactive memory）+ 主动建议（proactive suggestions）能力以标准 MCP 协议暴露给**任何支持 MCP 的 agent 项目**。

即插即用，无需修改宿主代码。只需 **node >= 18**，不需要 bun。

## 安装（一条命令）

```bash
# 在你自己的项目里（或任意目录）
npm install @proactive-agent/mcp

# 一键生成挂载配置（Claude Code / Kimi Code / Cline / Cursor 通用）
npx proactive-mcp init
```

`init` 会在当前目录生成 `.mcp.json`，指向你本地安装的 bundle（零依赖、零编译）。然后直接打开你的 agent 即可使用。

> 手动挂载（不装包，直接用 GitHub Release bundle）：
> ```bash
> claude mcp add proactive-agent -- node /abs/path/to/dist/index.js
> ```

## 能力一览

**Tools（agent 主动调用）**
| 工具 | 用途 |
|---|---|
| `memory_capture` | 显式沉淀长期记忆（偏好/事实/纠正/流程，立即生效） |
| `memory_recall` | 关键词/混合检索记忆（任务开始前注入上下文） |
| `memory_extract` | 把对话消息交给引擎自动提取记忆（默认待确认，防投毒） |
| `memory_pending` / `memory_confirm` / `memory_reject` | 待确认记忆闭环（含待确认行为纠正） |
| `correction_confirm` / `correction_reject` | 待确认行为纠正闭环（memory_extract 规则模式产生的 correction） |
| `persona_get` | 读取 L3 用户画像（可注入系统提示） |
| `scene_summary` | 近期热点场景（主动性的时机信号） |
| `memory_stats` | 记忆统计 |
| `suggest_now` | 评估会话是否值得给建议（该沉默时沉默） |
| `suggest_list` / `suggest_accept` / `suggest_ignore` | 建议反馈闭环（频率学习） |
| `daily_review` / `onboarding_guide` | 每日复盘模板 / 使用说明（模板能力，见下方 Prompts） |

**Resources（只读）**
- `memory://today`：今日建议 + 热点场景
- `memory://stats`：记忆统计
- `memory://persona`：用户画像 markdown

**Prompts（模板）**
- `daily_review`：每日复盘工作流
- `onboarding`：教宿主如何用好主动能力

> **宿主兼容说明**：MCP 的 Prompts/Resources 不是所有宿主都消费（如 Kimi Code 只支持 Tools）。
> 因此模板能力已**同时暴露为 Tools**（`daily_review` / `onboarding_guide`），保证任何宿主都能用。

## 快速上手

```bash
npx proactive-mcp init   # 生成 .mcp.json + Claude Code hooks（--dry-run 预览 / --force 覆盖）
```

然后在 agent 里试试：

```
agent: 以后提交代码前必须先写单元测试再提交
→ suggest_now 识别为 correction 建议，你接受后写入长期记忆（所有 agent 都遵守）

agent: 我偏好用 TypeScript
→ memory_capture 记住（下次任何工具都记得）
```

## CLI 命令

| 命令 | 用途 |
|---|---|
| `proactive-mcp init` | 一键生成挂载配置（.mcp.json + Claude Code hooks；可选 --local / --kimi / --force / --dry-run） |
| `proactive-mcp doctor` | 健康检查：数据目录 / LLM 配置 / hooks 产物 / 记忆索引 / 端口占用 |
| `proactive-mcp stats` | 记忆与建议统计快照（atom/类型/场景/画像/建议反馈） |
| `proactive-mcp demo` | 教程式示例：隔离数据演示 capture→recall→suggest→persona（--clean 清理） |
| `proactive-mcp migrate` | 0.3.0 数据迁移（--apply 执行 / --preview 预览 / --status 状态 / --merge-to-global 反向收敛） |
| `proactive-mcp --today` | 启动本地主动中心 Web 面板（端口 PROACTIVE_TODAY_PORT，默认 8737） |

## /today Web 面板

本地主动中心摘要页，任何宿主都能打开浏览器查看：

```bash
npx proactive-mcp --today
# 打开 http://127.0.0.1:8737/today  （API: /api/today，端口用 PROACTIVE_TODAY_PORT 改）
```

## 数据位置

默认 `~/.proma-proactive/`。**0.3.0 起按项目隔离**（每个项目一份记忆），显式全局共享放 `global/` 层。

| 环境变量 | 说明 |
|---|---|
| `PROACTIVE_DATA_DIR` | 覆盖数据根目录（推荐：不同机器/环境隔离） |
| `PROMA_MEMORY_DIR` | 兼容 Proma 旧记忆目录（memory 部分直接指向；设置后为单层 global 模式） |
| `PROACTIVE_PROJECT` | 显式指定项目标识（跳过自动解析） |
| `PROACTIVE_SCOPE=global` | 逃生开关：全部读写回退 0.2 单层（`<root>/memory`），与 global 共享层物理分离 |
| `PROACTIVE_TODAY_PORT` | /today 面板端口（默认 8737） |
| `MEMORY_LLM_API_KEY` / `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_MODEL` | 可选 LLM 提取（OpenAI 兼容；未配置自动降级规则模式，零外发可用） |

> **npx 提示**：`npx proactive-mcp` 需要先在当前目录安装本包（`npm install @proactive-agent/mcp`）。
> 如遇 npx 404（本地包已装但 npx 误去 registry 拉取），用 `node node_modules/.bin/proactive-mcp` 直接执行。

数据布局（0.3.0）：
```text
~/.proma-proactive/
  index.json              # 顶层元数据（schemaVersion:2 / projects[] / migration）
  projects/<projectKey>/  # 项目隔离数据（每项目一份）
    meta.json             # 项目身份元数据（displayName / identitySource）
    memory/               # 与该项目相关的记忆（atoms/profile/scenes/corrections）
    suggestions.json      # 项目层主动建议
  global/                 # 显式共享层（跨项目共享的记忆与建议）
  .env                    # LLM 配置（全局）
```

## 按项目记忆（0.3.0）

每个项目独立记忆，**跨项目默认隔离**；需要跨工具/跨项目共享时显式写 `global` 层。

- **项目标识自动解析**：`PROACTIVE_PROJECT` env → git remote（origin 优先）→ package.json name → 路径 hash。同一仓库在任意路径打开都是同一份记忆。
- **写入**：`memory_capture { scope: 'project' | 'global' }`（默认 project）；`persona_save` 可写项目层画像覆盖。
- **读取**：`memory_recall { scope: 'auto' | 'project' | 'global' }`（默认 auto = 项目 + 全局合并，全局命中降权并标注 `[shared]`）。
- **迁移**：从 0.2.x 升级后首次启动自动把旧全局数据迁入 `global/` 层；也可手动 `proactive-mcp migrate`。
- **逃生**：`PROACTIVE_SCOPE=global` 临时回退全局单层（数据写 `<root>/memory`，不会混入共享层）；数据侧反向收敛用 `proactive-mcp migrate --merge-to-global`。

## 设计原则

1. **该沉默时沉默**：单次评估最多 1 条建议、同会话预算限制、免打扰时段（DND）不产生新建议。
2. **防投毒**：自动提取的记忆默认 pending，需用户确认后才进入召回；显式 `memory_capture` 即时生效。
3. **LLM 配置同源**：apiKey 决定主信任源，baseUrl/model 只从同源取；baseUrl 仅 https（localhost 例外）。
4. **反馈闭环**：接受建议（correction 类）→ 写入行为纠正 + 回流用户画像；高频忽略 → 类型自动静默。

## 进阶：Claude Code hooks（会话级主动推送，随发布包内置）

发布包已内置编译好的 hooks（`node_modules/@proactive-agent/mcp/dist/hooks/`），无需 clone 源码。

在 `.claude/settings.json` 添加：

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/node_modules/@proactive-agent/mcp/dist/hooks/today-push.js" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/node_modules/@proactive-agent/mcp/dist/hooks/session-end.js" }] }]
  }
}
```

> 路径写你实际安装位置的绝对路径。也可以复制 hooks 到项目里再引用。

- **today-push**（SessionStart）：会话开始时注入今日待处理建议/热点场景；无内容则沉默不打扰
- **session-end**（Stop）：会话结束时从 transcript 提取记忆（默认待确认）+ 评估主动建议

## 开发

```bash
git clone https://github.com/ConradLu2740/ProactiveAgent.git && cd ProactiveAgent
bun install
bun test src/server.test.ts          # 端到端冒烟（in-memory transport）
bun run scripts/verify-stdio.ts      # stdio 级验证（模拟真实挂载）
bun run typecheck
```

## License

MIT
