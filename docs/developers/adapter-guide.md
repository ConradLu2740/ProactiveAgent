# 接入指南：让任何工具成为 ProactiveAgent 的感知源（0.6+）

> ProactiveAgent 的「跨工具感知网」：任意工具只要把会话/消息/commit 事件写入统一事件流
> （`PROACTIVE_DATA_DIR/events/{date}.jsonl`），daemon 就能在巡检时读到这些事件做真定时评估，
> 并通过桌面通知主动开口。**接入 = 在工具的生命周期事件点执行一个脚本**。

## 事件协议（v1，短字段）

每行一条 JSON（append-only，按天落盘）：

```json
{"v":1,"t":"start","tool":"cursor","at":1786507152759,"sid":"cur-1","pk":"github.com-acme-app"}
{"v":1,"t":"msg","tool":"cursor","at":1786507153000,"sid":"cur-1","role":"u","text":"以后都用 pnpm 安装"}
{"v":1,"t":"msg","tool":"cursor","at":1786507153100,"sid":"cur-1","role":"a","text":"好的，已切换到 pnpm"}
{"v":1,"t":"commit","tool":"cursor","at":1786507153200,"sid":"cur-1","msg":"chore: use pnpm"}
{"v":1,"t":"end","tool":"cursor","at":1786507153500,"sid":"cur-1"}
```

| 字段 | 说明 |
|---|---|
| `t` | `start` 会话开始 / `msg` 消息（`role`: `u`=user / `a`=assistant） / `commit` 提交 / `end` 会话结束 |
| `tool` | `claude` / `cursor` / `codex` / `kimi` / `cline` / `continue` |
| `sid` | 会话 ID（跨会话预算去重依赖它，尽量传） |
| `pk` | 项目身份 key（可选；daemon 后续按它隔离评估） |

容量：单文件 1MB 自动裁剪（保留最新 70%）、目录保留 7 天、权限 0600/0700（仅当前用户可读写）。
无需自己实现这些——直接用官方入口即可。

## 三种接入方式

### 方式 A：Claude Code 兼容（Cursor / Continue 等，零代码）

Cursor 官方支持加载 `.claude/settings.json` 的 Claude Code hooks 并自动映射
（SessionStart→sessionStart、UserPromptSubmit→beforeSubmitPrompt、Stop→stop）。
运行 `proactive-mcp init` 生成配置后，**开启工具自身的第三方钩子兼容即可自动接入**。

### 方式 B：通用入口 event-capture（Codex / Cline / 任意支持命令回调的工具）

任意工具在事件点执行 `node <安装路径>/dist/hooks/event-capture.js`，stdin 传 JSON：

```json
{"event":"message","tool":"codex","role":"user","text":"用户消息","session_id":"s1","cwd":"/path/to/project"}
```

字段兼容 camelCase / snake_case：`sessionStart`/`sessionEnd`/`beforeSubmitPrompt`/`user_prompt`/`commit`。
未知事件/未知工具静默（不污染宿主协议）。工具名白名单见 `src/event-store.ts` 的 `AgentTool`。

### 方式 C：内联 SDK（有 Node 运行时的高级接入）

在工具插件里直接调 `@proactive-agent/core` 旁路或 `event-store` 的便捷函数：

```ts
import { recordMessage, recordLifecycle, currentProjectKey } from '@proactive-agent/mcp' // 或打包后的 event-store
recordLifecycle('cline', 'start', { sid, pk: currentProjectKey() })
recordMessage('cline', 'u', prompt, { sid, pk: currentProjectKey() })
recordLifecycle('cline', 'end', { sid, pk: currentProjectKey() })
```

## 接入清单（给第三方贡献者）

1. **定事件点**：工具支持的 hook/事件回调里挑 4 个——会话开始、用户消息、会话结束、commit
2. **传 JSON**：`{event, tool, role, text, session_id, cwd}`（cwd 用于解析项目身份）
3. **验证**：跑一次后检查 `~/.proma-proactive/events/` 出现当天的 `.jsonl`，行结构符合协议
4. **回归**：`proactive-mcp doctor` 看 daemon 状态；开 daemon 后观察「上次评估」时间在事件后更新
5. **提交 adapter**：把接入配置/脚本 PR 到仓库 `packages/proactive-mcp/hooks/`（参考 `adapter-template.ts`）

## 隐私说明

事件文件包含用户消息明文（**仅当前用户可读写**）。建议在工具侧提示用户，
并避免把密钥类对话内容接入；后续版本将提供 `PROACTIVE_EVENTS_DISABLED` 采集开关。

## 参考实现

- 官方入口：`packages/proactive-mcp/hooks/event-capture.ts`（方式 B）
- 内联写事件：`hooks/common.ts` / `today-push.ts` / `session-end.ts`（方式 A）
- 模板：`packages/proactive-mcp/hooks/adapter-template.ts`（方式 B 脚手架）
