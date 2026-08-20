# Changelog

## 0.11.0 (2026-08-20)「daemon 跟随模式 + 项目约束冲突提醒」

- **daemon --follow <进程名>（跟随模式）**：目标应用运行时才评估 + 桌面通知，关闭即休眠（打开后自动恢复，无需重启 daemon）。解决「只在打开 Proma 开发时才需要 PA 活跃」的日常使用需求。
  - 检测：`pgrep -f` 命令行子串匹配 + 排除自身 pid（macOS 的 comm 是完整路径，`-x` 匹配不上应用主进程——真实环境实测修复）
  - CLI：`proactive-mcp daemon --follow Proma`；`--install --follow <名>` 自启时把跟随参数写入 launchd plist / systemd unit
  - 测试：36/36（新增 4 用例：目标未运行休眠 / 运行正常评估通知 / 未运行→运行自动恢复 / 空名不限制）；真实启动验证通过
- **项目约束记忆 + 冲突主动提醒（daemon --project <根>）**：项目里明确「用 pnpm」自动记住；后期出现对立指令「用 npm」→ 主动提醒「本项目已确定用 pnpm，确认切换？」。
  - 链路（确定性）：daemon 高频巡检（默认 5 分钟）→ 增量读 Proma 会话（session-reader，只读不改写）→ LLM 提取项目约束（user 指定；仅新内容时调用，空闲零成本）→ 写入项目层记忆（默认 pending 防投毒）→ 对立词对表 + use/avoid 语义规则冲突检测 → 桌面通知（24h 同主题去重 + 独立每日上限 10）
  - 隐私：会话原文只本机处理；LLM 提取外发到配置的 LLM（与 Proma 行为一致）；原文不进日志/通知/镜像
  - 新文件：session-reader.ts（增量游标）/ project-constraint.ts（LLM 提取 schema + 对立词对 + 冲突判定）；core 新增项目层按 key 读写（readProjectAtomsByKey/writeProjectAtomByKey）与 projectConstraints/captureProjectConstraint
  - 真实冒烟：约束 use pnpm + 会话「改用 npm」→ LLM 提取 use npm → 冲突命中 → 通知文案正确
  - 测试：全仓 435/435（新增 session-reader 6 / project-constraint 15 / daemon 约束巡检 6）
- **修复：tools.ts 两处双逗号语法错误**（`description: '...',,` → 单逗号；导致 server.test 加载失败）

## 0.10.0 (2026-08-13)「Harness 适配层 + 生态收口」

- **UMP 导出格式对齐官方 SDK（互操作实测修复）**：官方 @universalmemoryprotocol/core JsonFileStore 只认记录数组（每条自带 ump 字段），旧 {ump,records} 包装被直接拒绝。导出改为官方格式 + 版本 1.0；导入兼容两种输入。实测：官方 SDK 加载 5/5、recall（带 scope.owner）全命中。
- **demo-data --clean 误删防护**：无 .demo-data-marker 时拒绝清理（实测误删真实数据目录后修复；clean 必须隔离目录或确认 marker）。
- **Kimi SessionEnd 收尾沉淀（kimi-session-end.js）**：读 ~/.kimi-code/sessions wire.jsonl（context.append_message）提取消息 → memory_extract（默认待确认）+ 建议评估。
- **detectTool 识别 Kimi client_type**（0.35 事件基座，跨工具事件统计修正）。
- **0.6.1 事件按 pk 隔离**：daemon 评估按事件 pk 分组，各组分别 evaluateNow(projectHint) 写入对应项目建议（多项目不串味）；core persistSuggestion 支持指定层写入。
- **0.8.1 通知→处理 ROI 漏斗**：daemon 通知成功写 notify 事件、accept/ignore 写 handle 事件；面板新增「通知→处理」卡（近 7 天转化率，实时刷新）；转化口径 = 被通知且被处理（会话内直接反馈不计入）。
- **M1 HostAdapter 接口（harness 适配层）**：`src/adapter/`（types/claude/kimi/index）：5 维度接口 + capabilities 能力矩阵（Kimi resources/prompts=false、hooks partial 带 0.34→0.35 note；参考 jido_harness/harnery/agent-harness）；claude/kimi adapter 收编 hooks 纯函数（transcript/wire 提取、文本/notification 渲染、注入渲染），hooks 脚本薄化行为不变（401/401 测试 + Kimi 真实闭环不回归）。
- **M2 cursor adapter**：cursor.ts 按 Claude Code hooks 兼容声明实现（sessionStart/beforeSubmitPrompt/stop 事件映射 + camelCase 宿主识别）；能力矩阵诚实标注（本机无 Cursor，hooks/sessionRead 待实测）；403/403 测试。
- **M3 cline/codex adapter**：感知经 event-capture 通用入口接入（start/message/end/commit 事件映射）；能力诚实标注（hooks partial 带接入指引、会话读取未调研、表达降级 daemon 通知）；404/404 测试。
- **M4 独立包 @proactive-agent/adapters@0.1.0（已发布 npm）**：HostAdapter 接口 + 5 个宿主 adapter（claude/kimi/cursor/cline/codex）+ 注册表，零运行时依赖；mcp/hooks 改消费该包（file: 链接 + bundle 内联，行为不变）；publish 脚本支持 adapters 构建/发布。

## 0.9.2 (2026-08-12)

「Kimi Code 深度使用」批次：让 ProactiveAgent 在 Kimi Code CLI 里真正"更好用"（调研 + 实测驱动）。

### 新增

- **Kimi 主动 Agent 模板（P0）**：`init --kimi` 现在同时生成 `~/.kimi-code/agents/proactive.md`（Kimi 官方自定义 Agent 格式，frontmatter + 提示词驱动的主动记忆：会话开始 persona_get/scene_summary 注入 → 对话中主动 memory_capture/memory_recall → 收尾 memory_extract；含"否定词必须保留"规则）。Kimi 0.34 hooks 系统运行时不可用（实测 SessionStart/UserPromptSubmit 均不触发），主动能力改由提示词驱动：`kimi --agent proactive` 一条命令启动。真实会话已验证 capture→recall 闭环（DeepSeek 模型主动调工具 + 记忆落盘）。
- **Kimi Plugin（kimi-plugin/ 目录，随仓库分发）**：`/plugins install https://github.com/ConradLu2740/ProactiveAgent/tree/main/kimi-plugin` 一条命令安装。自带 MCP server 声明（npx 拉起）+ **systemPrompt 全局注入**（普通会话即主动记忆，无需 --agent）+ proactive Agent + `/remember`/`/recall` 快捷命令。本机实测：安装 → 普通 `kimi -p` 会话主动 capture（模型引述插件指令）→ recall 正确召回，全链路通过。
- **Kimi 权限预配置建议**：`init --kimi` 打印 `config.toml` 的 `[[permission.rules]]` 只读工具 allow 建议（persona_get/memory_recall/scene_summary/memory_stats/suggest_now/daily_review/onboarding_guide/memory_pending/suggest_list/card_list/card_get），写类保留手动审批。
- **memory_capture 否定词提示**：content 字段 describe 明示"不要用 X" 必须原样保留（跨宿主健壮性）。

### 修复（子代理对抗审查后）

- **P1-1 `init --kimi --dry-run` 误报"已存在"**：writeKimiUserMcp/writeKimiAgentFile 返回值增加显式 `reason`（exists/dry-run/wrote），dry-run 全新环境正确输出"将写入…（未写盘）"。
- **P1-2/P1-3 测试补齐**：合并保留用户已有 server 条目、HOME 缺失跳过、dry-run 零写盘等用例。

### 测试

- 103/103（新增 cli-init 用例 10+3）；core + mcp typecheck 干净；真实 Kimi Code CLI 会话实测闭环。

### 子代理测评修复（kimi-plugin）

独立测评（规范审查 + 4 轮真实会话实测）后修复：

- **工具全名统一**：agents/proactive.md 与 commands 里的短名（persona_get 等）全部改为模型可见全名 `mcp__proactive-agent__*`（干净环境实测：全名调用成功、短名无效）。
- **README 命令名修正**：`/remember` → `/proactive-agent:remember`（官方 `<plugin>:<command>` 规范）。
- **权限配置示例**：README 增加 `[[permission.rules]]` 只读工具 allow 示例（不授写类、警示勿用 `mcp__*` 全量放行）。
- **固定版本 + 版本联动**：manifest 固定 `@proactive-agent/mcp@0.9.2`（防漂移），publish 脚本自动同步 `kimi.plugin.json` version 与依赖版本，并打包 `kimi-plugin.zip`（zip 根即插件根，release asset 分发）。
- **scope 语义提示**：SYSTEM.md 明确"默认写入当前项目，跨项目偏好显式 scope=global"（实测模型对默认值有困惑）。
- **冲突指引**：README 首屏给出 mcp.json 同名 server 双注册的检测与二选一指引（实测双注册真实存在）。

### 测评结论

功能本体质量过硬（capture→recall 闭环、否定词保留、无关任务不喧宾夺主、仅插件干净环境全名有效）；分发层面原 P0（未推 GitHub + `tree/main/kimi-plugin` URL 不可用）由分发形式决策（zip asset）+ 推送解决。

### 0.35 hooks 恢复（2026-08-12 复测）

- **Kimi 0.35.0 hooks 恢复**：SessionStart + UserPromptSubmit 均触发（0.34 运行时缺陷已修复）。
- **真实 hooks 链路启用**：SessionStart → `today-push.js`（会话开始注入建议/画像/记忆，无内容则沉默）；UserPromptSubmit → `kimi-user-prompt.js`（强信号 correction/automation → `<notification>` XML 注入上下文，模型主动转述）。实测强信号消息输出 notification 完整。
- **detectTool 修复**：识别 Kimi 事件基座字段 `client_type: kimi_code_cli`（此前 Kimi 事件被标为 claude，影响跨工具事件统计）。
- **官方市场咨询**：在 kimi-code #1566 评论咨询 curated 上架规范（PR 路径 / zip URL source 是否接受 / 安全要求），收到答复后提 PR。

## 0.9.1 (2026-08-12)

「0.9.0 评估修复」批次：项目双维子代理评估（pa-project-eval-2026-08.md）后发现并修复。

### 修复

- **发布包 hooks 缺 event-capture.js（P1-1）**：publish 脚本只拷贝 4 个 hook，而 init 要求 5 个（含 event-capture）——npm 用户 `init` 会拒绝写 hooks，0.6 跨工具感知网在发布版不可用。补拷贝 + **hooks 完整性自检**（缺任一直接 exit 1，防再犯）。
- **/api/evaluate 无鉴权（P1-2）**：唯一没上 x-pa-token 的写接口（任意本机进程可触发 LLM 评估/通知）。已加 token 鉴权（与 accept/ignore 同源；宿主 push 需读 `today.token` 带上）。

### 测试

- 369/369（新增 /api/evaluate 401 + 200 用例）；core + mcp typecheck 干净。

## 0.9.0 (2026-08-12)「守护进程 + 感知网 + UMP + 疲劳控制」

### 通知疲劳控制

「插件化主动 Agent」第四站：让守护进程更克制、更懂你。

### 新增

- **每日通知上限**：默认 6 条/天（`PROACTIVE_DAEMON_DAILY_LIMIT` 覆盖），跨天自动重置；达上限当日不再打扰，建议**保留不吞**（次日继续）。
- **通知冷却窗口**：默认 15 分钟（`PROACTIVE_DAEMON_COOLDOWN_MIN` 覆盖），避免短时间内连弹。
- **画像驱动打扰系数**：画像含「减少打扰/勿扰/免打扰/quiet mode」等**全局**表达时系数 0.5（上限减半 + 冷却翻倍）；技术词（--quiet/静默安装/silent mode）与单事项提醒（别提醒我收快递）**不误伤**；词表边界有回归测试。
- **doctor 疲劳状态**：展示「今日 已通知/上限」，达上限 warn，画像命中时标注 ×0.5。

### 修复（子代理对抗审查后）

- **P1 画像词表误报/漏报**：去掉裸技术词（quiet/静默/silent mode），改组合形态；补全局语境词（勿扰/免打扰/dnd/不想被打扰）；单事项提醒不触发全局降档。
- **P2 防御**：dailyNotified 字符串类型防御、时钟回拨不触发永久冷却、cooldown 显式乘法语义、doctor 标注 limit 来源、测试 env 卫生。

### 测试

- 368/368（新增 0.8 用例 10：词表边界 10 场景、limit=1、COOLDOWN=0、时钟回拨、老版本状态兼容）；core + mcp typecheck 干净。

### 生态与分发

「插件化主动 Agent」第三站：UMP 互操作 + adapter 开放。

### 新增

- **UMP 互操作（L0）**：`proactive-mcp ump-export` 导出记忆为 Universal Memory Protocol 文件（`.ump/memory.ump.json`，`{ump:'0.1',records:[...]}`，kind/scope/time/lifecycle/provenance 映射）；`ump-import` 从 UMP 文件导入（默认 pending 防投毒，`--confirm` 即时生效，text 截断 4000 / 单文件上限 10000）；`--confirmed` 仅导出已确认项。
- **UMP 兼容评估文档**：.context/pa-ump-compat-eval.md（协议解读 + PA↔UMP 对照矩阵 + L0/L2 策略，L2 MCP store 桥接待生态成熟）。
- **adapter 开放**：docs/developers/adapter-guide.md（第三方工具接入指南：事件协议 + 三种接入方式 + 隐私说明）+ hooks/adapter-template.ts（脚手架）。
- **core 公共类型导出**：`export * from './shared-types'`（MemoryAtom 等类型进入公共 API 表面）。

### 修复（子代理对抗审查后，均实证复现）

- **P0-1 导出分页截断**：pageSize=200 被 core clamp 到 100 导致 >100 条只导出第一页——终止条件改用 totalPages + 截断警告；120 条回归测试。
- **P0-2 CLI argv 错位**：ump-export/ump-import 从 CLI 完全不可用——sub 改用 argv[0]，CLI 冒烟测试。
- **P0-3 畸形记录崩溃**：records 含 null/非对象导致整批导入崩溃——跳过计数 + 单条容错。
- **P1-1 导入无上限**：text 截断 4000 + 单文件 10000 上限。
- **P1-2 adapter 模板忽略 cwd**：resolvePk 与 event-capture 一致。
- **P1-3 记忆关闭时误导**：跳过计数 + CLI 提示。

### 测试

- 356/356（新增 ump 10：分页/畸形/超长/CLI 冒烟）；core + mcp typecheck 干净。
- 已知限制（0.7.1）：UMP L2 桥接（spec v0.1 未稳定）、Smithery 描述更新需后台手动、mcp.so 手动提交、UMP 官方客户端互操作实测。

### 跨工具感知网

「插件化主动 Agent」第二站：统一事件协议 + daemon 真定时评估（完成 0.5 P0-1 遗留）。

### 新增

- **跨工具统一事件协议**：各工具 hooks 把会话/消息/commit 事件归一化写入 `PROACTIVE_DATA_DIR/events/{date}.jsonl`（短字段 schema、按天落盘、1MB 单文件裁剪、7 天保留、仅当前用户可读写 0700/0600）；并发安全（锁 + 原子替换，多 hook 同机不丢事件不损坏）。
- **daemon 真定时评估**：巡检时读最近事件构造 messages → `evaluateNow({trigger:'timer'})`（sessionId 取最近 msg 事件）；无事件降级纯巡检开口通道。
- **event-capture 通用入口**：`dist/hooks/event-capture.js` 任意工具 hook 传入 JSON 即接入（Cursor camelCase / Claude snake_case 字段自适应、工具白名单、stdin cwd 解析项目身份）。
- **hooks 内联写事件**：Claude Code（SessionStart/UserPromptSubmit/Stop）与 Kimi Code hooks 自动写事件，工具自适应（Kimi is_steer / Cursor camelCase / Claude）。
- **Cursor 接入**：官方支持加载 Claude Code hooks 自动映射，无需额外配置（init 打印跨工具接入指引；不再生成 .cursor/hooks.json 避免双写）。

### 修复（子代理对抗审查后）

- **P0-1 并发写竞态**：锁内完成「裁剪 + 追加」，临时文件 + rename 原子替换（原实现多进程并发丢事件 + 文件损坏，已实证复现并回归）。
- **P1-1 工具标签失真**：hooks 从 stdin 自适应工具（Cursor/Kimi/Claude），不再全部标记 claude。
- **P1-3 sessionId 不可靠**：daemon 从最近 msg 事件取 sid；session-end 传真实 session_id。
- **P1-5 cwd 项目身份**：event-capture 用 stdin cwd 解析 pk。
- **P1-6 事件明文权限**：目录 0700 / 文件 0600。

### 测试

- 66/66（新增 event-store 7 + event-capture 7 + daemon 事件用例；含 4 进程并发写回归）。
- 已知限制（0.6.1 候选）：事件按项目隔离评估（pk 分组 + core projectHint 路由）、Codex/Cline hooks 真机验证、Continue 事件映射核验。

### 守护进程

「插件化主动 Agent」第一站：daemon + 桌面通知主动出口。

### 新增

- **守护进程（daemon）主动出口**：`proactive-mcp daemon` 常驻后台，**巡检待处理建议**并通过桌面通知主动开口（macOS 通知中心 / Windows 托盘气泡 / Linux notify-send，点击打开主动中心面板）；`--install` 一键登录自启（macOS launchd / Linux systemd user）、`--status` / `--stop` 管理（stop 前校验命令行防 pid 复用误杀）；单实例锁（pid + 进程存活探测 + 写入后重读校验，释放仅限本进程）、通知去重（同条不重复打扰）、通知失败下轮重试、DND 门控（免打扰时段不通知且**保留建议不吞**）；巡检间隔 `PROACTIVE_DAEMON_INTERVAL_MIN`（默认 60 分钟）。建议生成来源：hooks（UserPromptSubmit/Stop）与宿主 push（`/api/evaluate`）；真·定时评估随 0.6 感知网接入（0.5 巡检语义，避免无消息空转）。
- **通知内 ActionCard 闭环**：/today 面板建议卡片新增「接受 / 忽略」按钮（`POST /api/suggestions/:id/accept|ignore`，带 `x-pa-token` 面板 token 鉴权防本机恶意 POST），接受 automation/todo 建议经 Action Executor 真实落地为本地任务队列（tasks.json）；服务端幂等预检（已处理建议拒绝重放）；仅当宿主未注入执行器时才注册本地默认执行器。
- **doctor 增加 daemon 健康检查**：进程存活 / 上次巡检 / 上次通知 / 已通知条数。

### 测试

- notifier 10 + daemon 16 + today ActionCard 2（mock 平台命令与引擎，不弹真实通知）；core + mcp typecheck 干净。

## 0.8.1 (2026-08-10)

「0.8.0 独立验证修复」批次：依据协作子代理真实运行验证报告（浏览器实测 + 双层 persona 边界）修复 5 个 P2。

### 修复

- **today 面板 15s 自动刷新后「记忆动态」卡片不更新（P2-1）**：`render()` 只更新 review-box，今日条数/最近条目/超载提示保持旧值。为 activity-summary / activity-overload / activity-list 补 id，随刷新重写。
- **双层 persona（global+project merge）章节超载检测失效（P2-2）**：mergePersonaRaw 输出丢弃 heading，`personaOverloadHint` 改为按 global/project 层分别统计取最差（`detectPersonaOverloadByLayer`）。
- **45 行画像误报超载（P2-3）**：writePersona 注入的 `<!-- persona-version: 2 -->` header 计入行数导致阈值偏移 2 行。`detectPersonaOverload` 统计前剥离 header 注释行与空行。
- **persona_get 超载提示污染 persona 原文（P2-4）**：提示文本不再拼入正文，正文保持纯 markdown，超载信息移入 structuredContent（overloaded/reorganizationHint）。
- **todayEntries 被 recentEntries 截断（P2-5）**：todayEntries 独立统计当日 `memory_log/{today}.md` 行数，与 maxEntries=200 截断解耦。

### 测试

- 299 全绿（新增 4：P2-2 按层检测 2 + P2-3 header 剥离 1 + P2-5 独立统计 1），core + mcp typecheck 干净。
- 浏览器实测：写入日志 → 15s 自动刷新 → 记忆动态卡片正确更新（今日 0→1 条）。

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
