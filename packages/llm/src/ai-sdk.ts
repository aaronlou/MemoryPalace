import { createAnthropic } from "@ai-sdk/anthropic"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createOpenAI } from "@ai-sdk/openai"
import type {
  EmbeddingPort,
  GenerateObjectRequest,
  GenerateObjectResult,
  LlmPort,
} from "@memory-palace/core"
import { LlmSchemaError } from "@memory-palace/core"
import type { Config } from "@memory-palace/shared"
import { ConfigurationError } from "@memory-palace/shared"
import { embedMany, generateText, Output } from "ai"
import type { CacheEntry, ResponseCache } from "./cache.js"
import { hashPrompt } from "./cache.js"

/**
 * Real provider adapters, built on the Vercel AI SDK.
 *
 * The AI SDK sits behind `LlmPort` on purpose: it is on major v7 and has shipped
 * roughly two majors a year, each with renames. This file is the only place in
 * the codebase that knows that.
 */

/**
 * Approximate list prices in USD per million tokens.
 *
 * These exist to make "what did this cost?" answerable during development, not
 * to reconcile a bill. Treat them as estimates and update when providers move.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
}

function costOf(modelId: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[modelId]
  if (!price) return 0
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}

function buildModel(config: Config, model: string) {
  const { provider } = config.llm
  switch (provider) {
    case "deepseek": {
      if (!config.llm.deepseekApiKey) {
        throw new ConfigurationError("DEEPSEEK_API_KEY is required for the deepseek provider")
      }
      // Note: strict JSON schemas on DeepSeek require tool calls against the
      // /beta base URL. We use the default endpoint and rely on local
      // `safeParse` plus retry instead — see the retry logic below.
      const client = createDeepSeek({
        apiKey: config.llm.deepseekApiKey,
        baseURL: config.llm.deepseekBaseUrl,
      })
      return client(model)
    }
    case "openai": {
      if (!config.llm.openaiApiKey) {
        throw new ConfigurationError("OPENAI_API_KEY is required for the openai provider")
      }
      return createOpenAI({ apiKey: config.llm.openaiApiKey })(model)
    }
    case "anthropic": {
      if (!config.llm.anthropicApiKey) {
        throw new ConfigurationError("ANTHROPIC_API_KEY is required for the anthropic provider")
      }
      return createAnthropic({ apiKey: config.llm.anthropicApiKey })(model)
    }
    default:
      throw new ConfigurationError(`no HTTP provider for "${provider}"`)
  }
}

/** How many times to re-ask when the model returns schema-invalid output. */
const SCHEMA_RETRIES = 2

export class AiSdkLlm implements LlmPort {
  private readonly config: Config
  private readonly cache: ResponseCache
  readonly defaultModelId: string

  constructor(config: Config, cache: ResponseCache) {
    this.config = config
    this.cache = cache
    this.defaultModelId = config.llm.extractionModel
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    const modelId = req.model ?? this.defaultModelId
    const promptHash = hashPrompt([
      req.schemaName,
      req.instructions,
      req.prompt,
      modelId,
      String(req.temperature ?? 0),
    ])

    const cacheKey = req.cacheKey ? `${req.cacheKey}:${promptHash}` : promptHash
    const hit = this.cache.get(cacheKey)
    if (hit) {
      return {
        value: req.schema.parse(hit.value) as T,
        usage: {
          inputTokens: hit.inputTokens,
          outputTokens: hit.outputTokens,
          costUsd: costOf(hit.modelId, hit.inputTokens, hit.outputTokens),
        },
        modelId: hit.modelId,
        promptHash,
        cached: true,
      }
    }

    let lastError: unknown
    for (let attempt = 0; attempt <= SCHEMA_RETRIES; attempt++) {
      try {
        const result = await generateText({
          model: buildModel(this.config, modelId),
          instructions: req.instructions,
          prompt: req.prompt,
          temperature: req.temperature ?? 0,
          maxOutputTokens: req.maxOutputTokens,
          output: Output.object({ schema: req.schema }),
        })

        const inputTokens = result.usage?.inputTokens ?? 0
        const outputTokens = result.usage?.outputTokens ?? 0

        // Providers' "strict" schema modes do not enforce value-level
        // constraints (ranges, lengths, patterns), so the output still has to be
        // validated locally. `Output.object` types it as T, but that is a
        // compile-time claim only.
        const parsed = req.schema.safeParse(result.output)
        if (!parsed.success) {
          throw new LlmSchemaError(
            `model output failed schema validation: ${parsed.error.message}`,
            JSON.stringify(result.output),
          )
        }

        const entry: CacheEntry = {
          value: parsed.data,
          modelId,
          inputTokens,
          outputTokens,
          createdAt: new Date().toISOString(),
        }
        this.cache.set(cacheKey, entry)

        return {
          value: parsed.data,
          usage: { inputTokens, outputTokens, costUsd: costOf(modelId, inputTokens, outputTokens) },
          modelId,
          promptHash,
          cached: false,
        }
      } catch (error) {
        lastError = error
        // Retrying is only useful for schema violations and transient transport
        // errors; a bad API key should fail immediately rather than 3 times.
        if (error instanceof ConfigurationError) throw error
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new LlmSchemaError("model call failed", String(lastError))
  }
}

export class AiSdkEmbedding implements EmbeddingPort {
  private readonly config: Config
  readonly modelId: string
  readonly dim: number

  constructor(config: Config) {
    this.config = config
    this.modelId = config.embedding.model
    this.dim = config.embedding.dim
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const { provider, openaiApiKey } = this.config.embedding

    if (provider !== "openai") {
      // Cohere and Google are reachable through the AI SDK too, but adding them
      // without being able to test them would be speculative. Fail loudly rather
      // than silently degrading to a different vector space — mixing embedding
      // spaces is unrecoverable.
      throw new ConfigurationError(
        `embedding provider "${provider}" is not implemented yet. Use MP_EMBEDDING_PROVIDER=mock, or "openai".`,
      )
    }
    if (!openaiApiKey) {
      throw new ConfigurationError("OPENAI_API_KEY is required for the openai embedding provider")
    }

    const result = await embedMany({
      model: createOpenAI({ apiKey: openaiApiKey }).embedding(this.modelId),
      values: texts,
    })
    return result.embeddings
  }
}
