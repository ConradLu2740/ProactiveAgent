# ProactiveAgent × Kimi Code Plugin

让 Kimi Code CLI 拥有**跨工具主动记忆与主动建议**：安装后无需手动挂载 MCP，所有会话自动获得记忆能力。

## 安装

```text
/plugins install https://github.com/ConradLu2740/ProactiveAgent/releases/download/v0.9.2/kimi-plugin.zip
```

> 分发形式：Kimi plugin 以 **zip asset** 形式随 GitHub Release 分发（zip 根即插件根）。
> 本地安装（开发/离线）：`git clone` 后 `/plugins install /path/to/ProactiveAgent/kimi-plugin`。

装完执行 `/reload`（或新开会话）生效。

### 安装前检查（重要）

如果你之前用过 `proactive-mcp init --kimi`，`~/.kimi-code/mcp.json` 里已有 `proactive-agent` 条目——**与插件自带声明重复**，会导致两个同名 MCP server 同时挂载（工具出现两套：`mcp__proactive-agent__*` 和 `mcp__plugin-...__*`）。请二选一：

- **用插件**（推荐）：删除 `~/.kimi-code/mcp.json` 里的 `proactive-agent` 条目后 `/reload`；
- **用 init --kimi**：`/plugins remove proactive-agent`。

## 安装后你会得到

| 能力 | 说明 |
|---|---|
| **MCP server**（`proactive-agent`） | 18 个工具：memory_capture / memory_recall / memory_extract / persona_get / scene_summary / suggest_now / suggest_list / daily_review / onboarding_guide…（npx 拉起 @proactive-agent/mcp，固定版本） |
| **主动记忆提示词**（systemPrompt 注入） | 每个会话自动生效：会话开始注入画像、对话中主动沉淀偏好/纠正（否定词保留）、收尾提取记忆（默认待确认） |
| **Proactive Agent**（`--agent proactive`） | 更激进的主动模式：`kimi --agent proactive` 启动 |
| **快捷命令** | `/proactive-agent:remember <内容>` 一句话沉淀记忆 · `/proactive-agent:recall <关键词>` 回忆历史记忆 |

## 使用

```bash
kimi                       # 普通会话即可（提示词自动注入，模型会主动调记忆工具）
kimi --agent proactive     # 显式主动 Agent 模式（可选）
```

试试：

```
我以后都用 pnpm 安装依赖，不要用 npm     → 自动 memory_capture（下次任何工具都记得）
我平时安装依赖的习惯是什么？             → 自动 memory_recall（正确回答）
/proactive-agent:remember 部署用 fly.io，不用 vercel     → 快捷沉淀
/proactive-agent:recall 部署            → 快捷回忆
```

## 权限配置（推荐）

Kimi 默认 `manual` 权限模式下，每次 MCP 工具调用都会弹审批。把只读/评估类工具加入 `~/.kimi-code/config.toml` 的允许规则可减少打扰（写类保留手动确认）：

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__proactive-agent__persona_get"
[[permission.rules]]
decision = "allow"
pattern = "mcp__proactive-agent__memory_recall"
[[permission.rules]]
decision = "allow"
pattern = "mcp__proactive-agent__scene_summary"
[[permission.rules]]
decision = "allow"
pattern = "mcp__proactive-agent__memory_stats"
[[permission.rules]]
decision = "allow"
pattern = "mcp__proactive-agent__suggest_now"
[[permission.rules]]
decision = "allow"
pattern = "mcp__proactive-agent__daily_review"
# 写类（memory_capture / memory_extract / suggest_accept / correction_confirm…）不授，保留人工确认
```

⚠️ 不要用 `pattern = "mcp__*"` 全量放行；不要用 auto/yolo 权限模式（模型可能自主执行本地命令）。

## 版本与网络

- 插件固定依赖 `@proactive-agent/mcp@<插件版本>`（当前 0.9.2），版本联动发布，防工具名漂移。
- MCP server 由 npx 拉起：**首次使用需要网络**（下载 npm 包，之后本地缓存）；离线环境不可用——可用 `npm i -g @proactive-agent/mcp@0.9.2` 后把 manifest 的 command 改为 `proactive-mcp`（全局命令，零网络）。

## 数据与隐私

- 记忆数据在 `~/.proma-proactive/`（默认），跨工具共享；LLM 配置可选 `~/.proma-proactive/.env`（`MEMORY_LLM_API_KEY/BASE_URL/MODEL`，chmod 600），不配则走规则模式（零外部调用）。
- 自动提取的记忆默认**待确认**才生效（防投毒）。
- 详细说明见仓库 `.context/pa-kimi-code-guide.md` 与项目 README。

## 分发形式（维护者）

Kimi `/plugins install` 支持三种来源：本地目录 / zip URL / GitHub URL（仓库根须含 manifest）。本插件选择 **zip asset** 形式：`scripts/publish-proactive.sh` 在构建时自动同步 `kimi-plugin/kimi.plugin.json` 的 version 与 npm 依赖版本（防漂移），并打包 `kimi-plugin.zip`（zip 根即插件根）到 `dist-publish/`；推 GitHub 时作为 vX.Y.Z release 的 asset 上传，安装 URL 即 release asset 直链。
