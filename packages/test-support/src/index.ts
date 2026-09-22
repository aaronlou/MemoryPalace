import type { EmbeddingPort, LlmPort } from "@memory-palace/core"
import type { RepoFetcher, Runtime } from "@memory-palace/runtime"
import { createRuntime } from "@memory-palace/runtime"
import type { ConfigOverrides } from "@memory-palace/shared"
import { FixedClock } from "@memory-palace/shared"
import { PgDatabase, readEmbeddingDim, VECTOR_DIM } from "@memory-palace/storage-pg"

/**
 * Test support.
 *
 * A separate package rather than a helper inside each test file: every
 * integration test needs the same three things (a runtime on mock providers, a
 * frozen clock, and a clean database), and letting those drift between files is
 * how flaky suites are born. It is separate from `runtime` so that production
 * code cannot accidentally import test wiring.
 */

export interface TestRuntime extends Runtime {
  userId: string
  clock: FixedClock
  cleanup(): Promise<void>
}

export interface TestRuntimeOptions {
  userId?: string
  /** Frozen "now". Temporal tests depend on this being deterministic. */
  now?: string
  config?: ConfigOverrides
  /** Replace the language model, e.g. with a failing one. */
  llm?: LlmPort
  /** How a candidate repository is read. Defaults to a stub, never the network. */
  repoFetcher?: RepoFetcher
  /** Replace the embedding provider. */
  embeddings?: EmbeddingPort
}

/**
 * The database tests run against when `DATABASE_URL` is not set.
 *
 * Deliberately NOT the development database. Tests truncate every table, so
 * defaulting to `memory_palace` meant a plain `pnpm test` silently deleted the
 * user's own memories — which happened twice during development, seeding included.
 * A separate database makes that impossible instead of merely warned about; create
 * it once with `pnpm db:test`.
 */
export const TEST_DATABASE_URL = "postgresql://mp@127.0.0.1:55432/memory_palace_test"

/**
 * What a test sees when a repository is read.
 *
 * A stub by default rather than the real client: a test that reaches GitHub is
 * slow, rate-limited, offline-hostile, and would assert against a README that can
 * change under it. Tests that need different facts pass their own fetcher.
 */
export const stubRepoFetcher: RepoFetcher = {
  async fetch(repo) {
    return {
      repo,
      url: `https://github.com/${repo}`,
      description: "A stub description",
      topics: ["memory"],
      language: "Python",
      defaultBranch: "main",
      revision: "0".repeat(40),
      readme: "# Stub\n\nA repository the tests pretend to read.",
    }
  },
}
const DEFAULT_TEST_DB = TEST_DATABASE_URL

/**
 * Async because the embedding width is read from the schema.
 *
 * `pnpm embedding:dim` makes the vector column a per-deployment property, so a
 * suite that hardcoded 1024 would break the moment someone switched models.
 * Asking the database keeps the tests correct at any width.
 */
export async function createTestRuntime(options: TestRuntimeOptions = {}): Promise<TestRuntime> {
  const userId = options.userId ?? "test-user"
  const clock = new FixedClock(options.now ?? "2026-09-21T12:00:00.000Z")
  const databaseUrl = options.config?.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_TEST_DB
  const schemaDim = await schemaEmbeddingDim(databaseUrl)

  const override = options.config ?? {}
  const runtime = createRuntime({
    noCache: true,
    clock,
    llm: options.llm,
    embeddings: options.embeddings,
    repoFetcher: options.repoFetcher ?? stubRepoFetcher,
    config: {
      ...override,
      databaseUrl: override.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_TEST_DB,
      userId: override.userId ?? userId,
      logLevel: override.logLevel ?? "error",
      // Mock providers: the suite must run with no credentials and no network.
      llm: { provider: "mock", ...(override.llm ?? {}) },
      embedding: { provider: "mock", dim: schemaDim, ...(override.embedding ?? {}) },
    },
  })

  return Object.assign(runtime, {
    userId,
    clock,
    async cleanup() {
      await runtime.close()
    },
  })
}

/**
 * The vector width the schema actually declares.
 *
 * Exported because a test that injects its own embedder has to build vectors of
 * the right length, and it has to learn that length the same way the runtime
 * does — from the database, not from a constant.
 */
export async function schemaEmbeddingDim(
  databaseUrl: string = process.env.DATABASE_URL ?? DEFAULT_TEST_DB,
): Promise<number> {
  const probe = new PgDatabase(databaseUrl, 1)
  try {
    return (await readEmbeddingDim(probe)) ?? VECTOR_DIM
  } finally {
    await probe.close()
  }
}

/** Delete every row. Uses TRUNCATE so tests cannot leak state between files. */
export async function truncateAll(db: PgDatabase): Promise<void> {
  await db.query(
    // `prior_art` has no cascade path to `memories`, so it has to be named here
    // explicitly — otherwise entries leak between test files.
    `TRUNCATE observations, memories, memory_relations, entities, memory_entities,
              memory_sources, agent_policies, extraction_runs, memory_embeddings, prior_art
     RESTART IDENTITY CASCADE`,
  )
}

/** All memory rows for a user, oldest first. Handy for assertions. */
export async function allMemories(db: PgDatabase, userId: string): Promise<MemoryRowLite[]> {
  const { rows } = await db.query<MemoryRowLite>(
    `SELECT id, type, content, status, valid_from, valid_until, recorded_at, superseded_at,
            confidence, importance, reinforced_count
       FROM memories WHERE user_id = $1 ORDER BY recorded_at, id`,
    [userId],
  )
  return rows
}

export interface MemoryRowLite {
  id: string
  type: string
  content: string
  status: string
  valid_from: Date | null
  valid_until: Date | null
  recorded_at: Date
  superseded_at: Date | null
  confidence: number
  importance: number
  reinforced_count: number
}
