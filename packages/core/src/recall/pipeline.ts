import type { Clock, FusedItem, Logger } from "@memory-palace/shared"
import { estimateTokens, fuseAndNormalize } from "@memory-palace/shared"
import { instructionsFor, queryUnderstandingPrompt, rerankPrompt } from "../formation/prompt.js"
import { QueryUnderstandingOutput, RerankOutput } from "../memory/decisions.js"
import type {
  Entity,
  Memory,
  MemoryStatus,
  RecallQuery,
  RecallResult,
  ScoredMemory,
} from "../memory/types.js"
import { RECALL_DEFAULTS } from "../policies.js"
import type { EmbeddingPort, LlmPort } from "../ports/llm.js"
import type { MemorySearch, MemoryStore, SearchHit } from "../ports/storage.js"
import { assembleContext, toJsonPayload } from "./assembly.js"
import { explain, rankMemory } from "./ranking.js"

export interface RecallDeps {
  store: MemoryStore
  search: MemorySearch
  llm: LlmPort
  embeddings: EmbeddingPort
  clock: Clock
  logger: Logger
  /**
   * Override for the semantic similarity floor. Supplied by the runtime from
   * configuration because the correct value depends on the embedding model.
   */
  minSemanticSimilarity?: number
  /** Minimum blended score for a memory to survive ranking. */
  minScore?: number
  /** How far below the floor the smart path may probe. 0 disables. */
  semanticRescueMargin?: number
  /** Rerank relevance a below-floor (rescued) candidate needs to survive. */
  rescueMinRelevance?: number
}

export interface RecallAuditEntry {
  memoryId: string
  score: number
  kept: boolean
  reason: string
}

/** A fused candidate carrying its normalised RRF score. */
type FusedScored = FusedItem & { normalized: number }

/** How many top candidates the smart path sends to the LLM for reranking. */
const RERANK_CANDIDATES = 15

/**
 * Two-tier recall.
 *
 * Agents call recall often, so latency is a product feature, not a benchmark.
 * The fast path is pure SQL + vector math with no model call; the smart path
 * adds query understanding and LLM reranking when the fast path is not
 * confident. `auto` starts fast and escalates only when it needs to.
 */
export class RecallPipeline {
  private readonly store: MemoryStore
  private readonly search: MemorySearch
  private readonly llm: LlmPort
  private readonly embeddings: EmbeddingPort
  private readonly clock: Clock
  private readonly logger: Logger
  private readonly minSemanticSimilarity: number
  private readonly minScore: number
  private readonly semanticRescueMargin: number
  private readonly rescueMinRelevance: number

  constructor(deps: RecallDeps) {
    this.store = deps.store
    this.search = deps.search
    this.llm = deps.llm
    this.embeddings = deps.embeddings
    this.clock = deps.clock
    this.logger = deps.logger
    this.minSemanticSimilarity = deps.minSemanticSimilarity ?? RECALL_DEFAULTS.minSemanticSimilarity
    this.minScore = deps.minScore ?? RECALL_DEFAULTS.minScore
    this.semanticRescueMargin = deps.semanticRescueMargin ?? RECALL_DEFAULTS.semanticRescueMargin
    this.rescueMinRelevance = deps.rescueMinRelevance ?? RECALL_DEFAULTS.rescueMinRelevance
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    return (await this.recallWithAudit(query)).result
  }

  async recallWithAudit(
    query: RecallQuery,
  ): Promise<{ result: RecallResult; considered: RecallAuditEntry[] }> {
    const mode = query.mode ?? "auto"
    if (mode === "smart") return this.runSmart(query, false)

    const fast = await this.runFast(query)
    if (mode === "fast") return fast

    // auto: escalate only when the fast path came back weak. Returning nothing
    // is itself a reason to escalate — the answer may be phrased differently
    // from how the memory was stored.
    const top = fast.result.memories[0]?.score ?? 0
    if (fast.result.memories.length > 0 && top >= RECALL_DEFAULTS.escalateBelowScore) {
      return fast
    }
    return this.runSmart(query, true, fast.considered)
  }

  // -------------------------------------------------------------------------
  // Fast path — no LLM
  // -------------------------------------------------------------------------

  private async runFast(
    query: RecallQuery,
  ): Promise<{ result: RecallResult; considered: RecallAuditEntry[] }> {
    const started = Date.now()
    const referenceTime = this.clock.now().toISOString()
    const asOf = query.asOf ?? referenceTime
    // Only apply the transaction-time filter when the caller actually asked
    // "what did we believe THEN". Defaulting it to now would exclude every
    // superseded version, which silently breaks "what was true in 2026?" — the
    // single most important thing a versioned store is for.
    const believedAt = query.believedAt
    const includeHistory = query.includeHistory ?? false
    const statuses = includeHistory ? (["active", "superseded"] as const) : (["active"] as const)

    const options = {
      limit: RECALL_DEFAULTS.fastLimit,
      asOf,
      believedAt,
      statuses: [...statuses],
      filter: {},
    }

    // The semantic route needs a floor because an ANN search always returns
    // `limit` rows. The lexical route does not: its gate is the shared
    // discriminative-term check in SQL (ADR-0005), so a hit already means the
    // query and the memory are about the same thing.
    const semanticOpts = { ...options, minScore: this.minSemanticSimilarity }
    const lexicalOpts = options

    const [vector] = await this.embeddings.embed([query.query])
    const [semantic, lexical, recent, important] = await Promise.all([
      vector ? this.search.semantic(query.userId, vector, semanticOpts) : Promise.resolve([]),
      this.search.lexical(query.userId, query.query, lexicalOpts),
      this.search.recent(query.userId, { ...options, limit: RECALL_DEFAULTS.limit }),
      this.search.important(query.userId, { ...options, limit: RECALL_DEFAULTS.limit }),
    ])

    return this.finish({
      query,
      started,
      referenceTime,
      asOf,
      believedAt,
      includeHistory,
      routes: [
        { route: "semantic", items: semantic },
        { route: "lexical", items: lexical },
        { route: "recent", items: recent },
        { route: "important", items: important },
      ],
      queryEntityIds: [],
      taskType: query.taskType,
      // No `rerank` key: its absence is what selects the fast ranking weights.
      mode: "fast",
      escalated: false,
    })
  }

  // -------------------------------------------------------------------------
  // Smart path — query understanding + LLM rerank
  // -------------------------------------------------------------------------

  private async runSmart(
    query: RecallQuery,
    escalated: boolean,
    priorConsidered?: RecallAuditEntry[],
  ): Promise<{ result: RecallResult; considered: RecallAuditEntry[] }> {
    const started = Date.now()
    const referenceTime = this.clock.now().toISOString()

    let understanding: QueryUnderstandingOutput | null = null
    try {
      const result = await this.llm.generateObject({
        schema: QueryUnderstandingOutput,
        schemaName: "QueryUnderstanding",
        instructions: instructionsFor("query"),
        prompt: queryUnderstandingPrompt(query.query, query.taskType),
        temperature: 0,
        cacheKey: `query:${query.query}:${query.taskType ?? ""}`,
      })
      understanding = result.value
    } catch (error) {
      // Fall through to the fast-path strategy. A failed understanding step must
      // degrade recall quality, never fail the query outright.
      this.logger.warn("query understanding failed; using fast-path strategy", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    const taskType = understanding?.taskType ?? query.taskType
    const asOf = query.asOf ?? understanding?.timeRangeFrom ?? referenceTime
    const believedAt = query.believedAt
    const includeHistory = (query.includeHistory ?? false) || understanding?.intent === "historical"
    const statuses: MemoryStatus[] = includeHistory ? ["active", "superseded"] : ["active"]

    // Resolve entities named in the query, plus any the caller supplied.
    const entityNames = [...(query.entities ?? []), ...(understanding?.entities ?? [])]
    const entities =
      entityNames.length > 0 ? await this.store.findEntitiesByNames(query.userId, entityNames) : []
    const queryEntityIds = entities.map((e) => e.id)

    const options = {
      limit: RECALL_DEFAULTS.smartLimit,
      asOf,
      believedAt,
      statuses,
      filter: {},
    }

    const semanticOpts = { ...options, minScore: this.semanticProbeFloor() }
    const lexicalOpts = options

    const [vector] = await this.embeddings.embed([query.query])
    const [semantic, lexical, byEntity, recent, important] = await Promise.all([
      vector ? this.search.semantic(query.userId, vector, semanticOpts) : Promise.resolve([]),
      this.search.lexical(query.userId, query.query, lexicalOpts),
      queryEntityIds.length > 0
        ? this.search.byEntity(query.userId, queryEntityIds, options)
        : Promise.resolve([]),
      this.search.recent(query.userId, { ...options, limit: RECALL_DEFAULTS.limit }),
      this.search.important(query.userId, { ...options, limit: RECALL_DEFAULTS.limit }),
    ])

    // Candidates that only entered because the smart path probed below the
    // floor. Cosine alone is not evidence for these — the reranker must
    // confirm them before they may be recalled.
    //
    // A memory that ALSO matched the lexical or entity route has independent
    // above-floor evidence of its own, so it is not waiting to be rescued and
    // keeps its fast-path treatment.
    const evidenced = new Set([...lexical, ...byEntity].map((h) => h.memoryId))
    const rescued = new Set(
      semantic
        .filter((h) => h.score < this.minSemanticSimilarity && !evidenced.has(h.memoryId))
        .map((h) => h.memoryId),
    )

    return this.finish({
      query,
      started,
      referenceTime,
      asOf,
      believedAt,
      includeHistory,
      routes: [
        { route: "semantic", items: semantic },
        { route: "lexical", items: lexical },
        { route: "entity", items: byEntity },
        { route: "recent", items: recent },
        { route: "important", items: important },
      ],
      queryEntityIds,
      taskType,
      rerank: { understanding },
      mode: "smart",
      escalated,
      priorConsidered,
      rescuedIds: rescued,
    })
  }

  /**
   * The floor the smart path uses for candidate GENERATION: the configured
   * floor minus the rescue margin.
   *
   * Kept separate from `minSemanticSimilarity`, which remains the threshold
   * for trusting a hit on cosine alone. The gap between the two is populated
   * exclusively by candidates the reranker gets to vouch for (or veto).
   */
  private semanticProbeFloor(): number {
    return Math.max(0, this.minSemanticSimilarity - this.semanticRescueMargin)
  }

  // -------------------------------------------------------------------------
  // Shared finishing: fuse -> filter -> rank -> rerank -> assemble
  // -------------------------------------------------------------------------

  private async finish(input: {
    query: RecallQuery
    started: number
    referenceTime: string
    asOf: string
    believedAt?: string
    includeHistory: boolean
    routes: Array<{ route: string; items: SearchHit[] }>
    queryEntityIds: string[]
    taskType?: string
    rerank?: { understanding: QueryUnderstandingOutput | null }
    mode: "fast" | "smart"
    escalated: boolean
    priorConsidered?: RecallAuditEntry[]
    /** Below-floor semantic candidates; only recallable if the reranker confirms. */
    rescuedIds?: Set<string>
  }): Promise<{ result: RecallResult; considered: RecallAuditEntry[] }> {
    const { query } = input
    const limit = query.limit ?? RECALL_DEFAULTS.limit
    const tokenBudget = query.tokenBudget ?? RECALL_DEFAULTS.tokenBudget

    const lists = input.routes.map((r) => ({
      route: r.route,
      items: r.items.map((h) => ({ id: h.memoryId, score: h.score })),
    }))
    const allFused = fuseAndNormalize(lists, RECALL_DEFAULTS.rrfK)

    // A memory may only be recalled if a query-conditional route actually
    // matched it. `recent` and `important` match everything, so letting them
    // introduce candidates would make "no relevant memories" unreachable.
    const qualifying = new Set<string>(RECALL_DEFAULTS.qualifyingRoutes as readonly string[])
    const fused = allFused.filter((item) => item.routes.some((r) => qualifying.has(r.route)))
    const candidatesConsidered = allFused.length

    const considered: RecallAuditEntry[] = []
    if (fused.length === 0) {
      return this.emptyResult(input, candidatesConsidered, considered)
    }

    const memories = await this.store.getMemories(
      query.userId,
      fused.map((f) => f.id),
    )
    const byId = new Map(memories.map((m) => [m.id, m]))
    const entitiesByMemory = await this.store.entitiesForMemories(
      query.userId,
      memories.map((m) => m.id),
    )

    // --- filter: status, validity, conflicts ---------------------------------
    let conflictsFiltered = 0
    const usable: Array<{ fused: FusedScored; memory: Memory; historical: boolean }> = []

    for (const item of fused) {
      const memory = byId.get(item.id)
      if (!memory) {
        considered.push({
          memoryId: item.id,
          score: item.normalized,
          kept: false,
          reason: "not_found",
        })
        continue
      }
      if (memory.status === "pending") {
        // Awaiting confirmation — either a conflict or an agent write policy.
        // Surfacing these as fact would be worse than omitting them; they live
        // in the confirmation queue instead.
        conflictsFiltered += 1
        considered.push({
          memoryId: memory.id,
          score: item.normalized,
          kept: false,
          reason: "pending_confirmation",
        })
        continue
      }
      const historical = memory.status !== "active"
      if (historical && !input.includeHistory) {
        considered.push({
          memoryId: memory.id,
          score: item.normalized,
          kept: false,
          reason: "superseded",
        })
        continue
      }
      usable.push({ fused: item, memory, historical })
    }

    // --- rank -----------------------------------------------------------------
    let rerankScores: Map<string, number> | undefined
    if (input.rerank !== undefined && usable.length > 0) {
      rerankScores = await this.tryRerank(query.query, usable, query.userId)
    }

    const scored: ScoredMemory[] = usable.map(({ fused: item, memory, historical }) => {
      const rerankRelevance = rerankScores?.get(memory.id)
      const { score, breakdown } = rankMemory({
        fused: item,
        normalizedRrf: item.normalized,
        memory,
        entities: entitiesByMemory.get(memory.id) ?? [],
        referenceTime: input.referenceTime,
        queryEntityIds: input.queryEntityIds,
        rerankRelevance,
        taskType: input.taskType,
        historical,
      })
      return {
        memory,
        score,
        breakdown,
        routes: item.routes,
        why: explain(item, memory, historical),
      }
    })

    scored.sort((a, b) => b.score - a.score)

    // --- threshold: returning nothing is a valid, correct answer --------------
    // One decision function for both the filter and the audit trail: an audit
    // entry that disagreed with the filter would be worse than no audit at all.
    const verdict = (s: ScoredMemory): { kept: boolean; reason: string } => {
      if (s.score < this.minScore) return { kept: false, reason: "below_min_score" }
      if (input.rescuedIds?.has(s.memory.id)) {
        // No above-floor evidence of its own, so cosine cannot speak for it —
        // only the reranker can. If reranking failed entirely, or the candidate
        // never made the shortlist, the safe answer is to drop it and behave
        // like the fast path would have.
        const confirmed = (rerankScores?.get(s.memory.id) ?? 0) >= this.rescueMinRelevance
        return confirmed
          ? { kept: true, reason: "kept_rescued_confirmed" }
          : { kept: false, reason: "rescued_unconfirmed" }
      }
      return { kept: true, reason: "kept" }
    }

    const kept = scored.filter((s) => verdict(s).kept)
    for (const s of scored) {
      considered.push({ memoryId: s.memory.id, score: s.score, ...verdict(s) })
    }

    const top = kept.slice(0, limit)
    const asJson = query.format === "json"
    const assembled = assembleContext({
      query: query.query,
      scored: top,
      tokenBudget,
      referenceTime: input.referenceTime,
      includePreamble: !asJson,
    })

    const result: RecallResult = {
      userId: query.userId,
      query: query.query,
      memories: assembled.included,
      // `text` renders markdown for a prompt; `json` renders a compact payload
      // for a program. Both are produced from the same ranked list, so they can
      // never disagree about what was recalled.
      context: asJson
        ? JSON.stringify(toJsonPayload(assembled.included), null, 2)
        : assembled.context,
      mode: input.mode,
      escalated: input.escalated,
      diagnostics: {
        candidatesConsidered,
        routesUsed: input.routes.filter((r) => r.items.length > 0).map((r) => r.route),
        conflictsFiltered,
        latencyMs: Date.now() - input.started,
        estimatedTokens: assembled.estimatedTokens,
        returnedEmpty: assembled.included.length === 0,
      },
    }

    return { result, considered: [...(input.priorConsidered ?? []), ...considered] }
  }

  private emptyResult(
    input: {
      query: RecallQuery
      started: number
      routes: Array<{ route: string; items: SearchHit[] }>
      mode: "fast" | "smart"
      escalated: boolean
      referenceTime: string
    },
    candidatesConsidered: number,
    considered: RecallAuditEntry[],
  ): { result: RecallResult; considered: RecallAuditEntry[] } {
    return {
      result: {
        userId: input.query.userId,
        query: input.query.query,
        memories: [],
        context: "",
        mode: input.mode,
        escalated: input.escalated,
        diagnostics: {
          candidatesConsidered,
          routesUsed: [],
          conflictsFiltered: 0,
          latencyMs: Date.now() - input.started,
          estimatedTokens: 0,
          returnedEmpty: true,
        },
      },
      considered,
    }
  }

  /**
   * Ask the model to re-score the shortlist. A failure here is non-fatal: the
   * heuristic ranking is already reasonable, so we log and keep it.
   */
  private async tryRerank(
    query: string,
    usable: Array<{ fused: FusedScored; memory: Memory; historical: boolean }>,
    userId: string,
  ): Promise<Map<string, number> | undefined> {
    const shortlist = [...usable]
      .sort((a, b) => b.fused.normalized - a.fused.normalized)
      .slice(0, RERANK_CANDIDATES)

    try {
      const result = await this.llm.generateObject({
        schema: RerankOutput,
        schemaName: "MemoryRerank",
        instructions: instructionsFor("rerank"),
        prompt: rerankPrompt(
          query,
          shortlist.map((u) => ({ memory: u.memory, heuristicScore: u.fused.normalized })),
        ),
        temperature: 0,
        cacheKey: `rerank:${userId}:${query}:${shortlist.map((u) => u.memory.id).join(",")}`,
      })
      const scores = new Map<string, number>()
      const allowed = new Set(shortlist.map((u) => u.memory.id))
      for (const ranking of result.value.rankings) {
        // Ignore ids the model invented.
        if (allowed.has(ranking.memoryId)) scores.set(ranking.memoryId, ranking.relevance)
      }
      return scores
    } catch (error) {
      this.logger.warn("rerank failed; keeping heuristic order", {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }
}

/** Token count of the rendered context, for budget assertions in tests. */
export function contextTokens(context: string): number {
  return estimateTokens(context)
}

export type { Entity }
export { toJsonPayload }
