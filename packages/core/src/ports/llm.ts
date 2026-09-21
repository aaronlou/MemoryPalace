import type { ZodType } from "zod"

/**
 * Ports for model access. Defined in the domain so that `packages/core` never
 * imports a vendor SDK or the Vercel AI SDK (which is on major v7 and renames
 * things roughly every six months).
 */

export interface ModelRef {
  provider?: string
  model: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Carried through the port so "what did this cost?" is answerable per run. */
  costUsd: number
}

export interface GenerateObjectRequest<T> {
  schema: ZodType<T>
  /** Name shown to the provider; also part of the cache key. */
  schemaName: string
  instructions?: string
  prompt: string
  model?: string
  temperature?: number
  maxOutputTokens?: number
  /**
   * Stable key for the response cache. Implementations MUST cache on this so
   * that running the eval suite repeatedly does not re-bill every call — that
   * is the difference between an eval suite you run and one you avoid.
   */
  cacheKey?: string
}

export interface GenerateObjectResult<T> {
  value: T
  usage: TokenUsage
  modelId: string
  promptHash: string
  cached: boolean
}

export interface LlmPort {
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>>
  /** Identifier of the model used when a request does not name one. */
  readonly defaultModelId: string
}

export interface EmbeddingPort {
  /** Returns one vector per input, in the same order. */
  embed(texts: string[]): Promise<number[][]>
  readonly dim: number
  readonly modelId: string
}

/** Thrown by an LlmPort implementation when output fails schema validation. */
export class LlmSchemaError extends Error {
  readonly raw: string
  constructor(message: string, raw: string) {
    super(message)
    this.name = "LlmSchemaError"
    this.raw = raw
  }
}
