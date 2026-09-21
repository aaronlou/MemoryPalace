import type { Clock, Logger } from "@memory-palace/shared"
import { NotFoundError, newId, normalizeWhitespace, ValidationError } from "@memory-palace/shared"
import { applyFormationPlan } from "./evolution/apply.js"
import { FormationPipeline } from "./formation/pipeline.js"
import type {
  AgentPolicy,
  Memory,
  MemoryFilter,
  NewObservationInput,
  Observation,
  RecallAudit,
  RecallQuery,
  RecallResult,
  WriteOutcome,
} from "./memory/types.js"
import { DEFAULT_AUTO_WRITE_TYPES, DEFAULT_CONFIRM_TYPES } from "./policies.js"
import type { EmbeddingPort, LlmPort } from "./ports/llm.js"
import type { MemorySearch, MemoryStore } from "./ports/storage.js"
import { RecallPipeline } from "./recall/pipeline.js"

export interface MemoryPalaceDeps {
  store: MemoryStore
  search: MemorySearch
  llm: LlmPort
  embeddings: EmbeddingPort
  clock: Clock
  logger: Logger
  /** Default user id for single-user deployments. */
  defaultUserId?: string
  /** Semantic similarity floor; defaults to the built-in value. */
  minSemanticSimilarity?: number
  /** Final blended-score threshold; defaults to the built-in value. */
  minScore?: number
  /** How far below the floor the smart path may probe. 0 disables. */
  semanticRescueMargin?: number
  /** Rerank relevance a below-floor (rescued) candidate needs to survive. */
  rescueMinRelevance?: number
  /** Rerank relevance below which the smart path vetoes a candidate. 0 disables. */
  minRerankRelevance?: number
  /** `auto` escalates on an uncorroborated semantic hit below this. 0 disables. */
  escalateBelowSemanticSimilarity?: number
}

/**
 * The public surface of the system.
 *
 * `remember` and `recall` are the two verbs an agent needs. Everything else is
 * an administrative operation exposing control the human is entitled to:
 * search, inspect, correct, forget, confirm.
 */
export class MemoryPalace {
  readonly store: MemoryStore
  readonly search: MemorySearch
  readonly llm: LlmPort
  readonly embeddings: EmbeddingPort
  readonly defaultUserId: string
  private readonly formation: FormationPipeline
  private readonly recallPipeline: RecallPipeline
  private readonly clock: Clock
  private readonly logger: Logger

  constructor(deps: MemoryPalaceDeps) {
    this.store = deps.store
    this.search = deps.search
    this.llm = deps.llm
    this.embeddings = deps.embeddings
    this.clock = deps.clock
    this.logger = deps.logger
    this.defaultUserId = deps.defaultUserId ?? "default-user"
    this.formation = new FormationPipeline(deps)
    this.recallPipeline = new RecallPipeline(deps)
  }

  // -------------------------------------------------------------------------
  // The two verbs
  // -------------------------------------------------------------------------

  /**
   * Ingest raw experience.
   *
   * The observation is persisted before any model call, so a provider outage or
   * a schema failure can never lose what the user said — the row stays
   * replayable once the prompt improves.
   */
  async remember(input: NewObservationInput): Promise<WriteOutcome> {
    const content = normalizeWhitespace(input.content)
    if (content === "") {
      throw new ValidationError("cannot remember empty content")
    }

    const now = this.clock.now().toISOString()
    const proposed: Observation = {
      id: newId("obs"),
      userId: input.userId,
      content,
      sourceKind: input.sourceKind ?? "user",
      agentId: input.agentId,
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
      status: "pending",
      metadata: input.metadata,
    }

    // The row that actually holds this content. Observations are deduplicated by
    // content hash, so a repeat resolves to the observation that already existed
    // — and everything downstream must use THAT row, because memories reference
    // their origin observation by id. Using the id we proposed instead wrote a
    // foreign key to a row that was never created.
    const observation = await this.store.insertObservation(proposed)

    const plan = await this.formation.plan(observation)
    const outcome = await applyFormationPlan(
      { store: this.store, embeddings: this.embeddings, clock: this.clock, logger: this.logger },
      plan,
    )

    return this.enforceWritePolicy(observation, outcome)
  }

  /** Retrieve the memories relevant to a context. */
  async recall(query: RecallQuery): Promise<RecallResult> {
    return this.recallPipeline.recall(query)
  }

  /** As `recall`, but also returns every candidate and why it was kept or dropped. */
  async recallWithAudit(query: RecallQuery): Promise<RecallAudit> {
    return this.recallPipeline.recallWithAudit(query)
  }

  // -------------------------------------------------------------------------
  // Administrative operations
  // -------------------------------------------------------------------------

  async listMemories(
    userId: string,
    filter?: MemoryFilter,
    opts?: { limit?: number; orderBy?: "recordedAt" | "importance" | "confidence" },
  ): Promise<Memory[]> {
    return this.store.listMemories(userId, filter, opts)
  }

  async getMemory(userId: string, id: string): Promise<Memory> {
    const memory = await this.store.getMemory(userId, id)
    if (!memory) throw new NotFoundError("memory", id)
    return memory
  }

  /**
   * Structured search with no model call. This is the "look it up directly"
   * path for a human browsing the web UI or an agent that already knows what
   * it wants.
   */
  async searchMemories(
    userId: string,
    opts: { query?: string; entityIds?: string[]; filter?: MemoryFilter; limit?: number },
  ): Promise<Memory[]> {
    const limit = opts.limit ?? 20
    const searchOptions = { limit, filter: opts.filter }

    const hits = []
    if (opts.query) {
      const [vector] = await this.embeddings.embed([opts.query])
      const [semantic, lexical] = await Promise.all([
        vector ? this.search.semantic(userId, vector, searchOptions) : Promise.resolve([]),
        this.search.lexical(userId, opts.query, searchOptions),
      ])
      hits.push(...semantic, ...lexical)
    } else if (opts.entityIds && opts.entityIds.length > 0) {
      hits.push(...(await this.search.byEntity(userId, opts.entityIds, searchOptions)))
    } else {
      return this.store.listMemories(userId, opts.filter, { limit })
    }

    const ids = [...new Set(hits.map((h) => h.memoryId))]
    if (ids.length === 0) return []
    return this.store.getMemories(userId, ids)
  }

  /** Correct a memory's wording. Creates a new version; history is preserved. */
  async updateMemory(
    userId: string,
    id: string,
    patch: { content?: string; summary?: string; importance?: number; confidence?: number },
  ): Promise<Memory> {
    const existing = await this.getMemory(userId, id)
    const content =
      patch.content !== undefined ? normalizeWhitespace(patch.content) : existing.content
    if (content === "") throw new ValidationError("memory content cannot be empty")

    const now = this.clock.now().toISOString()

    // A wording change is a refinement, not a state change: the fact still holds
    // over the same period, so validity is untouched and the old row is kept.
    if (content !== existing.content) {
      const revised: Memory = {
        ...existing,
        id: newId("mem"),
        content,
        summary: patch.summary ?? existing.summary,
        confidence: patch.confidence ?? existing.confidence,
        importance: patch.importance ?? existing.importance,
        recordedAt: now,
        reinforcedCount: 0,
      }
      await this.store.transaction(async (tx) => {
        await tx.insertMemory(revised)
        await tx.markSupersededByRefinement(userId, existing.id, { supersededAt: now })
        await tx.insertRelations([
          {
            id: newId("rel"),
            userId,
            fromMemoryId: revised.id,
            toMemoryId: existing.id,
            kind: "refines",
            reason: "manual correction",
            createdAt: now,
          },
        ])
      })
      return revised
    }

    await this.store.updateMemoryContent(userId, id, {
      content,
      summary: patch.summary,
      importance: patch.importance,
      confidence: patch.confidence,
    })
    return this.getMemory(userId, id)
  }

  /**
   * Retire memories.
   *
   * `archive` is the default because it is reversible and keeps the history that
   * makes this system worth having. Hard deletion exists because a local-first
   * product must be able to actually delete personal data on request.
   */
  async forgetMemories(
    userId: string,
    ids: string[],
    opts: { hard?: boolean } = {},
  ): Promise<{ archived: number; deleted: number }> {
    if (ids.length === 0) return { archived: 0, deleted: 0 }
    if (opts.hard) {
      const deleted = await this.store.deleteMemories(userId, ids)
      return { archived: 0, deleted }
    }
    await this.store.updateMemoryStatus(userId, ids, "archived")
    return { archived: ids.length, deleted: 0 }
  }

  /** List everything awaiting a decision, with the reason it is waiting. */
  async listPending(userId: string, limit = 50): Promise<Memory[]> {
    return this.store.listPending(userId, limit)
  }

  /**
   * Confirm a pending memory, promoting it to active.
   *
   * If activating it would overlap an already-active memory in the same slot,
   * that memory is superseded instead of letting the database reject the write —
   * confirming the newer statement IS the decision to replace the older one.
   */
  async confirmMemory(userId: string, id: string): Promise<Memory> {
    const memory = await this.getMemory(userId, id)
    const now = this.clock.now().toISOString()

    await this.store.transaction(async (tx) => {
      if (memory.slotKey) {
        const overlapping = await tx.findOverlappingActive(
          userId,
          memory.slotKey,
          memory.validFrom ?? now,
          memory.validUntil,
          [memory.id],
        )
        for (const other of overlapping) {
          await tx.supersedeMemory(userId, other.id, {
            validUntil: memory.validFrom ?? now,
            supersededAt: now,
            status: "superseded",
          })
          await tx.insertRelations([
            {
              id: newId("rel"),
              userId,
              fromMemoryId: memory.id,
              toMemoryId: other.id,
              kind: "supersedes",
              reason: "confirmed by user",
              createdAt: now,
            },
          ])
        }
      }
      await tx.updateMemoryStatus(userId, [id], "active")
    })

    return this.getMemory(userId, id)
  }

  /** Reject a pending memory: archived, so it stops blocking recall. */
  async rejectMemory(userId: string, id: string, reason?: string): Promise<Memory> {
    const memory = await this.getMemory(userId, id)
    await this.store.updateMemoryStatus(userId, [id], "archived")
    this.logger.info("memory rejected", { memoryId: id, reason })
    return { ...memory, status: "archived" }
  }

  /** The full supersede/refine history of a memory, oldest first. */
  async getHistory(userId: string, id: string): Promise<Memory[]> {
    await this.getMemory(userId, id)
    return this.store.supersedesChain(userId, id)
  }

  // -------------------------------------------------------------------------
  // Agent write policy
  // -------------------------------------------------------------------------

  async getAgentPolicy(userId: string, agentId: string): Promise<AgentPolicy> {
    const existing = await this.store.getAgentPolicy(userId, agentId)
    if (existing) return existing
    return {
      agentId,
      userId,
      allowedTypes: [...DEFAULT_AUTO_WRITE_TYPES],
      requireConfirmationFor: [...DEFAULT_CONFIRM_TYPES],
      canWrite: true,
      createdAt: this.clock.now().toISOString(),
    }
  }

  async setAgentPolicy(policy: AgentPolicy): Promise<void> {
    await this.store.upsertAgentPolicy(policy)
  }

  /**
   * Apply the writing agent's policy to what formation produced.
   *
   * Enforcement happens after formation rather than before, because the policy
   * keys off the *memory type*, which is only known once extraction has run.
   * Anything not allowed auto-commits becomes `pending`.
   */
  private async enforceWritePolicy(
    observation: Observation,
    outcome: WriteOutcome,
  ): Promise<WriteOutcome> {
    if (!observation.agentId || outcome.memories.length === 0) return outcome

    const policy = await this.getAgentPolicy(observation.userId, observation.agentId)
    if (!policy.canWrite) {
      // Should have been rejected earlier; the observation is still stored so
      // nothing is lost, but no memory may be created from it.
      await this.store.updateMemoryStatus(
        observation.userId,
        outcome.memories.map((m) => m.id),
        "pending",
      )
      return {
        ...outcome,
        memories: outcome.memories.map((m) => ({ ...m, status: "pending" as const })),
      }
    }

    const toPending = outcome.memories.filter(
      (m) =>
        !policy.allowedTypes.includes(m.type) || policy.requireConfirmationFor.includes(m.type),
    )
    if (toPending.length === 0) return outcome

    await this.store.updateMemoryStatus(
      observation.userId,
      toPending.map((m) => m.id),
      "pending",
    )
    const pendingIds = new Set(toPending.map((m) => m.id))
    return {
      ...outcome,
      memories: outcome.memories.map((m) =>
        pendingIds.has(m.id) ? { ...m, status: "pending" as const } : m,
      ),
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  async stats(userId: string): Promise<{
    active: number
    pending: number
    archived: number
    superseded: number
    observations: number
    entities: number
    llm: string
    embedding: string
    embeddingDim: number
  }> {
    const [active, pending, archived, superseded, observations, entities] = await Promise.all([
      this.store.countMemories(userId, { statuses: ["active"] }),
      this.store.countMemories(userId, { statuses: ["pending"] }),
      this.store.countMemories(userId, { statuses: ["archived"] }),
      this.store.countMemories(userId, { statuses: ["superseded"] }),
      this.store.countObservations(userId),
      this.store.countEntities(userId),
    ])

    return {
      active,
      pending,
      archived,
      superseded,
      observations,
      entities,
      llm: this.llm.defaultModelId,
      embedding: this.embeddings.modelId,
      embeddingDim: this.embeddings.dim,
    }
  }
}
