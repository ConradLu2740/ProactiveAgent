# @proactive-agent/core

ProactiveAgent 的 **headless 引擎**：主动记忆（capture / recall / persona / scene）+ 主动建议（signals / rules / engine / feedback / analyst）。

**宿主无关**：不依赖任何 agent 框架，零运行时依赖（发布版为 bundle 单文件），被以下消费者共享：

- **@proactive-agent/mcp**：MCP server，挂载到 Claude Code / Kimi Code / Cline / Cursor
- **Proma Electron**：Proma 应用自身（dogfooding）

## 安装

```bash
# npm 发布后
npm install @proactive-agent/core
# 当前：从 GitHub
npm install github:ConradLu2740/ProactiveAgent
```

## 快速上手

```ts
import { memoryService, suggestService, createCore } from '@proactive-agent/core'

// 1. 显式沉淀记忆（立即生效）
memoryService.captureCandidate(
  { content: '用户偏好用 TypeScript 和 Bun', type: 'preference', priority: 80 },
  {},
  { confirmed: true },
)

// 2. 检索记忆（任务开始前注入上下文）
const hits = await memoryService.searchAsync({ query: 'TypeScript', limit: 5 })

// 3. 会话结束评估建议（该沉默时沉默）
const records = await suggestService.evaluateSessionSuggestions(
  [{ role: 'user', content: '以后提交前先写单元测试' }],
  { sessionId: 'session-1' },
)

// 4. 注入宿主能力（可选）：automation 标题提供者 / 建议变更监听
createCore({
  automationTitles: () => ['每周发版检查'],
})
setSuggestionsChangedListener(() => { /* 宿主 UI 刷新 */ })
```

## 能力

| 模块 | 说明 |
|---|---|
| **记忆** | L1 Atom（去重/优先级/指纹）/ L2 Scene（主题聚类+热度）/ L3 Persona（画像+溯源）/ Correction（行为纠正） |
| **检索** | keyword + embedding 混合（embedding 不可用自动降级），归一化防误报 |
| **提取** | LLM 结构化提取（可选）/ 规则模式（零外发），默认 pending 防投毒 |
| **建议** | 5 类规则（correction/followup/automation/skill/todo）+ 频率学习 + DND 免打扰 |

## 数据

默认 `~/.proma-proactive/`（用户级一份共享，跨工具复用）。

| 环境变量 | 说明 |
|---|---|
| `PROACTIVE_DATA_DIR` | 覆盖数据根目录 |
| `PROMA_CONFIG_DIR` / `PROMA_MEMORY_DIR` | 兼容 Proma 既有配置 |

LLM 提取可选：`MEMORY_LLM_API_KEY` / `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_MODEL`（OpenAI 兼容）。同源原则：apiKey 决定主信任源。

## 测试

```bash
bun install
bun test src/memory src/suggest   # 引擎测试
bun run typecheck
```

## License

MIT（类型声明兼容 @proma/shared 接口，不捆绑其实现代码，见 NOTICE）
