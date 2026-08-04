# @proactive-agent/core

ProactiveAgent 的 **headless 引擎**：主动记忆（capture / recall / persona / scene）+ 主动建议（signals / rules / engine / feedback / analyst）。

宿主无关、零运行时依赖（发布版为 bundle 单文件），被以下消费者共享：

- **@proactive-agent/mcp**：MCP server，挂载到任何支持 MCP 的 agent（Claude Code / Kimi Code / Cline / Cursor）
- **Proma Electron**：Proma 应用自身（dogfooding）

## 用法

```ts
import { memoryService, suggestService, createCore } from '@proactive-agent/core'

// 显式沉淀记忆（立即生效）
memoryService.captureCandidate({ content: '用户偏好用 TypeScript', type: 'preference' }, {}, { confirmed: true })

// 检索记忆
const hits = await memoryService.searchAsync({ query: 'TypeScript', limit: 5 })

// 会话结束评估建议
const records = await suggestService.evaluateSessionSuggestions(
  [{ role: 'user', content: '以后提交前先写测试' }],
  { sessionId: 'session-1' },
)

// 注入宿主能力（可选）：automation 标题提供者
createCore({ automationTitles: () => ['每周发版检查'] })
```

## 数据

默认 `~/.proma-proactive/`（用户级一份共享，跨工具复用）。环境变量覆盖：`PROACTIVE_DATA_DIR` > `PROMA_CONFIG_DIR` > `PROMA_MEMORY_DIR`（memory 根）。

## License

AGPL-3.0-only
