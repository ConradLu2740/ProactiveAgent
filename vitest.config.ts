/**
 * Vitest 配置（原 bun test --parallel=1 迁移）
 *
 * 关键：fileParallelism=false 保持串行——多个测试共享 /tmp 数据目录与
 * process.env（PROACTIVE_DATA_DIR / PROMA_MEMORY_LLM_DISABLED），并行会互相污染
 * （与原 bun 迁移说明一致）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        // 单 worker 串行执行所有文件，彻底隔离 env
        singleFork: true,
      },
    },
    testTimeout: 30000,
  },
})
