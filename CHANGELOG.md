# Changelog

## 0.8.0 (2026-08-10)

「信任体验」批次：融合 Proma v0.17.0 记忆治理能力到外挂引擎（对齐上游 watcher 可视化 + refresh 复查邀请 + knowledge-maintenance 主动重整）。

### 新增

- **记忆动态可视化（对标 v0.17.0 memory watcher）**：`memoryActivity()` 读取最近记忆变更（今日动态数 / 距上次更新天数 / 最近 3 条日志）；`memory_log` 补自动提取批量写入；today 面板新增「记忆动态」卡片（Dock 风格）。
- **记忆复查邀请（对标 v0.17.0 agent-memory-refresh-service）**：`memoryReviewOpportunity()` 距上次更新超 3 天返回邀请；today 面板顶部提示条 + `memory_stats` 附 review 字段 + CLI stats 展示「记忆距上次更新 N 天」。
- **persona 超载重整（对标 v0.17.0 knowledge-maintenance 主动重整）**：`detectPersonaOverload()` 检测行数 >45 / 章节 >6 触发超载提示；LLM 增量更新时注入精简指令；`persona_get` 附 reorganizationHint；CLI stats 展示超载告警。
- **onboarding 两阶段引导**：先建画像 → 再补证据；记忆维护纪律（3 天复查 + 画像超载精简）写入引导文案。

### 修复

- **开发期 workspace 链接失效（P0 开发体验）**：mcp 依赖 core 从 `^0.6.0`（npm registry）改为 `file:../proactive-core` + core version 对齐 0.7.0，本地引擎源码改动即时生效，不再需要先发布才能开发 mcp。

### 测试

- 295 全绿（新增 10：memory-activity 7 + persona-overload 3），core + mcp typecheck 干净。

## 0.7.0 (2026-08-10)

「构建链迁移 Bun → Node.js」批次：运行时本就基于 Node（bundle 为 --target=node），本次将开发/构建/测试/CI 工具链整体迁到 Node 生态。

### 迁移

- **测试框架 bun:test → Vitest**：24 个测试文件改 import（API 兼容零改动）；`Bun.spawnSync` → `node:fs` rmSync/mkdirSync；vitest.config 保持串行（`fileParallelism: false`）避免 /tmp 与 env 污染。285 全绿。
- **构建 bun build → esbuild**：core/mcp/hooks 全部迁移，`--format=esm` 修复 import.meta（cli-init 依赖）；`--define:PROACTIVE_MCP_VERSION` 注入保留；hooks 用 `scripts/build-hooks.sh` 批量构建。
- **包管理 bun.lock → package-lock.json**：`@types/bun` → `@types/node`，tsconfig types 同步；`workspace:*` 协议在 npm 10 不兼容 → 显式版本 + npm workspaces 自动链接。
- **CI setup-bun → setup-node@22**：`npm ci` + `npm test` + `npx tsc`。
- **发布脚本**：publish-proactive.sh / pack-mcpb.sh 的 bun/bunx → npm/npx；去掉 `export PATH=~/.bun`。
- **源码 ESM 化**：移除全部 CJS 动态 `require()`（store.ts 4 处 + feedback.ts 4 处 + project.ts 3 处），改为静态 import 或顶层 import（store↔ttl 循环依赖在函数内使用安全）。
- **README/CHANGELOG**：开发环境 Node 22 + TypeScript + Vitest + esbuild，badge 同步。

## 0.6.0 (2026-08-09)

「ActionCard 统一动作卡片协议」批次：对齐上游 Proma issue #1462 的跨来源行动卡片模型。

### 新增

- **ActionCard 协议类型（`shared-types.ts`）**：新增 `ActionCard` 接口——`source`（suggestion/agent/automation/memory/planning/project/bridge）/ `priority`（urgent/normal/low）/ `expiresAt` / `allowedActions` / `target` / `privacy`（local-only/remote-summary）/ `status`（pending/accepted/dismissed/resolved）+ `duplicateKey`/`evidence` 可审计基石字段。
- **转换层（`suggest/action-card.ts`）**：`SuggestionRecord → ActionCard` 纯函数转换——`toCardStatus`（suggested→pending / accepted→accepted / ignored→dismissed / never→resolved）、`confidenceToPriority`（≥0.8 urgent / ≥0.5 normal / <0.5 low）、`actionToTarget`（动作→可点击目标）、`allowedActionsFor`、`toActionCard`/`toActionCards`。
- **视图 API（`suggest/service.ts`）**：`listActionCards(status?)` / `getActionCardById(id)`——以统一卡片协议列出待处理事项，供呈现层（Today/Island/移动端）消费。
- **MCP 工具 `card_list` / `card_get`**：任何宿主可通过 MCP 读取统一 ActionCard 视图（当前来源 suggestion，未来 agent/automation/bridge 投递同协议卡片）。
- **零迁移设计**：ActionCard 为运行时派生视图，`suggestions.json` 保持 version 1，现有 0.5.x 用户数据零破坏；旧 API（`listSuggestions` 等）不变。

### 修复

- **MCP SDK 1.30.0 兼容（P0）**：SDK 升级后 `validateToolOutput` 要求有 outputSchema 的工具返回必须带 `structuredContent`，否则抛 `Output validation error`——此前**所有 20 个工具在 1.30.0 下全部不可用**。修复：`text()` 补 `structuredContent`，`textResultSchema` 改为 `z.object({ text })`。基线 10 个失败全部转绿。
- **发布脚本版本号硬编码漂移**：`publish-proactive.sh` 的 `VERSION` 与已发布版本脱钩风险，本次 0.6.0 已同步。
- **root `test` script 语法错误**：`bun test --parallel 1` 中 `1` 被当作 filter 导致 0 测试运行；改为 `--parallel=1`（CI 同步，保持串行防 env 污染）
- **`actionToTarget` 脏数据防御**：磁盘数据 `action` 缺失时返回 undefined 而非抛错，防 `card_list` 整体崩溃。

### 测试

- 282 全绿（新增 25：ActionCard 转换层 + 3 MCP 端到端），core + mcp typecheck 干净

## 0.5.4 (2026-08-07)

「性能与记忆治理」批次：Roadmap 仅剩的两个纯代码项落地（M9）。

### 新增

- **记忆索引化（倒排索引，M9）**：新增 `inverted-index.ts`——term → atomIds 倒排索引，`memory_recall` 先用索引缩小候选集（只扫描含查询词的 atoms），替代全量扫描；内存缓存 + 签名失效（数量/首尾 id 变化自动重建）+ store 写入时显式失效；无命中时 fail-open 回退全量，保证不漏召回。支撑上万条记忆，召回结果与全量扫描一致（回归覆盖）。
- **自动归档 / TTL 记忆管理（M9）**：新增 `ttl.ts`——按类型默认 TTL（event 30 天 / todo_context 90 天 / fact 365 天；preference/correction/sop 永久），`PROACTIVE_TTL_DAYS=N` 统一覆盖、`PROACTIVE_TTL_OFF=1` 禁用；过期 atom 移入 `archive/archive.jsonl` 并从 atoms 删除（自然不进召回）；recall 前懒执行（每天至多一次）；`memory_stats` 展示归档数。
- **CLI `proactive-mcp archive`**：`--status` 查看归档配置 / `--dry-run` 预览过期数 / 直接执行归档。

### 测试

- 255 全绿（新增 16：inverted-index 8 + ttl 8），core + mcp typecheck 干净
- `bun test` 改为串行（`--parallel 1`）：memory 层测试依赖 `PROACTIVE_DATA_DIR/PROMA_MEMORY_DIR`，并行 worker 共享 env 会互相污染（既有已知问题，随 ttl 磁盘测试扩大而暴露）

## 0.5.3 (2026-08-07)

「真实场景 dogfooding 修复」批次：依据全栈开发者真实使用 Claude Code + Kimi Code 的模拟验证报告（`.context/pa-dogfood-simulation-report.md`）修复的断点。

### P0

- **时间解析器支持带空格的中文时间**：`每天下午 5 点`（数字前带空格）此前解析失败落到默认 09:00，导致 `suggest_accept` 创建的定时任务在错误时间调度；现正确解析为 cron `17 0 * * *`（每周/每月/明天等同修）

### P1

- **"待办"产品名词不再误报 todo 建议**：「笔记+待办全栈应用」这类项目/功能名含"待办"的上下文被排除；"待办清单/事项/任务"真实语义保留
- **README 补充非交互模式说明**：hooks 仅在 Claude Code 交互式 TUI 会话触发；`claude -p` 脚本场景需 `--allowedTools "mcp__proactive-agent__*"` 显式授权（`acceptEdits` 不授予 MCP 工具权限）
- **README 补充 Kimi 前置条件**：需 `kimi` 登录或配置 `config.toml` provider/api_key，否则报 `No model configured`；诊断 `kimi doctor` / `kimi provider list`

### P2

- **memory_extract 指令文本过滤**：LLM 提取时误把 prompt 开发指令（"用 Bun.serve 起 HTTP 服务（默认端口 8787）…"）当偏好记忆的噪声项被过滤（pending 防投毒之外的源头治理）
- **repeat 建议标题用意图核心词**：多次"帮我总结 X" → 标题"定期总结"（此前用首条完整文本）
- **Today 面板展示项目标识**：顶部显示 `项目 <displayName>（key=<projectKey> · <identitySource>）`，多项目隔离时明确数据范围

### 测试

- 239 全绿（新增 10：time-parse 带空格 4 + signals 待办名词 2 + extractor 指令过滤 4），core + mcp typecheck 干净

## 0.5.2 (2026-08-06)

「真实场景断点修复」批次：依据子代理独立审查（真实 Claude Code dogfooding）发现的问题。

### P0

- **Action Executor 默认宿主落地**：新增 `host-executor.ts` + `task-store.ts`——MCP server 启动时注册默认本地执行器，`suggest_accept` 接受 automation/todo 建议 → 写入本地任务队列（`PROACTIVE_DATA_DIR/tasks.json`），返回「✅ 已创建定时任务 #task_xxx」，不再只是降级指令文本；宿主（Proma/Kimi）注入真实执行器时自动覆盖
- **suggest_accept 支持 host 参数**：降级文案准确显示当前宿主名

### P1

- **SessionStart 注入记忆内容**：today-push 追加用户画像摘要 + 高优先级记忆 recall，让记忆真正进入工作流（不再只推建议标题）
- **Stop hook transcript 兜底修复**：移除把 `CLAUDE_PROJECT_DIR`（目录）当 transcript 文件读的错误兜底

### P2

- **周期需求不被 correction 抢占**：「以后每天下午5点检查」→ automation（不再误判为纠正）；「setTimeout 定时器」名词不受影响
- **UserPromptSubmit hook 传最近 N 条消息**：repeat 信号在会话中可命中
- **today-push 去重降频**：同一建议只注入一次（`.today-push-injected.json` 记录）

### 测试

- 229 全绿（新增 4），core + mcp typecheck 干净

## 0.5.1 (2026-08-06)

「评审修复」批次：0.5.0 重评估发现问题的修补。

### 修复

- **Kimi hooks 安装文档改 TOML**（P0-1）：Kimi Code 实际配置是 `~/.kimi-code/config.toml` 的 `[[hooks]]` 数组（event/matcher/command/timeout），不是 JSON；修正 hook 注释与 README 安装说明
- **CI 加测试门禁**（P0-2）：publish workflow 在 build 前跑 `bun test` + typecheck，防发布前不验证
- **suggest_now 暴露 trigger 参数**（P1-1）：支持 session_end（默认）/ session_mid（强信号才推）/ manual，转发 evaluateNow

### 文档

- README FAQ 增加 M9 性能边界说明（记忆上万条后 recall 全量扫描，建议索引化）

## 0.5.0 (2026-08-06)

「主动推送闭环」批次：建议从"等用户来看"升级为"送到用户面前"。

### 新增

- **`evaluateNow(context)` 统一入口**：5 种触发点（session_start / session_mid / session_end / manual / timer）
  - `session_mid`：会话中实时评估，只推强信号（correction/automation），单次 1 条
  - `session_start`：返回存量待处理建议（today-push 逻辑内聚 core）
  - `session_end`：兼容旧 evaluateSessionSuggestions（内部转发）
- **Claude Code UserPromptSubmit hook**（`hooks/user-prompt.ts`）：会话中输入"以后都用 pnpm"立即收到建议；弱信号自动沉默
- **Kimi Code 主动转述**（`hooks/kimi-user-prompt.ts` + common）：输出对齐 Kimi task 通知范式的 `<notification>` XML（模型可见 → 主动向用户转述建议），复用 Kimi externalHooks UserPromptSubmit 通道
- **Today 面板 `POST /api/evaluate`**：宿主 push 端点，把最近消息推过来触发会话中评估
- **Action Executor（M6）**（`suggest/actions.ts`）：`suggest_accept` 统一走 Executor——
  - correction：写入纠正 + 确认（保持闭环）
  - automation/todo：宿主注入 `setActionExecutorProvider` 则真实创建（返回 "已创建 #xxx"），无宿主则降级为可执行指令文本
  - MCP `suggest_accept` 现在返回动作执行结果，不再只是"已记录"
- **时间/周期解析器**（`suggest/time-parse.ts`）：中英文时间表达 → `{cron?, dueAt?, label}`
  - "每天下午5点" → `0 17 * * *`；"remind me tomorrow at 10am" → dueAt
  - automation/followup 建议标题与 action 预填真实时间
- **英文信号**：correction/automation/followup/todo 英文模式（please always / every day / remind me tomorrow / not done yet）
- **建议 ROI 指标面板（M8）**：
  - core：`suggestionRoiStats(days)` 漏斗统计（suggested/accepted/ignored/never）+ 类型接受率 + 打扰率
  - 自动降预算：接受率 <30% 且样本 ≥5 → `shouldReduceBudget()` 返回 true，evaluateNow 门槛自动提高到 0.9（少打扰）
  - Today 面板新增「建议 ROI」区：漏斗 + 类型接受率 + 降预算提示
- `init` 生成的 Claude Code hooks 配置新增 UserPromptSubmit 事件

### 测试

- 新增 49 个测试（evaluateNow 10 + 英文信号 11 + 时间解析 17 + Action Executor 6 + ROI 5），总计 225 全绿

## 0.4.0 (2026-08-06)

「引导闭环」批次：让第一次使用的开发者对真实项目获得记忆，感受到"它懂我的项目"。

### 新增

- **`proactive-mcp extract`**：对已有项目做一次记忆提取（冷启动引导）——扫描 README / docs/ / package.json / 近期 git log / TODO/FIXME，纯规则零外发，默认 pending（防投毒，确认后进入召回）；`--dry-run` 预览 / `--global` 写共享层
- 提取源决策（方案 D）：零风险底座（README/docs/package/git log）+ TODO/FIXME 增强（todo_context，对 suggest 引擎价值最高）+ 可选 LLM 提炼留 V2
- 限额硬约束：文件 ≤200 / TODO ≤20 / README 截断，防大仓库失控

## 0.3.0 (2026-08-06)

「按项目记忆」正式版：数据模型从全局一份改为按项目隔离 + 显式全局共享。

### 新增

- 项目身份解析：PROACTIVE_PROJECT env → git remote → package.json name → 路径 hash
- 数据布局：projects/<key>/（项目隔离）+ global/（显式共享）；PROMA_MEMORY_DIR 单层兼容
- MCP 工具 scope 参数：memory_capture/recall/persona_get 支持 project/global/auto；新增 persona_save
- migrate CLI：旧数据自动迁移到 global 层（--apply 执行 / --preview 预览 / --status / --merge-to-global 反向收敛）
- 逃生开关：PROACTIVE_SCOPE=global 全部读写回退 0.2 单层（与共享层物理分离）
- 双层 recall：默认 auto = 项目 + 全局合并，全局命中降权（×0.8）并标注 [shared]

### 修复（beta 实测）

- 迁移幂等判断：先跑 doctor/stats 不再阻断迁移
- merge-to-global：atoms 按 fingerprint 去重合并进 global
- 建议跨层路由：迁移后 global 老建议可 accept/ignore
- 逃生数据物理分离，不再泄漏进 global 共享层
- 中文/特殊字符项目名 key 碰撞修复
- hybrid 检索 scope 穿透；persona 合并同语义去重；corrections 跨层

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
