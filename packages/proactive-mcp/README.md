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
npx proactive-mcp init   # 生成 .mcp.json
```

然后在 agent 里试试：

```
agent: 以后提交代码前必须先写单元测试再提交
→ suggest_now 识别为 correction 建议，你接受后写入长期记忆（所有 agent 都遵守）

agent: 我偏好用 TypeScript
→ memory_capture 记住（下次任何工具都记得）
```

## /today Web 面板

本地主动中心摘要页，任何宿主都能打开浏览器查看：

```bash
npx proactive-mcp --today
# 打开 http://127.0.0.1:8737/today  （API: /api/today，端口用 PROACTIVE_TODAY_PORT 改）
```

## 数据位置

默认 `~/.proma-proactive/`（**用户级一份共享**，跨工具、跨会话复用同一份记忆）。

| 环境变量 | 说明 |
|---|---|
| `PROACTIVE_DATA_DIR` | 覆盖数据根目录（推荐：不同机器/环境隔离） |
| `PROMA_MEMORY_DIR` | 兼容 Proma 旧记忆目录（memory 部分直接指向） |

数据布局：
```text
~/.proma-proactive/
  index.json              # 记忆索引/统计
  profile.md              # L3 用户画像
  atoms/{YYYY-MM-DD}.jsonl  # L1 原子记忆
  scenes/                 # L2 场景块
  corrections.json        # 行为纠正候选
  suggestions.json        # 主动建议记录
  memory_log/             # 每日记忆变更日志
```

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
