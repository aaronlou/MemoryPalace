import { ConfigurationError } from "./errors.js"

export type LlmProviderName = "mock" | "deepseek" | "openai" | "anthropic"
export type EmbeddingProviderName = "mock" | "ollama" | "openai" | "cohere" | "google"

export interface Config {
  /** Postgres connection string. Defaults to the repo-local cluster. */
  databaseUrl: string
  /** Single-user deployment: everything is namespaced under this id. */
  userId: string
  llm: {
    provider: LlmProviderName
    /** Model used for the high-volume extraction step. */
    extractionModel: string
    /** Model used for conflict/dedup adjudication; may be stronger. */
    adjudicationModel: string
    deepseekApiKey?: string
    openaiApiKey?: string
    anthropicApiKey?: string
    /**
     * DeepSeek only enforces strict JSON schemas via tool calls, and only on the
     * /beta base URL. Kept configurable so the reason survives in one place.
     */
    deepseekBaseUrl: string
  }
  embedding: {
    provider: EmbeddingProviderName
    model: string
    dim: number
    openaiApiKey?: string
    /** Base URL of the local Ollama server. */
    ollamaBaseUrl: string
  }
  api: {
    port: number
    host: string
  }
  recall: {
    /**
     * Minimum cosine similarity for a semantic hit to count.
     *
     * This is a property of the EMBEDDING MODEL, not of the system, so it has a
     * per-provider default. A hashing stand-in produces near-orthogonal vectors
     * for unrelated text (~0.0), while a real model puts almost everything in a
     * narrow cone — measured on this corpus, unrelated pairs score up to 0.40
     * and relevant pairs start at 0.60. Reusing one number across both makes the
     * system silently worse, which is exactly what happened when the embedder
     * was switched without recalibrating.
     */
    minSemanticSimilarity: number
    /**
     * Minimum blended score for a memory to be returned at all.
     *
     * Separate from the semantic floor on purpose: the floor gates *candidate
     * generation* per route, while this gates the final ranked result. Lowering
     * one and raising the other is a different tradeoff from moving either
     * alone, and the two have to be tuned together.
     */
    minScore: number
    /**
     * How far below the semantic floor the SMART recall path may probe.
     *
     * The floor rejects hard paraphrases along with noise — the two are not
     * separable by cosine alone. The smart path probes below the floor and
     * keeps a below-floor candidate only when its LLM reranker confirms the
     * candidate's relevance (`rescueMinRelevance`). The fast path never
     * probes: without a confirmation signal a lowered floor would only admit
     * noise. 0 disables.
     */
    semanticRescueMargin: number
    /**
     * Rerank relevance a below-floor (rescued) candidate needs to be recalled.
     * Mirrors the rerank rubric's "useful background" band: a rescued
     * candidate has no above-floor evidence, so it must be at least that
     * useful.
     */
    rescueMinRelevance: number
  }
  logLevel: "debug" | "info" | "warn" | "error"
  /** Directory for JSONL extraction-run logs and eval output. */
  dataDir: string
}

/**
 * Load a `.env` file from the working directory, once.
 *
 * Node's own loader is used rather than a dependency, and its precedence is the
 * one we want: variables already present in the environment win over the file, so
 * `MP_LLM_PROVIDER=deepseek pnpm dev:api` overrides the file without editing it.
 *
 * Without this, `.env.example` documented a workflow that silently did nothing.
 */
let envFileLoaded = false

/**
 * Ensure `.env` has been read.
 *
 * Exported because `loadConfig` is often called too late: anything that decides
 * at module load whether a provider is configured — a test guard, for instance —
 * would otherwise look at `process.env` before the file was read and quietly
 * conclude there are no credentials.
 */
export function ensureEnvLoaded(): void {
  loadEnvFileOnce()
}

function loadEnvFileOnce(): void {
  if (envFileLoaded) return
  envFileLoaded = true
  const path = process.env.MP_ENV_FILE ?? ".env"
  try {
    process.loadEnvFile(path)
  } catch (error) {
    // A missing .env is the normal case, not an error: configuration may come
    // entirely from the environment. Anything else (bad permissions, a malformed
    // file) is worth surfacing.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigurationError(
        `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function env(key: string): string | undefined {
  const v = process.env[key]
  return v === undefined || v === "" ? undefined : v
}

function floatEnv(key: string, fallback: number): number {
  const raw = env(key)
  if (raw === undefined) return fallback
  const n = Number.parseFloat(raw)
  if (Number.isNaN(n) || n < 0 || n > 1) {
    throw new ConfigurationError(`${key} must be a number between 0 and 1, got "${raw}"`)
  }
  return n
}

function intEnv(key: string, fallback: number): number {
  const raw = env(key)
  if (raw === undefined) return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) throw new ConfigurationError(`${key} must be an integer, got "${raw}"`)
  return n
}

const DEFAULT_MODELS: Record<LlmProviderName, { extraction: string; adjudication: string }> = {
  mock: { extraction: "mock-extractor", adjudication: "mock-adjudicator" },
  deepseek: { extraction: "deepseek-chat", adjudication: "deepseek-reasoner" },
  openai: { extraction: "gpt-4.1-mini", adjudication: "gpt-4.1" },
  anthropic: { extraction: "claude-haiku-4-5", adjudication: "claude-sonnet-4-5" },
}

/**
 * Observed cosine overlap between UNRELATED text, per embedding family.
 *
 * Real embedding models cluster: two unrelated sentences still score 0.2-0.4
 * because they share genre, language and register. A floor below that admits
 * everything, which destroys the ability to answer "I don't know".
 */
const DEFAULT_SEMANTIC_FLOOR: Record<EmbeddingProviderName, number> = {
  // Hashing bag-of-tokens: unrelated text is near-orthogonal.
  mock: 0.15,
  // Chosen by sweeping the golden dataset, not by intuition: at 0.45 recall is
  // unchanged (R@5 0.917) while precision and negative accuracy hit their
  // maximum (P@5 0.833, negative 1.000). Below 0.35 false positives climb
  // sharply. 0.45 also gives slightly more headroom than 0.50 for hard
  // paraphrases, at no measured cost.
  ollama: 0.45,
  openai: 0.45,
  cohere: 0.45,
  google: 0.45,
}

const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProviderName, { model: string; dim: number }> = {
  mock: { model: "mock-embedding-1024", dim: 1024 },
  // bge-m3 is 1024-dimensional, which matches the schema's vector(1024) exactly:
  // no migration needed, and it is purpose-built for multilingual retrieval
  // including Chinese.
  ollama: { model: "bge-m3", dim: 1024 },
  // 1024 dims is a deliberate choice: 3x less storage than 3072 for a ~1.6 point
  // MTEB difference, and this is a single-user corpus.
  openai: { model: "text-embedding-3-small", dim: 1536 },
  cohere: { model: "embed-v4.0", dim: 1024 },
  google: { model: "text-embedding-005", dim: 768 },
}

/**
 * Nested overrides.
 *
 * A plain `Partial<Config>` is not usable here: it would require callers to
 * supply every field of `llm` and `embedding` just to change one, which is
 * exactly what tests and CLIs need to avoid.
 */
export interface ConfigOverrides {
  databaseUrl?: string
  userId?: string
  logLevel?: Config["logLevel"]
  dataDir?: string
  api?: Partial<Config["api"]>
  llm?: Partial<Config["llm"]>
  embedding?: Partial<Config["embedding"]>
  recall?: Partial<Config["recall"]>
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  loadEnvFileOnce()

  const llmProvider = (env("MP_LLM_PROVIDER") ?? "mock") as LlmProviderName
  if (!(llmProvider in DEFAULT_MODELS)) {
    throw new ConfigurationError(
      `MP_LLM_PROVIDER must be one of ${Object.keys(DEFAULT_MODELS).join(", ")}, got "${llmProvider}"`,
    )
  }

  const embeddingProvider = (env("MP_EMBEDDING_PROVIDER") ?? "mock") as EmbeddingProviderName
  if (!(embeddingProvider in DEFAULT_EMBEDDING_MODELS)) {
    throw new ConfigurationError(
      `MP_EMBEDDING_PROVIDER must be one of ${Object.keys(DEFAULT_EMBEDDING_MODELS).join(", ")}, got "${embeddingProvider}"`,
    )
  }

  const llmDefaults = DEFAULT_MODELS[llmProvider]
  const embedDefaults = DEFAULT_EMBEDDING_MODELS[embeddingProvider]

  const config: Config = {
    databaseUrl: env("DATABASE_URL") ?? "postgresql://mp@127.0.0.1:55432/memory_palace",
    userId: env("MP_USER_ID") ?? "default-user",
    llm: {
      provider: llmProvider,
      extractionModel: env("MP_LLM_EXTRACTION_MODEL") ?? llmDefaults.extraction,
      adjudicationModel: env("MP_LLM_ADJUDICATION_MODEL") ?? llmDefaults.adjudication,
      deepseekApiKey: env("DEEPSEEK_API_KEY"),
      openaiApiKey: env("OPENAI_API_KEY"),
      anthropicApiKey: env("ANTHROPIC_API_KEY"),
      deepseekBaseUrl: env("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
    },
    embedding: {
      provider: embeddingProvider,
      model: env("MP_EMBEDDING_MODEL") ?? embedDefaults.model,
      dim: intEnv("MP_EMBEDDING_DIM", embedDefaults.dim),
      openaiApiKey: env("OPENAI_API_KEY"),
      ollamaBaseUrl: env("OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434",
    },
    recall: {
      minSemanticSimilarity: floatEnv(
        "MP_RECALL_MIN_SEMANTIC_SIMILARITY",
        DEFAULT_SEMANTIC_FLOOR[embeddingProvider],
      ),
      minScore: floatEnv("MP_RECALL_MIN_SCORE", 0.18),
      semanticRescueMargin: floatEnv("MP_RECALL_SEMANTIC_RESCUE_MARGIN", 0.15),
      rescueMinRelevance: floatEnv("MP_RECALL_RESCUE_MIN_RELEVANCE", 0.6),
    },
    api: {
      port: intEnv("MP_API_PORT", 8787),
      host: env("MP_API_HOST") ?? "127.0.0.1",
    },
    logLevel: (env("MP_LOG_LEVEL") ?? "info") as Config["logLevel"],
    dataDir: env("MP_DATA_DIR") ?? "data",
  }

  // Nested groups are merged key by key. Spreading `overrides` wholesale would
  // replace a complete group with a Partial, widening every field to
  // `T | undefined` — which the Config type correctly rejects, and which would
  // also let a partial override silently drop unrelated settings.
  return {
    ...config,
    databaseUrl: overrides.databaseUrl ?? config.databaseUrl,
    userId: overrides.userId ?? config.userId,
    logLevel: overrides.logLevel ?? config.logLevel,
    dataDir: overrides.dataDir ?? config.dataDir,
    llm: { ...config.llm, ...overrides.llm },
    embedding: { ...config.embedding, ...overrides.embedding },
    api: { ...config.api, ...overrides.api },
    recall: { ...config.recall, ...overrides.recall },
  }
}

/**
 * Fail fast with an actionable message when a provider is configured but its
 * credentials are absent. Called at startup, not on first request.
 */
export function assertProviderCredentials(config: Config): void {
  const { provider, deepseekApiKey, openaiApiKey, anthropicApiKey } = config.llm
  if (provider === "deepseek" && !deepseekApiKey) {
    throw new ConfigurationError(
      "MP_LLM_PROVIDER=deepseek requires DEEPSEEK_API_KEY. Use MP_LLM_PROVIDER=mock to run without credentials.",
    )
  }
  if (provider === "openai" && !openaiApiKey) {
    throw new ConfigurationError(
      "MP_LLM_PROVIDER=openai requires OPENAI_API_KEY. Use MP_LLM_PROVIDER=mock to run without credentials.",
    )
  }
  if (provider === "anthropic" && !anthropicApiKey) {
    throw new ConfigurationError(
      "MP_LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY. Use MP_LLM_PROVIDER=mock to run without credentials.",
    )
  }
  if (config.embedding.provider === "openai" && !config.embedding.openaiApiKey) {
    throw new ConfigurationError(
      "MP_EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY. Use MP_EMBEDDING_PROVIDER=mock to run without credentials.",
    )
  }
}
