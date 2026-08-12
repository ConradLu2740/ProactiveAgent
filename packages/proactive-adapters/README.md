# @proactive-agent/adapters

ProactiveAgent 宿主适配层（harness adapter）：跨 agent 宿主的统一主动层抽象。

MCP 统一了"工具调用层"，本包补上"主动层"——感知（hooks 事件）、表达（建议注入）、上下文注入、会话读取、能力矩阵，每个宿主一个 `HostAdapter` 实现。

## 宿主支持

| Adapter | 感知 | 表达 | 注入 | 会话读取 | 状态 |
|---|---|---|---|---|---|
| `claude` | ✅ hooks | ✅ stdout 文本 | ✅ SessionStart | ✅ transcript | 全能力验证 |
| `kimi` | ✅ hooks(0.35+) | ✅ notification XML | ✅ plugin systemPrompt | ✅ wire.jsonl | 全能力验证 |
| `cursor` | ⚠️ Claude Code 兼容声明 | ⚠️ 待实测 | ⚠️ 待实测 | ❌ 未调研 | 实现 + 待实测 |
| `cline` | ⚠️ event-capture 通用入口 | ❌ 降级 daemon 通知 | ❌ | ❌ | 实现 + 待实测 |
| `codex` | ⚠️ event-capture 通用入口 | ❌ 降级 daemon 通知 | ❌ | ❌ | 实现 + 待实测 |

## 使用

```ts
import { getAdapter, detectHostId } from '@proactive-agent/adapters'

// 判断宿主（hooks stdin 输入）
const host = detectHostId(input) // 'claude' | 'kimi' | 'cursor' | ...
const adapter = getAdapter(host)

// 能力判断（用能力而非宿主名）
if (adapter?.capabilities.resources) {
  // 可以引用 memory://today
}
```

## 设计要点

- **能力矩阵诚实声明**：`true / false / { partial: note }`，不伪造能力（参考 jido_harness AdapterSpec）
- **零运行时依赖**：纯函数（渲染/提取/能力声明），任意宿主/打包器可消费
- **设计文档**：PA 仓库 `.context/pa-harness-adapter-design.md`

## 开发

```bash
npm run build      # esbuild bundle + d.ts
npm test           # vitest
npm run typecheck
```
