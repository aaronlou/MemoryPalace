import type { EmbeddingPort } from "@memory-palace/core"
import { ConfigurationError, LlmError } from "@memory-palace/shared"

/**
 * Embeddings from a local Ollama server.
 *
 * The privacy-first option: memory text never leaves the machine. Everything
 * this project stores is personal, so for many people that is the deciding
 * factor rather than embedding quality.
 *
 * Implemented as a plain HTTP call rather than through an SDK. Ollama's API is
 * two endpoints and adding a dependency to wrap them would only add something
 * else to keep up to date.
 *
 * Latency note: a local embedding call costs tens to low hundreds of
 * milliseconds, which is not free on the recall fast path. It is still far
 * cheaper than a round trip to a hosted provider, but the "no model call" claim
 * for the fast path becomes "no *generation* call".
 */

export interface OllamaEmbeddingOptions {
  /** Model name as Ollama knows it, e.g. `bge-m3`. */
  model: string
  /** Expected vector width. Must match the database column. */
  dim: number
  /** Defaults to `http://127.0.0.1:11434`. */
  baseUrl?: string
  /** Per-request timeout. Local inference on CPU can be slow on first load. */
  timeoutMs?: number
}

interface OllamaEmbedResponse {
  embeddings?: number[][]
  embedding?: number[]
  error?: string
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434"
const DEFAULT_TIMEOUT_MS = 120_000
/** Width of the default model, quoted in error messages. */
const DEFAULT_DIM = 1024

export class OllamaEmbedding implements EmbeddingPort {
  readonly modelId: string
  readonly dim: number

  private readonly baseUrl: string
  private readonly timeoutMs: number
  /** Set once the server's actual output width has been observed. */
  private observedDim: number | undefined
  /**
   * A confirmed width mismatch.
   *
   * Remembered so every subsequent call fails too. Recording the observed width
   * and moving on would let a misconfiguration "heal" after one call and then
   * feed wrong-length vectors to the database, where the error is far less
   * intelligible.
   */
  private dimensionError: Error | undefined

  constructor(options: OllamaEmbeddingOptions) {
    this.modelId = options.model
    this.dim = options.dim
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const payload = JSON.stringify({ model: this.modelId, input: texts })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      if (controller.signal.aborted) {
        throw new LlmError(
          `Ollama did not respond within ${this.timeoutMs}ms while embedding with "${this.modelId}"`,
        )
      }
      throw new ConfigurationError(
        `cannot reach Ollama at ${this.baseUrl}. Start it with \`ollama serve\`. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      )
    }
    clearTimeout(timer)

    const body = (await response.json().catch(() => ({}))) as OllamaEmbedResponse

    if (!response.ok) {
      const detail = body.error ?? `HTTP ${response.status}`
      // The most common first-run problem by far is simply not having pulled it.
      if (/not found|no such model|try pulling/i.test(detail)) {
        throw new ConfigurationError(
          `Ollama does not have the model "${this.modelId}". Pull it with: ollama pull ${this.modelId}`,
        )
      }
      throw new LlmError(`Ollama embedding failed: ${detail}`)
    }

    // `/api/embed` returns `embeddings`; tolerate the older single-vector shape
    // so an older server does not fail for no good reason.
    const vectors = body.embeddings ?? (body.embedding ? [body.embedding] : undefined)
    if (!vectors || vectors.length !== texts.length) {
      throw new LlmError(
        `Ollama returned ${vectors?.length ?? 0} embeddings for ${texts.length} inputs`,
      )
    }

    this.assertDimension(vectors[0]!)
    return vectors
  }

  /**
   * Fail loudly when the model's width does not match the database column.
   *
   * pgvector needs a declared width to index, so `memory_embeddings.embedding`
   * is fixed and a mismatch cannot be worked around at query time. Catching it
   * here — on the first embedding, with an actionable message — is much better
   * than a driver error on the first recall.
   */
  private assertDimension(vector: number[]): void {
    if (this.dimensionError) throw this.dimensionError
    if (this.observedDim !== undefined) return
    this.observedDim = vector.length
    if (vector.length !== this.dim) {
      this.dimensionError = new ConfigurationError(
        `Ollama model "${this.modelId}" produces ${vector.length}-dimensional vectors but ` +
          `Memory Palace is configured for ${this.dim} (MP_EMBEDDING_DIM).\n` +
          `Fix it with:\n` +
          `  pnpm embedding:dim ${vector.length}\n` +
          `  pnpm embedding:reembed\n` +
          `or choose a model with ${this.dim} dimensions (bge-m3 is ${DEFAULT_DIM}).`,
      )
      throw this.dimensionError
    }
  }

  /**
   * Ask the server which models are available. Used by the doctor command so a
   * misconfiguration is diagnosable before the first write.
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return []
      const body = (await response.json()) as { models?: Array<{ name: string }> }
      return (body.models ?? []).map((m) => m.name)
    } catch {
      return []
    }
  }
}
