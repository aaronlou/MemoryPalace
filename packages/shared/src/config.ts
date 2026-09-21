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
    /**
     * Rerank relevance below which the SMART path vetoes a candidate outright.
     *
     * Measured on the real stack, the reranker is the good signal and the score
     * is not: irrelevant pairs scored 0.502/0.553 cosine with a rerank
     * relevance of 0.050, yet still cleared `minScore` because a lone semantic
     * hit normalises to an RRF of 1.0. On the smart path, "not useful here" is
     * therefore binding. 0 disables the veto.
     */
    minRerankRelevance: number
    /**
     * `auto` escalates to the smart path when the fast path's best answer rests
     * on cosine alone and that cosine is below this.
     *
     * The blended score cannot express "low confidence" — a lone semantic hit
     * collects the same RRF, importance and recency priors as a corroborated one
     * — so this reads the one signal that does say the answer is unresolved.
     * 0 disables the rule (auto then only escalates on a weak score).
     */
    escalateBelowSemanticSimilarity: number
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
  // Swept on the real stack (bge-m3 + DeepSeek) rather than inherited. bge-m3
  // puts unrelated Chinese text at 0.50-0.55, which is *higher* than the
  // paraphrases it needs to retrieve (0.523, 0.560), so the old 0.45 admitted
  // noise. The sweep, recall suite, 14 cases:
  //
  //   floor  fast P@5 / R@5 / negative   smart P@5 / R@5 / negative
  //   0.35   0.488 / 1.000 /  20%        0.893 / 1.000 / 100%
  //   0.45   0.750 / 1.000 /  60%        0.929 / 1.000 / 100%
  //   0.55   0.679 / 0.857 /  80%        0.929 / 1.000 / 100%
  //   0.65   0.714 / 0.786 / 100%        0.929 / 1.000 / 100%
  //
  // 0.65 is where negative accuracy reaches its maximum, which is the criterion
  // this value has always been chosen by — and `auto` and `smart` are
  // indifferent to it (the rescue recovers recall, the veto removes noise), so
  // the only thing the floor still decides is what an explicit `mode: "fast"`
  // call may return. The cost is visible in the table: the fast path gives up
  // R@5 1.000 for 100% negative accuracy. Set 0.45-0.55 to trade back.
  ollama: 0.65,
  // NOT re-swept here: these inherit the earlier 0.45 calibration. The floor is
  // a property of the model, so re-run the sweep above before trusting them.
  openai: 0.45,
  cohere: 0.45,
  google: 0.45,
}

/**
 * How much standing the configured model's relevance judgement has.
 *
 * The smart path treats a low rerank relevance as a veto, and `auto` escalates
 * to it when the fast path's answer is uncorroborated. Both are sound only if
 * the reranker is competent, and the built-in stand-in is not: it scores
 * relevance from token overlap, so a Chinese memory that shares one distinctive
 * term with the query scores ~0.09 while a real reranker scores the same pair
 * near 0.95. Trusting that would delete legitimate recall — measured offline:
 * mock smart recall fell from 0.714/0.786 to 0.500/0.500.
 *
 * This is the same reasoning as the per-provider semantic floor: the right value
 * is a property of the model, not of the system. A stand-in gets 0 (no
 * judgement), real models get the thresholds the real stack was swept to.
 */
const DEFAULT_RERANK_TRUST: Record<
  LlmProviderName,
  { minRerankRelevance: number; escalateBelowSemanticSimilarity: number }
> = {
  // Cannot judge relevance; its verdict has no standing, so nothing vetoes and
  // `auto` keeps its score-based escalation only.
  mock: { minRerankRelevance: 0, escalateBelowSemanticSimilarity: 0 },
  deepseek: { minRerankRelevance: 0.3, escalateBelowSemanticSimilarity: 0.6 },
  openai: { minRerankRelevance: 0.3, escalateBelowSemanticSimilarity: 0.6 },
  anthropic: { minRerankRelevance: 0.3, escalateBelowSemanticSimilarity: 0.6 },
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
  const rerankTrust = DEFAULT_RERANK_TRUST[llmProvider]

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
      minRerankRelevance: floatEnv(
        "MP_RECALL_MIN_RERANK_RELEVANCE",
        rerankTrust.minRerankRelevance,
      ),
      escalateBelowSemanticSimilarity: floatEnv(
        "MP_RECALL_ESCALATE_BELOW_SEMANTIC",
        rerankTrust.escalateBelowSemanticSimilarity,
      ),
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
