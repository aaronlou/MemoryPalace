import type { FusedItem, IsoDateTime } from "@memory-palace/shared"
import { recencyScore } from "@memory-palace/shared"
import type { Entity, Memory, ScoreBreakdown } from "../memory/types.js"

/**
 * Final ranking.
 *
 * RRF decides *retrieval* order; this decides *presentation* order by folding in
 * signals RRF cannot see (importance, recency, entity overlap, task match) plus,
 * on the smart path, an LLM relevance judgement.
 *
 * The weights are intentionally explicit and few. They are also the thing the
 * eval suite exists to tune — which is why every result carries its breakdown.
 */

/** Weights for the fast path (no LLM). Must sum to 1. */
export const FAST_WEIGHTS = {
  rrf: 0.62,
  importance: 0.14,
  recency: 0.12,
  entity: 0.12,
} as const

/** Weights for the smart path, where an LLM relevance score is available. */
export const SMART_WEIGHTS = {
  rrf: 0.45,
  rerank: 0.35,
  importance: 0.08,
  recency: 0.07,
  entity: 0.05,
} as const

/** Multiplier applied to a memory that is no longer currently valid. */
export const HISTORICAL_PENALTY = 0.6

export interface RankingInput {
  fused: FusedItem
  normalizedRrf: number
  memory: Memory
  entities: Entity[]
  referenceTime: IsoDateTime
  /** Entity ids the query is about, if any. */
  queryEntityIds: string[]
  /** Rerank relevance from the smart path, 0-1. */
  rerankRelevance?: number
  /** Task type inferred or supplied by the caller, matched against memory metadata. */
  taskType?: string
  /** True when the memory is included as history rather than as current truth. */
  historical?: boolean
}

export function rankMemory(input: RankingInput): { score: number; breakdown: ScoreBreakdown } {
  const { memory, normalizedRrf, referenceTime } = input

  const recency = recencyScore(memory.lastSeenAt ?? memory.recordedAt, referenceTime, 240)

  const entity = entityMatchScore(input.entities, input.queryEntityIds)
  const taskMatch = taskMatchScore(memory, input.taskType)

  const weights = input.rerankRelevance === undefined ? FAST_WEIGHTS : SMART_WEIGHTS
  let final =
    weights.rrf * normalizedRrf +
    weights.importance * clamp01(memory.importance) +
    weights.recency * recency +
    weights.entity * entity

  if (input.rerankRelevance !== undefined && "rerank" in weights) {
    final += weights.rerank * clamp01(input.rerankRelevance)
  }

  // Task match is a small multiplicative nudge rather than another additive
  // term: it should never be the reason a memory appears, only why it edges out
  // an equally relevant one.
  final *= 1 + 0.08 * taskMatch

  if (input.historical) final *= HISTORICAL_PENALTY

  const breakdown: ScoreBreakdown = {
    semantic: routeScore(input.fused, "semantic"),
    lexical: routeScore(input.fused, "lexical"),
    entity,
    recency,
    importance: clamp01(memory.importance),
    taskMatch,
    rrf: normalizedRrf,
    final: clamp01(final),
  }

  return { score: breakdown.final, breakdown }
}

/** Fraction of the query's entities that this memory is linked to. */
function entityMatchScore(memoryEntities: Entity[], queryEntityIds: string[]): number {
  if (queryEntityIds.length === 0) return 0
  const memoryEntityIds = new Set(memoryEntities.map((e) => e.id))
  if (memoryEntityIds.size === 0) return 0
  let hits = 0
  for (const id of queryEntityIds) if (memoryEntityIds.has(id)) hits += 1
  return hits / queryEntityIds.length
}

/** 1 when the memory's recorded task type matches the query's. */
function taskMatchScore(memory: Memory, taskType?: string): number {
  if (!taskType) return 0
  const recorded = memory.metadata?.taskType
  if (typeof recorded !== "string") return 0
  return recorded.toLowerCase() === taskType.toLowerCase() ? 1 : 0
}

function routeScore(fused: FusedItem, route: string): number | undefined {
  return fused.routes.find((r) => r.route === route)?.score
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Build the `why` string shown in results and audit output.
 *
 * This is not decoration: when a user asks "why does it think that?", the answer
 * has to be the same one the ranker used.
 */
export function explain(fused: FusedItem, memory: Memory, historical: boolean): string {
  const routes = fused.routes.map((r) => r.route).join("+")
  const bits = [`matched ${routes}`]
  if (memory.confidence >= 0.9) bits.push("high confidence")
  if (memory.importance >= 0.8) bits.push("high importance")
  if (historical) bits.push("historical (no longer current)")
  const types = memory.type
  return `${types}: ${bits.join(", ")}`
}
