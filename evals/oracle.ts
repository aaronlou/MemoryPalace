import type {
  EmbeddingPort,
  GenerateObjectRequest,
  GenerateObjectResult,
  LlmPort,
} from "@memory-palace/core"
import type { DecisionKind, MemoryType } from "./datasets/index.js"

/**
 * An LLM that always returns the dataset's expected answer.
 *
 * This exists to validate the harness, not to evaluate the system. If the
 * metrics do not read 1.0 when the model is perfect, then a real score of "F1 =
 * 0.63" is measuring the harness's bugs rather than the pipeline's quality.
 *
 * It is also the "empty implementation" counterpart's mirror: `NullLlm` returns
 * nothing at all and must score 0.0.
 */

export class OracleLlm implements LlmPort {
  readonly defaultModelId = "oracle"
  private candidates: Array<{ type: MemoryType; content: string }> = []
  private decision: DecisionKind | null = null

  /** The memories the extractor should return for the next observation. */
  setExtractionCandidates(candidates: Array<{ type: MemoryType; content: string }>): void {
    this.candidates = candidates
  }

  /** The adjudication verdict for the next observation, or null for "no adjudication". */
  setDecision(decision: DecisionKind | null): void {
    this.decision = decision
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    const value = this.answer(req)
    return {
      value: req.schema.parse(value) as T,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      modelId: this.defaultModelId,
      promptHash: "oracle",
      cached: false,
    }
  }

  private answer(req: GenerateObjectRequest<unknown>): unknown {
    switch (req.schemaName) {
      case "MemoryExtraction":
        return {
          candidates: this.candidates.map((c) => ({
            type: c.type,
            content: c.content,
            summary: null,
            entities: [],
            confidence: 0.95,
            importance: 0.8,
            validFrom: null,
            reasoning: "oracle",
          })),
        }
      case "MemoryAdjudication": {
        const decision = this.decision
        if (decision === null) {
          return {
            decision: "NEW",
            targetMemoryIds: [],
            mergedContent: null,
            effectiveFrom: null,
            confidenceDelta: 0,
            reason: "oracle",
          }
        }
        // Target every existing memory in the prompt: the harness checks which
        // decision was taken, and the pipeline narrows ids to those present.
        const ids = extractIds(req.prompt)
        return {
          decision,
          targetMemoryIds: decision === "NEW" ? [] : ids,
          mergedContent: decision === "REFINE" ? (this.candidates[0]?.content ?? null) : null,
          effectiveFrom: null,
          confidenceDelta: decision === "DUPLICATE" ? 0.03 : 0,
          reason: `oracle:${decision}`,
        }
      }
      case "QueryUnderstanding":
        return {
          entities: [],
          taskType: null,
          keywords: [],
          intent: "general",
          timeRangeFrom: null,
          timeRangeTo: null,
        }
      case "MemoryRerank":
        return { rankings: [] }
      default:
        throw new Error(`oracle cannot answer schema ${req.schemaName}`)
    }
  }
}

/** Extract `id=xxx` tokens from an adjudication prompt. */
function extractIds(prompt: string): string[] {
  const ids: string[] = []
  const re = /id=(\S+)/g
  let m = re.exec(prompt)
  while (m !== null) {
    ids.push(m[1]!)
    m = re.exec(prompt)
  }
  return ids
}

/** An LLM that extracts nothing and decides nothing. Must score 0.0. */
export class NullLlm implements LlmPort {
  readonly defaultModelId = "null"

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    const empty =
      req.schemaName === "MemoryExtraction"
        ? { candidates: [] }
        : req.schemaName === "MemoryAdjudication"
          ? {
              decision: "NEW",
              targetMemoryIds: [],
              mergedContent: null,
              effectiveFrom: null,
              confidenceDelta: 0,
              reason: "null",
            }
          : req.schemaName === "QueryUnderstanding"
            ? {
                entities: [],
                taskType: null,
                keywords: [],
                intent: "general",
                timeRangeFrom: null,
                timeRangeTo: null,
              }
            : { rankings: [] }
    return {
      value: req.schema.parse(empty) as T,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      modelId: this.defaultModelId,
      promptHash: "null",
      cached: false,
    }
  }
}

/** Deterministic zero embedding, so the vector route is inert but valid. */
export class NullEmbedding implements EmbeddingPort {
  readonly dim: number
  readonly modelId = "null-embedding"

  constructor(dim: number) {
    this.dim = dim
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array<number>(this.dim).fill(0))
  }
}
