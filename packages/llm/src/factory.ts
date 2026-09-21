import { resolve } from "node:path"
import type { EmbeddingPort, LlmPort } from "@memory-palace/core"
import type { Config } from "@memory-palace/shared"
import { AiSdkEmbedding, AiSdkLlm } from "./ai-sdk.js"
import type { ResponseCache } from "./cache.js"
import { FileCache, MemoryCache, NullCache } from "./cache.js"
import { MockEmbedding, RuleBasedLlm } from "./mock.js"
import { OllamaEmbedding } from "./ollama.js"

export interface LlmBundle {
  llm: LlmPort
  embeddings: EmbeddingPort
  cache: ResponseCache
  /** Human-readable summary for startup logs. */
  describe(): string
}

export interface LlmBundleOptions {
  /** Use the on-disk cache so eval reruns do not re-bill. */
  cachePath?: string
  /** Disable caching entirely, e.g. to measure real latency and cost. */
  noCache?: boolean
}

/**
 * Build the provider bundle from configuration.
 *
 * The mock provider is a first-class option, not a test-only hack: it is what
 * makes `pnpm test` and `pnpm eval` runnable with no credentials, which in turn
 * is what makes them run often enough to be worth having.
 */
export function createLlmBundle(config: Config, options: LlmBundleOptions = {}): LlmBundle {
  const cache: ResponseCache = options.noCache
    ? new NullCache()
    : options.cachePath
      ? new FileCache(resolve(options.cachePath))
      : new MemoryCache()

  const usesMockLlm = config.llm.provider === "mock"
  const usesMockEmbedding = config.embedding.provider === "mock"

  const llm: LlmPort = usesMockLlm ? new RuleBasedLlm() : new AiSdkLlm(config, cache)
  const embeddings: EmbeddingPort = usesMockEmbedding
    ? new MockEmbedding(config.embedding.dim)
    : config.embedding.provider === "ollama"
      ? new OllamaEmbedding({
          model: config.embedding.model,
          dim: config.embedding.dim,
          baseUrl: config.embedding.ollamaBaseUrl,
        })
      : new AiSdkEmbedding(config)

  return {
    llm,
    embeddings,
    cache,
    describe: () =>
      `llm=${usesMockLlm ? "mock(rule-based)" : config.llm.provider}:${llm.defaultModelId} ` +
      `embedding=${usesMockEmbedding ? "mock(hashing)" : config.embedding.provider}:${embeddings.modelId}(${embeddings.dim}d)${config.embedding.provider === "ollama" ? ` @${config.embedding.ollamaBaseUrl}` : ""}`,
  }
}
