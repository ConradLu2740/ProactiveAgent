# Changelog

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
