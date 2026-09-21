import { join } from "node:path"
import type { EmbeddingPort, LlmPort } from "@memory-palace/core"
import { MemoryPalace } from "@memory-palace/core"
import type { LlmBundle } from "@memory-palace/llm"
import { createLlmBundle } from "@memory-palace/llm"
import type { Clock, Config, ConfigOverrides } from "@memory-palace/shared"
import {
  assertProviderCredentials,
  ConfigurationError,
  createLogger,
  loadConfig,
  systemClock,
} from "@memory-palace/shared"
import type { StorageBundle } from "@memory-palace/storage-pg"
import { createStorage, readEmbeddingDim } from "@memory-palace/storage-pg"

/**
 * Composition root.
 *
 * The only place that knows about every layer at once. Keeping it in one module
 * means the MCP server and the HTTP API cannot drift into wiring things
 * differently — a class of bug that only shows up in one of the two surfaces.
 */

export interface Runtime {
  config: Config
  palace: MemoryPalace
  storage: StorageBundle
  llm: LlmBundle
  /** Verifies the configured embedding width against the actual schema. */
  assertSchemaMatchesConfig(): Promise<void>
  close(): Promise<void>
}

export interface RuntimeOptions {
  config?: ConfigOverrides
  /** Persist the LLM response cache to disk. On by default so evals do not re-bill. */
  cachePath?: string
  noCache?: boolean
  /**
   * Injected time source. Production uses the system clock; tests pass a
   * `FixedClock` so temporal behaviour is deterministic.
   */
  clock?: Clock
  /**
   * Override the provider implementations. Used by the eval harness to swap in
   * the oracle / null models without duplicating the whole composition root.
   */
  llm?: LlmPort
  embeddings?: EmbeddingPort
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const config = loadConfig(options.config)
  assertProviderCredentials(config)

  const logger = createLogger(config.logLevel, { app: "memory-palace" })

  const storage = createStorage(config)
  const cachePath = options.cachePath ?? join(config.dataDir, "llm-cache.json")
  const bundle = createLlmBundle(config, { cachePath, noCache: options.noCache })
  const llm = {
    ...bundle,
    llm: options.llm ?? bundle.llm,
    embeddings: options.embeddings ?? bundle.embeddings,
  }

  const palace = new MemoryPalace({
    store: storage.store,
    search: storage.search,
    llm: llm.llm,
    embeddings: llm.embeddings,
    clock: options.clock ?? systemClock,
    logger,
    defaultUserId: config.userId,
    minSemanticSimilarity: config.recall.minSemanticSimilarity,
    minScore: config.recall.minScore,
    semanticRescueMargin: config.recall.semanticRescueMargin,
    rescueMinRelevance: config.recall.rescueMinRelevance,
  })

  logger.info("runtime ready", {
    userId: config.userId,
    providers: llm.describe(),
    database: safeHost(config.databaseUrl),
  })

  return {
    config,
    palace,
    storage,
    llm,
    async assertSchemaMatchesConfig() {
      // pgvector needs a declared width to index, so the column is fixed and a
      // mismatch cannot be worked around at query time. Compare against what the
      // DATABASE says, not a constant in the source.
      const actual = await readEmbeddingDim(storage.db)
      if (actual !== null && actual !== config.embedding.dim) {
        throw new ConfigurationError(
          `the schema stores vector(${actual}) but MP_EMBEDDING_DIM=${config.embedding.dim}.\n` +
            `Run: pnpm embedding:dim ${config.embedding.dim}   (this discards existing vectors)\n` +
            `then: pnpm embedding:reembed                     (recomputes them)`,
        )
      }
    },
    async close() {
      llm.cache.flush()
      await storage.close()
    },
  }
}

/** Host and database only — never log credentials. */
function safeHost(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`
  } catch {
    return "<unparsable>"
  }
}
