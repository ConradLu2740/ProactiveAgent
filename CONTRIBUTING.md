# Contributing to ProactiveAgent

感谢你愿意为 ProactiveAgent 贡献力量！🎉

## 项目简介

ProactiveAgent 是一个**跨工具共享的主动记忆 MCP Server**：让 Claude Code / Kimi Code / Cline / Cursor / Proma 共享同一份记忆，并在合适的时机主动提醒。架构为三层：

```
packages/proactive-core      # 零依赖核心引擎（分层记忆 + 简化 BM25 + 主动建议）
packages/proactive-adapters  # 宿主适配层（claude/kimi/cursor/cline/codex，按能力注册）
packages/proactive-mcp       # MCP 协议层 + CLI + hooks + 守护进程（对外）
kimi-plugin/                 # Kimi Code 插件分发
scripts/ docs/               # 构建脚本与文档
```

## 开发环境

- Node.js **22+**
- npm（monorepo workspaces）

## 常用命令

```bash
npm install          # 安装全部依赖
npm test             # vitest 全量测试（必须全绿）
npm run typecheck    # 三个包 tsc --noEmit（必须全绿）
npm run build        # 构建发布 bundle（输出 dist-publish/）
npm run start:mcp    # 本地启动 MCP server（stdio）
```

## 测试注意事项

- vitest 配置为**串行执行**（`fileParallelism: false`）：多个测试共享 `/tmp` 数据目录与进程环境变量（`PROACTIVE_DATA_DIR` 等），**不要改成并行**，否则会互相污染。
- 测试文件放在 `packages/*/src/**/*.test.ts`。
- 磁盘相关的纯函数测试避免写入真实用户目录（参考 `store.test.ts` 只测不依赖磁盘的纯函数）。

## 提交 PR 流程

1. Fork 本仓库，从 `main` 创建你的分支。
2. 本地确保全绿：`npm test` + `npm run typecheck`。
3. 提交 PR 前填写 PR 模板，说明改动内容与**验证情况**。
4. 维护者 review 后合并；CI（push/PR 自动运行）必须通过。

## 行为准则

请阅读并遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
