import { createHash } from "node:crypto"
import type {
  AgentPolicy,
  EmbeddingUpsert,
  Entity,
  ExtractionRun,
  Memory,
  MemoryEntityLink,
  MemoryFilter,
  MemoryRelation,
  MemoryStatus,
  MemoryStore,
  Observation,
  ObservationStatus,
  RelationKind,
} from "@memory-palace/core"
import type { IsoDateTime } from "@memory-palace/shared"
import { ConflictError } from "@memory-palace/shared"
import type pg from "pg"
import type { PgDatabase } from "./client.js"
import { toNumber, toVectorLiteral } from "./client.js"

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * Postgres implementation of the storage port.
 *
 * One class serves both the pool-backed and transaction-backed case: the only
 * difference is which connection the queries run on. `transaction()` hands the
 * callback a store bound to a single client, so every write inside it
 * participates in the same transaction without the domain layer knowing.
 */
export class PgMemoryStore implements MemoryStore {
  private readonly db: PgDatabase
  private readonly client: pg.PoolClient | undefined

  constructor(db: PgDatabase, client?: pg.PoolClient) {
    this.db = db
    this.client = client
  }

  private async q<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<R[]> {
    if (this.client) {
      const result = await this.client.query<R>(text, params as never[])
      return result.rows
    }
    const result = await this.db.query<R>(text, params)
    return result.rows
  }

  async ping(): Promise<void> {
    await this.q("SELECT 1")
  }

  async close(): Promise<void> {
    // Only the pool owner closes the pool; transaction-bound stores must not.
    if (!this.client) await this.db.close()
  }

  async transaction<T>(fn: (tx: MemoryStore) => Promise<T>): Promise<T> {
    // Nested transaction: join the outer one instead of opening a second
    // connection, which would deadlock against the outer transaction's locks.
    if (this.client) return fn(this)
    return this.db.withTransaction(async (client) => fn(new PgMemoryStore(this.db, client)))
  }

  // -------------------------------------------------------------------------
  // Observations
  // -------------------------------------------------------------------------

  /**
   * Record an observation, deduplicated by content hash.
   *
   * Returns the row that now holds this content: the freshly inserted one, or the
   * existing one when the same text was ingested before. That return value is the
   * point, not a convenience. A memory references the observation it came from
   * (`origin_observation_id`), so a caller that keeps using the id it *tried* to
   * insert ends up writing a foreign key that points at a row which was never
   * created — measured, by running `pnpm demo` twice in a row: the second run
   * deduplicates the repeat text, the repeat is then adjudicated REFINE rather
   * than DUPLICATE, and the insert fails the foreign key, losing the write.
   *
   * `DO UPDATE` rather than `DO NOTHING` only because RETURNING needs something to
   * return on conflict; the assignment is a no-op, so the original record is
   * untouched — a repeat is not new evidence about when the user said it.
   */
  async insertObservation(observation: Observation): Promise<Observation> {
    const rows = await this.q<ObservationRow>(
      `INSERT INTO observations
         (id, user_id, content, content_hash, source_kind, agent_id, occurred_at, created_at, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, content_hash) DO UPDATE SET content = observations.content
       RETURNING *`,
      [
        observation.id,
        observation.userId,
        observation.content,
        hashContent(observation.content),
        observation.sourceKind,
        observation.agentId ?? null,
        observation.occurredAt,
        observation.createdAt,
        observation.status,
        observation.metadata ? JSON.stringify(observation.metadata) : null,
      ],
    )
    const row = rows[0]
    if (!row) {
      // Unreachable with RETURNING, but a silent `undefined` here would produce a
      // memory with no traceable origin, which is worse than a loud failure.
      throw new Error("insertObservation inserted nothing and matched nothing")
    }
    return toObservation(row)
  }

  async getObservation(userId: string, id: string): Promise<Observation | null> {
    const rows = await this.q<ObservationRow>(
      "SELECT * FROM observations WHERE user_id = $1 AND id = $2",
      [userId, id],
    )
    const row = rows[0]
    return row ? toObservation(row) : null
  }

  async findObservationByHash(userId: string, contentHash: string): Promise<Observation | null> {
    const rows = await this.q<ObservationRow>(
      "SELECT * FROM observations WHERE user_id = $1 AND content_hash = $2",
      [userId, contentHash],
    )
    const row = rows[0]
    return row ? toObservation(row) : null
  }

  async setObservationStatus(userId: string, id: string, status: ObservationStatus): Promise<void> {
    await this.q("UPDATE observations SET status = $3 WHERE user_id = $1 AND id = $2", [
      userId,
      id,
      status,
    ])
  }

  async listObservations(
    userId: string,
    opts: { status?: ObservationStatus; limit?: number } = {},
  ): Promise<Observation[]> {
    const params: unknown[] = [userId]
    let where = "user_id = $1"
    if (opts.status) {
      params.push(opts.status)
      where += ` AND status = $${params.length}`
    }
    params.push(opts.limit ?? 100)
    const rows = await this.q<ObservationRow>(
      `SELECT * FROM observations WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    )
    return rows.map(toObservation)
  }

  async countObservations(userId: string): Promise<number> {
    const rows = await this.q<{ n: string }>(
      "SELECT count(*) AS n FROM observations WHERE user_id = $1",
      [userId],
    )
    return toNumber(rows[0]?.n)
  }

  // -------------------------------------------------------------------------
  // Memories
  // -------------------------------------------------------------------------

  async insertMemory(memory: Memory): Promise<void> {
    try {
      await this.q(
        `INSERT INTO memories
           (id, user_id, type, content, summary, slot_key, confidence, importance,
            valid_from, valid_until, recorded_at, superseded_at, last_seen_at,
            reinforced_count, status, origin_observation_id, agent_id, extraction_run_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          memory.id,
          memory.userId,
          memory.type,
          memory.content,
          memory.summary ?? null,
          memory.slotKey ?? null,
          memory.confidence,
          memory.importance,
          memory.validFrom ?? null,
          memory.validUntil ?? null,
          memory.recordedAt,
          memory.supersededAt ?? null,
          memory.lastSeenAt ?? null,
          memory.reinforcedCount,
          memory.status,
          memory.originObservationId ?? null,
          memory.agentId ?? null,
          memory.extractionRunId ?? null,
          memory.metadata ? JSON.stringify(memory.metadata) : null,
        ],
      )
    } catch (error) {
      // 23P01 = exclusion_violation. This means two ACTIVE memories claim the
      // same slot over overlapping time — a genuine domain conflict, so surface
      // it as one rather than as a raw driver error.
      if (isPgError(error) && error.code === "23P01") {
        throw new ConflictError(
          `overlapping validity in slot "${memory.slotKey}" for user ${memory.userId}`,
          { slotKey: memory.slotKey, validFrom: memory.validFrom, validUntil: memory.validUntil },
        )
      }
      throw error
    }
  }

  async getMemory(userId: string, id: string): Promise<Memory | null> {
    const rows = await this.q<MemoryRow>("SELECT * FROM memories WHERE user_id = $1 AND id = $2", [
      userId,
      id,
    ])
    const row = rows[0]
    return row ? toMemory(row) : null
  }

  async getMemories(userId: string, ids: string[]): Promise<Memory[]> {
    if (ids.length === 0) return []
    const rows = await this.q<MemoryRow>(
      "SELECT * FROM memories WHERE user_id = $1 AND id = ANY($2::text[])",
      [userId, ids],
    )
    return rows.map(toMemory)
  }

  async listMemories(
    userId: string,
    filter: MemoryFilter = {},
    opts: { limit?: number; orderBy?: "recordedAt" | "importance" | "confidence" } = {},
  ): Promise<Memory[]> {
    const { where, params } = buildFilter(userId, filter)
    const order =
      opts.orderBy === "importance"
        ? "importance DESC, recorded_at DESC"
        : opts.orderBy === "confidence"
          ? "confidence DESC, recorded_at DESC"
          : "recorded_at DESC"
    params.push(opts.limit ?? 100)
    const rows = await this.q<MemoryRow>(
      `SELECT * FROM memories WHERE ${where} ORDER BY ${order} LIMIT $${params.length}`,
      params,
    )
    return rows.map(toMemory)
  }

  async countMemories(userId: string, filter: MemoryFilter = {}): Promise<number> {
    const { where, params } = buildFilter(userId, filter)
    const rows = await this.q<{ n: string }>(
      `SELECT count(*) AS n FROM memories WHERE ${where}`,
      params,
    )
    return toNumber(rows[0]?.n)
  }

  async updateMemoryStatus(userId: string, ids: string[], status: MemoryStatus): Promise<void> {
    if (ids.length === 0) return
    await this.q("UPDATE memories SET status = $3 WHERE user_id = $1 AND id = ANY($2::text[])", [
      userId,
      ids,
      status,
    ])
  }

  async supersedeMemory(
    userId: string,
    id: string,
    opts: { validUntil: IsoDateTime; supersededAt: IsoDateTime; status?: MemoryStatus },
  ): Promise<void> {
    await this.q(
      `UPDATE memories
          SET valid_until = $3, superseded_at = $4, status = $5
        WHERE user_id = $1 AND id = $2`,
      [userId, id, opts.validUntil, opts.supersededAt, opts.status ?? "superseded"],
    )
  }

  /**
   * REFINE case: the wording improved, so the row stops being the current
   * version but its valid-time interval is deliberately left untouched — the
   * fact still held over exactly the same period.
   */
  async markSupersededByRefinement(
    userId: string,
    id: string,
    opts: { supersededAt: IsoDateTime },
  ): Promise<void> {
    await this.q(
      "UPDATE memories SET superseded_at = $3, status = 'superseded' WHERE user_id = $1 AND id = $2",
      [userId, id, opts.supersededAt],
    )
  }

  async reinforceMemory(
    userId: string,
    id: string,
    opts: { confidence: number; importance?: number; recordedAt: IsoDateTime },
  ): Promise<void> {
    // Only assessment columns are touched. The claim itself stays immutable, so
    // re-observing a fact never creates a new version.
    await this.q(
      `UPDATE memories
          SET confidence = GREATEST(confidence, $3),
              importance = GREATEST(importance, COALESCE($4, importance)),
              last_seen_at = $5,
              reinforced_count = reinforced_count + 1
        WHERE user_id = $1 AND id = $2`,
      [userId, id, opts.confidence, opts.importance ?? null, opts.recordedAt],
    )
  }

  async updateMemoryContent(
    userId: string,
    id: string,
    opts: { content: string; summary?: string; importance?: number; confidence?: number },
  ): Promise<void> {
    await this.q(
      `UPDATE memories
          SET content = $3,
              summary = COALESCE($4, summary),
              importance = COALESCE($5, importance),
              confidence = COALESCE($6, confidence)
        WHERE user_id = $1 AND id = $2`,
      [
        userId,
        id,
        opts.content,
        opts.summary ?? null,
        opts.importance ?? null,
        opts.confidence ?? null,
      ],
    )
  }

  async deleteMemories(userId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const rows = await this.q<{ id: string }>(
      "DELETE FROM memories WHERE user_id = $1 AND id = ANY($2::text[]) RETURNING id",
      [userId, ids],
    )
    return rows.length
  }

  // -------------------------------------------------------------------------
  // Relations
  // -------------------------------------------------------------------------

  async insertRelations(relations: MemoryRelation[]): Promise<void> {
    if (relations.length === 0) return
    for (const relation of relations) {
      await this.q(
        `INSERT INTO memory_relations (id, user_id, from_memory_id, to_memory_id, kind, reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [
          relation.id,
          relation.userId,
          relation.fromMemoryId,
          relation.toMemoryId,
          relation.kind,
          relation.reason ?? null,
          relation.createdAt,
        ],
      )
    }
  }

  async relationsFrom(
    userId: string,
    fromIds: string[],
    kind?: RelationKind,
  ): Promise<MemoryRelation[]> {
    if (fromIds.length === 0) return []
    const params: unknown[] = [userId, fromIds]
    let where = "user_id = $1 AND from_memory_id = ANY($2::text[])"
    if (kind) {
      params.push(kind)
      where += ` AND kind = $${params.length}`
    }
    const rows = await this.q<RelationRow>(`SELECT * FROM memory_relations WHERE ${where}`, params)
    return rows.map(toRelation)
  }

  async relationsTo(
    userId: string,
    toIds: string[],
    kind?: RelationKind,
  ): Promise<MemoryRelation[]> {
    if (toIds.length === 0) return []
    const params: unknown[] = [userId, toIds]
    let where = "user_id = $1 AND to_memory_id = ANY($2::text[])"
    if (kind) {
      params.push(kind)
      where += ` AND kind = $${params.length}`
    }
    const rows = await this.q<RelationRow>(`SELECT * FROM memory_relations WHERE ${where}`, params)
    return rows.map(toRelation)
  }

  async listPending(userId: string, limit = 50): Promise<Memory[]> {
    const rows = await this.q<MemoryRow>(
      `SELECT * FROM memories WHERE user_id = $1 AND status = 'pending'
        ORDER BY recorded_at DESC LIMIT $2`,
      [userId, limit],
    )
    return rows.map(toMemory)
  }

  async findOverlappingActive(
    userId: string,
    slotKey: string,
    from: IsoDateTime,
    to?: IsoDateTime,
    excludeIds: string[] = [],
  ): Promise<Memory[]> {
    const rows = await this.q<MemoryRow>(
      `SELECT * FROM memories
        WHERE user_id = $1 AND slot_key = $2 AND status = 'active'
          AND NOT (id = ANY($5::text[]))
          AND tstzrange(valid_from, COALESCE(valid_until, 'infinity'::timestamptz))
              && tstzrange($3::timestamptz, COALESCE($4::timestamptz, 'infinity'::timestamptz))`,
      [userId, slotKey, from, to ?? null, excludeIds],
    )
    return rows.map(toMemory)
  }

  // -------------------------------------------------------------------------
  // Temporal queries
  // -------------------------------------------------------------------------

  async findValidAt(userId: string, at: IsoDateTime, filter: MemoryFilter = {}): Promise<Memory[]> {
    const { statuses, ...rest } = filter
    const { where, params } = buildFilter(userId, rest)
    params.push(at)
    const atIndex = params.length

    let statusClause: string
    if (statuses && statuses.length > 0) {
      // An explicit request is honoured literally.
      params.push(statuses)
      statusClause = `status = ANY($${params.length}::text[])`
    } else {
      statusClause = HISTORICALLY_VALID_STATUS_SQL("memories")
    }

    const rows = await this.q<MemoryRow>(
      `SELECT * FROM memories
        WHERE ${where}
          AND ${statusClause}
          AND valid_from <= $${atIndex}
          AND (valid_until IS NULL OR valid_until > $${atIndex})
        ORDER BY importance DESC, recorded_at DESC`,
      params,
    )
    return rows.map(toMemory)
  }

  /**
   * The bi-temporal query: what did we believe at `believedAt` about `validAt`.
   *
   * `status` is deliberately NOT applied here. Status is the *current*
   * projection — a row that is superseded today was active back then, and
   * filtering on it would erase exactly the history this query exists to
   * retrieve.
   */
  async findBelievedAt(
    userId: string,
    validAt: IsoDateTime,
    believedAt: IsoDateTime,
    filter: MemoryFilter = {},
  ): Promise<Memory[]> {
    const { statuses: _ignored, ...rest } = filter
    void _ignored
    const { where, params } = buildFilter(userId, rest)
    params.push(validAt, believedAt)
    const validIdx = params.length - 1
    const believedIdx = params.length
    const rows = await this.q<MemoryRow>(
      `SELECT * FROM memories
        WHERE ${where}
          AND valid_from <= $${validIdx}
          AND (valid_until IS NULL OR valid_until > $${validIdx})
          AND recorded_at <= $${believedIdx}
          AND (superseded_at IS NULL OR superseded_at > $${believedIdx})
        ORDER BY recorded_at DESC`,
      params,
    )
    return rows.map(toMemory)
  }

  /**
   * Walk `supersedes` and `refines` edges backwards from a memory, returning the
   * chain oldest-first. This is what answers "why did it change?".
   */
  async supersedesChain(userId: string, id: string): Promise<Memory[]> {
    const rows = await this.q<MemoryRow>(
      `WITH RECURSIVE chain AS (
         SELECT m.*, 0 AS depth
           FROM memories m
          WHERE m.user_id = $1 AND m.id = $2
         UNION ALL
         SELECT prev.*, c.depth + 1
           FROM chain c
           JOIN memory_relations r
             ON r.kind IN ('supersedes','refines') AND r.from_memory_id = c.id
           JOIN memories prev ON prev.id = r.to_memory_id AND prev.user_id = $1
          WHERE c.depth < 50
       )
       SELECT * FROM chain ORDER BY depth DESC`,
      [userId, id],
    )
    return rows.map(toMemory)
  }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  async upsertEntity(entity: Entity): Promise<Entity> {
    const key = entityKeyOf(entity.canonicalName)
    const rows = await this.q<EntityRow>(
      `INSERT INTO entities (id, user_id, canonical_name, kind, aliases, entity_key, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, entity_key) DO UPDATE
         SET aliases = (
           SELECT ARRAY(SELECT DISTINCT unnest(entities.aliases || EXCLUDED.aliases))
         )
       RETURNING *`,
      [
        entity.id,
        entity.userId,
        entity.canonicalName,
        entity.kind,
        entity.aliases,
        key,
        entity.createdAt,
      ],
    )
    const row = rows[0]
    if (!row) throw new Error("upsertEntity returned no row")
    return toEntity(row)
  }

  async findEntitiesByNames(userId: string, names: string[]): Promise<Entity[]> {
    if (names.length === 0) return []
    const keys = [...new Set(names.map(entityKeyOf))].filter((k) => k !== "")
    if (keys.length === 0) return []
    const rows = await this.q<EntityRow>(
      `SELECT * FROM entities
        WHERE user_id = $1
          AND (entity_key = ANY($2::text[])
               OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = ANY($2::text[])))`,
      [userId, keys],
    )
    return rows.map(toEntity)
  }

  async listEntities(userId: string, limit = 200): Promise<Entity[]> {
    const rows = await this.q<EntityRow>(
      "SELECT * FROM entities WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit],
    )
    return rows.map(toEntity)
  }

  async countEntities(userId: string): Promise<number> {
    const rows = await this.q<{ n: string }>(
      "SELECT count(*) AS n FROM entities WHERE user_id = $1",
      [userId],
    )
    return toNumber(rows[0]?.n)
  }

  async linkMemoryEntities(links: MemoryEntityLink[]): Promise<void> {
    for (const link of links) {
      await this.q(
        `INSERT INTO memory_entities (memory_id, entity_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (memory_id, entity_id) DO NOTHING`,
        [link.memoryId, link.entityId, link.role ?? null],
      )
    }
  }

  async entitiesForMemories(userId: string, memoryIds: string[]): Promise<Map<string, Entity[]>> {
    const out = new Map<string, Entity[]>()
    if (memoryIds.length === 0) return out
    const rows = await this.q<EntityRow & { memory_id: string }>(
      `SELECT e.*, me.memory_id
         FROM memory_entities me
         JOIN entities e ON e.id = me.entity_id
        WHERE e.user_id = $1 AND me.memory_id = ANY($2::text[])`,
      [userId, memoryIds],
    )
    for (const row of rows) {
      const list = out.get(row.memory_id) ?? []
      list.push(toEntity(row))
      out.set(row.memory_id, list)
    }
    return out
  }

  async memoryIdsForEntities(userId: string, entityIds: string[]): Promise<string[]> {
    if (entityIds.length === 0) return []
    const rows = await this.q<{ memory_id: string }>(
      `SELECT DISTINCT me.memory_id
         FROM memory_entities me
         JOIN memories m ON m.id = me.memory_id
        WHERE m.user_id = $1 AND me.entity_id = ANY($2::text[])`,
      [userId, entityIds],
    )
    return rows.map((r) => r.memory_id)
  }

  // -------------------------------------------------------------------------
  // Embeddings
  // -------------------------------------------------------------------------

  async upsertEmbedding(input: EmbeddingUpsert): Promise<void> {
    await this.q(
      `INSERT INTO memory_embeddings (memory_id, user_id, model, dim, embedding)
       VALUES ($1,$2,$3,$4,$5::vector)
       ON CONFLICT (memory_id, model) DO UPDATE
         SET embedding = EXCLUDED.embedding, dim = EXCLUDED.dim, created_at = now()`,
      [input.memoryId, input.userId, input.model, input.dim, toVectorLiteral(input.vector)],
    )
  }

  async listEmbeddingModels(userId: string): Promise<string[]> {
    const rows = await this.q<{ model: string }>(
      "SELECT DISTINCT model FROM memory_embeddings WHERE user_id = $1",
      [userId],
    )
    return rows.map((r) => r.model)
  }

  async countEmbeddings(userId: string, model: string): Promise<number> {
    const rows = await this.q<{ n: string }>(
      "SELECT count(*) AS n FROM memory_embeddings WHERE user_id = $1 AND model = $2",
      [userId, model],
    )
    return toNumber(rows[0]?.n)
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  async insertExtractionRun(run: ExtractionRun): Promise<void> {
    await this.q(
      `INSERT INTO extraction_runs
         (id, user_id, observation_id, prompt_version, model_id, input_tokens, output_tokens,
          cost_usd, latency_ms, candidates_produced, memories_written, language_retries,
          created_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        run.id,
        run.userId,
        run.observationId ?? null,
        run.promptVersion,
        run.modelId,
        run.inputTokens,
        run.outputTokens,
        run.costUsd,
        run.latencyMs,
        run.candidatesProduced,
        run.memoriesWritten,
        run.languageRetries,
        run.createdAt,
        run.error ?? null,
      ],
    )
  }

  async listExtractionRuns(userId: string, limit = 50): Promise<ExtractionRun[]> {
    const rows = await this.q<RunRow>(
      "SELECT * FROM extraction_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit],
    )
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      observationId: row.observation_id ?? undefined,
      promptVersion: row.prompt_version,
      modelId: row.model_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
      latencyMs: row.latency_ms,
      candidatesProduced: row.candidates_produced,
      memoriesWritten: row.memories_written,
      languageRetries: row.language_retries,
      createdAt: toIso(row.created_at),
      error: row.error ?? undefined,
    }))
  }

  // -------------------------------------------------------------------------
  // Agent policies
  // -------------------------------------------------------------------------

  async getAgentPolicy(userId: string, agentId: string): Promise<AgentPolicy | null> {
    const rows = await this.q<PolicyRow>(
      "SELECT * FROM agent_policies WHERE user_id = $1 AND agent_id = $2",
      [userId, agentId],
    )
    const row = rows[0]
    if (!row) return null
    return {
      userId: row.user_id,
      agentId: row.agent_id,
      allowedTypes: row.allowed_types as AgentPolicy["allowedTypes"],
      requireConfirmationFor: row.require_confirmation_for as AgentPolicy["requireConfirmationFor"],
      canWrite: row.can_write,
      createdAt: toIso(row.created_at),
    }
  }

  async upsertAgentPolicy(policy: AgentPolicy): Promise<void> {
    await this.q(
      `INSERT INTO agent_policies
         (user_id, agent_id, allowed_types, require_confirmation_for, can_write, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, agent_id) DO UPDATE
         SET allowed_types = EXCLUDED.allowed_types,
             require_confirmation_for = EXCLUDED.require_confirmation_for,
             can_write = EXCLUDED.can_write`,
      [
        policy.userId,
        policy.agentId,
        policy.allowedTypes,
        policy.requireConfirmationFor,
        policy.canWrite,
        policy.createdAt,
      ],
    )
  }

  async listAgentPolicies(userId: string): Promise<AgentPolicy[]> {
    const rows = await this.q<PolicyRow>(
      "SELECT * FROM agent_policies WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    )
    return rows.map((row) => ({
      userId: row.user_id,
      agentId: row.agent_id,
      allowedTypes: row.allowed_types as AgentPolicy["allowedTypes"],
      requireConfirmationFor: row.require_confirmation_for as AgentPolicy["requireConfirmationFor"],
      canWrite: row.can_write,
      createdAt: toIso(row.created_at),
    }))
  }
}

// ---------------------------------------------------------------------------
// Filter construction
// ---------------------------------------------------------------------------

/**
 * Statuses that count as "we believed this at the time", used by every
 * historical query.
 *
 * A row superseded by SUPERSEDE always has a `valid_until`, because the fact
 * genuinely stopped being true — it is exactly the right answer to "what was
 * true in 2026?".
 *
 * A row superseded by REFINE has NO `valid_until`: the fact still holds over the
 * same period, only the wording improved. Including it would report the same
 * fact twice, so it is excluded in favour of its successor.
 *
 * `pending` and `archived` are never beliefs we hold, so they never appear.
 */
export function HISTORICALLY_VALID_STATUS_SQL(alias: string): string {
  return `(${alias}.status = 'active' OR (${alias}.status = 'superseded' AND ${alias}.valid_until IS NOT NULL))`
}

export function buildFilter(
  userId: string,
  filter: MemoryFilter = {},
): { where: string; params: unknown[] } {
  const params: unknown[] = [userId]
  const clauses = ["user_id = $1"]

  if (filter.types && filter.types.length > 0) {
    params.push(filter.types)
    clauses.push(`type = ANY($${params.length}::text[])`)
  }
  if (filter.statuses && filter.statuses.length > 0) {
    params.push(filter.statuses)
    clauses.push(`status = ANY($${params.length}::text[])`)
  }
  if (filter.minConfidence !== undefined) {
    params.push(filter.minConfidence)
    clauses.push(`confidence >= $${params.length}`)
  }
  if (filter.minImportance !== undefined) {
    params.push(filter.minImportance)
    clauses.push(`importance >= $${params.length}`)
  }
  if (filter.agentIds && filter.agentIds.length > 0) {
    params.push(filter.agentIds)
    clauses.push(`agent_id = ANY($${params.length}::text[])`)
  }
  if (filter.entityIds && filter.entityIds.length > 0) {
    params.push(filter.entityIds)
    clauses.push(
      `EXISTS (SELECT 1 FROM memory_entities me
                WHERE me.memory_id = memories.id
                  AND me.entity_id = ANY($${params.length}::text[]))`,
    )
  }

  return { where: clauses.join(" AND "), params }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface MemoryRow extends pg.QueryResultRow {
  id: string
  user_id: string
  type: string
  content: string
  summary: string | null
  slot_key: string | null
  confidence: number
  importance: number
  valid_from: Date | null
  valid_until: Date | null
  recorded_at: Date
  superseded_at: Date | null
  last_seen_at: Date | null
  reinforced_count: number
  status: string
  origin_observation_id: string | null
  agent_id: string | null
  extraction_run_id: string | null
  metadata: Record<string, unknown> | null
}

interface ObservationRow extends pg.QueryResultRow {
  id: string
  user_id: string
  content: string
  source_kind: string
  agent_id: string | null
  occurred_at: Date
  created_at: Date
  status: string
  metadata: Record<string, unknown> | null
}

interface RelationRow extends pg.QueryResultRow {
  id: string
  user_id: string
  from_memory_id: string
  to_memory_id: string
  kind: string
  reason: string | null
  created_at: Date
}

interface EntityRow extends pg.QueryResultRow {
  id: string
  user_id: string
  canonical_name: string
  kind: string
  aliases: string[]
  created_at: Date
}

interface RunRow extends pg.QueryResultRow {
  id: string
  user_id: string
  observation_id: string | null
  prompt_version: string
  model_id: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  latency_ms: number
  candidates_produced: number
  memories_written: number
  language_retries: number
  created_at: Date
  error: string | null
}

interface PolicyRow extends pg.QueryResultRow {
  user_id: string
  agent_id: string
  allowed_types: string[]
  require_confirmation_for: string[]
  can_write: boolean
  created_at: Date
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toOptionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : toIso(value)
}

export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as Memory["type"],
    content: row.content,
    summary: row.summary ?? undefined,
    slotKey: row.slot_key ?? undefined,
    confidence: row.confidence,
    importance: row.importance,
    validFrom: toOptionalIso(row.valid_from),
    validUntil: toOptionalIso(row.valid_until),
    recordedAt: toIso(row.recorded_at),
    supersededAt: toOptionalIso(row.superseded_at),
    lastSeenAt: toOptionalIso(row.last_seen_at),
    reinforcedCount: row.reinforced_count,
    status: row.status as Memory["status"],
    originObservationId: row.origin_observation_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    extractionRunId: row.extraction_run_id ?? undefined,
    metadata: row.metadata ?? undefined,
  }
}

function toObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    userId: row.user_id,
    content: row.content,
    sourceKind: row.source_kind as Observation["sourceKind"],
    agentId: row.agent_id ?? undefined,
    occurredAt: toIso(row.occurred_at),
    createdAt: toIso(row.created_at),
    status: row.status as Observation["status"],
    metadata: row.metadata ?? undefined,
  }
}

function toRelation(row: RelationRow): MemoryRelation {
  return {
    id: row.id,
    userId: row.user_id,
    fromMemoryId: row.from_memory_id,
    toMemoryId: row.to_memory_id,
    kind: row.kind as MemoryRelation["kind"],
    reason: row.reason ?? undefined,
    createdAt: toIso(row.created_at),
  }
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    userId: row.user_id,
    canonicalName: row.canonical_name,
    kind: row.kind,
    aliases: row.aliases,
    createdAt: toIso(row.created_at),
  }
}

/**
 * Entity matching key. Duplicated from core's `entityKey` rather than imported
 * because the column must be computable in SQL-adjacent code without pulling a
 * domain helper into the storage layer's write path — and the two must agree.
 * A test asserts they stay in sync.
 */
export function entityKeyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[-_/.]+/g, " ")
    .replace(/\s+/g, "")
    .trim()
}

function isPgError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error
}
