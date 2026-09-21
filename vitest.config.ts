import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Tests run against package *source* (not dist) so you never need to build
 * before running them. Applications resolve the built output at runtime.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@memory-palace/shared": r("./packages/shared/src/index.ts"),
      "@memory-palace/core": r("./packages/core/src/index.ts"),
      "@memory-palace/llm": r("./packages/llm/src/index.ts"),
      "@memory-palace/storage-pg": r("./packages/storage-pg/src/index.ts"),
      "@memory-palace/runtime": r("./packages/runtime/src/index.ts"),
      "@memory-palace/test-support": r("./packages/test-support/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "evals/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Integration tests share one physical database and reset it with TRUNCATE.
    // Running files in parallel lets one suite delete rows another is mid-write
    // on, which shows up as baffling foreign-key errors. Correctness first:
    // serialise, and keep the suite fast by keeping each file's work small.
    fileParallelism: false,
  },
})
