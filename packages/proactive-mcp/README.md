# @proactive-agent/mcp

ProactiveAgent 的 MCP Server：把主动记忆（proactive memory）+ 主动建议（proactive suggestions）能力以标准 MCP 协议暴露给**任何支持 MCP 的 agent 项目**。

即插即用，无需修改宿主代码。

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
| `daily_review` | 每日复盘模板（模板能力，见下方 Prompts） |
| `onboarding_guide` | ProactiveAgent 使用说明（模板能力，见下方 Prompts） |

**Resources（只读）**
- `memory://today`：今日建议 + 热点场景
- `memory://stats`：记忆统计
- `memory://persona`：用户画像 markdown

**Prompts（模板）**
- `daily_review`：每日复盘工作流
- `onboarding`：教宿主如何用好主动能力

> **宿主兼容说明**：MCP 的 Prompts/Resources 不是所有宿主都消费（如 Kimi Code 只支持 Tools）。
> 因此模板能力已**同时暴露为 Tools**（`daily_review` / `onboarding_guide`），保证任何宿主都能用。

## 主动推送（Phase 3）

### /today Web 面板
本地主动中心摘要页，任何宿主都能打开浏览器查看：

```bash
bun run packages/proactive-mcp/src/index.ts --today
# 打开 http://127.0.0.1:8737/today  （API: /api/today，端口用 PROACTIVE_TODAY_PORT 改）
```

### Claude Code hooks（会话级主动推送）
在 `.claude/settings.json` 添加：

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun run /abs/path/to/packages/proactive-mcp/hooks/today-push.ts" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bun run /abs/path/to/packages/proactive-mcp/hooks/session-end.ts" }] }]
  }
}
```

- **today-push**（SessionStart）：会话开始时注入今日待处理建议/热点场景；无内容则沉默不打扰
- **session-end**（Stop）：会话结束时从 transcript 提取记忆（默认待确认）+ 评估主动建议

## 安装与挂载

### 环境要求
- [bun](https://bun.sh)（运行 server）
- LLM 提取可选：设置 `MEMORY_LLM_API_KEY` / `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_MODEL`（OpenAI 兼容）。未配置时自动降级规则模式（零外发）。

### Claude Code

```bash
claude mcp add proactive-agent -- \
  bun run /path/to/@proactive-agent/mcp/src/index.ts
```

或项目级 `.mcp.json`：

```json
{
  "mcpServers": {
    "proactive-agent": {
      "command": "bun",
      "args": ["run", "/path/to/@proactive-agent/mcp/src/index.ts"]
    }
  }
}
```

### Cline（VS Code 扩展）

Cline → 设置 → MCP Servers → 添加：

```json
{
  "mcpServers": {
    "proactive-agent": {
      "command": "bun",
      "args": ["run", "/path/to/@proactive-agent/mcp/src/index.ts"]
    }
  }
}
```

### 其他 MCP agent（Cursor / Windsurf / Zed / VS Code Copilot / Kimi Code 等）

同样添加一个 stdio server，command 指向上面的启动命令即可。

**Kimi Code 实测**（0.31.1）：`.mcp.json` 与 Claude Code 完全同构零改动；13+2 个工具全部识别；`-p` 非交互模式直接执行（无需额外授权）。注意 Kimi 不消费 MCP Resources/Prompts——模板能力用 `daily_review` / `onboarding_guide` 工具代替。

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

## 开发

```bash
bun test src/server.test.ts          # 端到端冒烟（in-memory transport）
bun run scripts/verify-stdio.ts      # stdio 级验证（模拟真实挂载）
bun run typecheck
```

## License

AGPL-3.0-only
