import type { MemorySearch, MemoryStatus, SearchHit, SearchOptions } from "@memory-palace/core"
import { discriminativeTokens } from "@memory-palace/shared"
import type { PgDatabase } from "./client.js"
import { readEmbeddingDim } from "./embedding-dim.js"
import { buildFilter } from "./store.js"

/**
 * Default width for a fresh schema.
 *
 * pgvector requires a declared dimension to build an HNSW index, so the column
 * cannot be free-form. 1024 matches bge-m3 and Cohere embed-v4 out of the box.
 * The *actual* width is read from the schema at query time rather than assumed
 * from this constant, so changing models is a supported operation
 * (`pnpm embedding:dim`) rather than something that silently disagrees with the
 * application.
 */
export const VECTOR_DIM = 1024

/**
 * The five retrieval routes.
 *
 * Each returns ids with a score meaningful only for ordering *within* that route
 * — fusing scores across routes is exactly what RRF exists to avoid.
 */
export class PgMemorySearch implements MemorySearch {
  private readonly db: PgDatabase
  /** Width declared by the schema, read once and cached. */
  private declaredDim: number | null | undefined

  constructor(db: PgDatabase) {
    this.db = db
  }

  async semantic(userId: string, vector: number[], opts: SearchOptions): Promise<SearchHit[]> {
    if (this.declaredDim === undefined) this.declaredDim = await readEmbeddingDim(this.db)
    const expected = this.declaredDim ?? VECTOR_DIM
    if (vector.length !== expected) {
      // Should be unreachable: the runtime asserts this at startup. Kept as a
      // backstop so a direct PgMemorySearch user gets a clear message too.
      throw new Error(
        `semantic search received a ${vector.length}-dimensional vector but the schema ` +
          `declares vector(${expected}). Run: pnpm embedding:dim ${vector.length}`,
      )
    }
    const params: unknown[] = [userId, `[${vector.join(",")}]`]
    const clauses = ["e.user_id = $1", "m.user_id = $1"]
    this.applyFilters(clauses, params, opts, "m")

    if (opts.minScore !== undefined && opts.minScore > 0) {
      params.push(opts.minScore)
      clauses.push(`1 - (e.embedding <=> $2::vector) >= $${params.length}`)
    }

    params.push(opts.limit)
    const { rows } = await this.db.query<{ id: string; score: number | null }>(
      `SELECT m.id, 1 - (e.embedding <=> $2::vector) AS score
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY e.embedding <=> $2::vector
        LIMIT $${params.length}`,
      params,
    )
    return toHits(rows)
  }

  /**
   * Lexical route.
   *
   * Postgres' built-in full-text search tokenises Chinese poorly, so a pure
   * `ts_rank` route finds almost nothing in CJK text. Trigram similarity alone
   * is too blunt the other way: a short Chinese query against longer content
   * scores a few percent on incidental shared characters, which produces false
   * positives on completely unrelated memories.
   *
   * So the gate is: the query must share a *discriminative* term with the
   * memory — a latin word or CJK bigram that is not a stopword. Similarity and
   * `ts_rank` then only decide the ORDER, which is what they are good at.
   */
  async lexical(userId: string, query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const tokens = discriminativeTokens(query)
    const like = `%${escapeLike(query)}%`
    const params: unknown[] = [userId, query, like, tokens]
    const clauses = ["m.user_id = $1"]
    this.applyFilters(clauses, params, opts, "m")

    params.push(opts.limit)
    const { rows } = await this.db.query<{ id: string; score: number | null }>(
      `SELECT m.id,
              GREATEST(
                ts_rank(m.content_tsv, websearch_to_tsquery('simple', $2)) * 10,
                similarity(m.content, $2),
                CASE WHEN m.content ILIKE $3 THEN 0.5 ELSE 0 END
              ) AS score
         FROM memories m
        WHERE ${clauses.join(" AND ")}
          AND (
            m.content_tsv @@ websearch_to_tsquery('simple', $2)
            OR m.content ILIKE $3
            OR EXISTS (
              SELECT 1 FROM unnest($4::text[]) AS tok
               WHERE m.content ILIKE '%' || tok || '%'
            )
          )
        ORDER BY score DESC
        LIMIT $${params.length}`,
      params,
    )
    return toHits(rows)
  }

  async byEntity(userId: string, entityIds: string[], opts: SearchOptions): Promise<SearchHit[]> {
    if (entityIds.length === 0) return []
    const params: unknown[] = [userId, entityIds, entityIds.length]
    const clauses = ["m.user_id = $1"]
    this.applyFilters(clauses, params, opts, "m")

    params.push(opts.limit)
    const { rows } = await this.db.query<{ id: string; score: number | null }>(
      `SELECT m.id, count(DISTINCT me.entity_id)::float8 / $3::float8 AS score
         FROM memories m
         JOIN memory_entities me ON me.memory_id = m.id
        WHERE ${clauses.join(" AND ")} AND me.entity_id = ANY($2::text[])
        GROUP BY m.id
        ORDER BY score DESC, m.importance DESC
        LIMIT $${params.length}`,
      params,
    )
    return toHits(rows)
  }

  async recent(userId: string, opts: SearchOptions): Promise<SearchHit[]> {
    const params: unknown[] = [userId]
    const clauses = ["m.user_id = $1"]
    this.applyFilters(clauses, params, opts, "m")

    params.push(opts.limit)
    const { rows } = await this.db.query<{ id: string; score: number | null }>(
      `SELECT m.id, EXTRACT(EPOCH FROM COALESCE(m.last_seen_at, m.recorded_at)) AS score
         FROM memories m
        WHERE ${clauses.join(" AND ")}
        ORDER BY COALESCE(m.last_seen_at, m.recorded_at) DESC
        LIMIT $${params.length}`,
      params,
    )
    return toHits(rows)
  }

  async important(userId: string, opts: SearchOptions): Promise<SearchHit[]> {
    const params: unknown[] = [userId]
    const clauses = ["m.user_id = $1"]
    this.applyFilters(clauses, params, opts, "m")

    params.push(opts.limit)
    const { rows } = await this.db.query<{ id: string; score: number | null }>(
      `SELECT m.id, m.importance AS score
         FROM memories m
        WHERE ${clauses.join(" AND ")}
        ORDER BY m.importance DESC, m.confidence DESC
        LIMIT $${params.length}`,
      params,
    )
    return toHits(rows)
  }

  /**
   * Append the temporal and type constraints every route shares.
   *
   * The transaction-time branch is the subtle one: when asking what we believed
   * in the past, `status` must NOT be filtered, because a row that is superseded
   * today was active back then. Filtering on the current projection would erase
   * the very history the query exists to retrieve.
   */
  private applyFilters(
    clauses: string[],
    params: unknown[],
    opts: SearchOptions,
    alias: string,
  ): void {
    const statuses: MemoryStatus[] =
      opts.statuses && opts.statuses.length > 0 ? opts.statuses : ["active"]

    if (opts.believedAt === undefined && statuses.length > 0) {
      params.push(statuses)
      clauses.push(`${alias}.status = ANY($${params.length}::text[])`)
      // When history is requested, exclude rows that were merely reworded: they
      // cover the same period as their successor and would double-report a fact.
      if (statuses.includes("superseded")) {
        clauses.push(`NOT (${alias}.status = 'superseded' AND ${alias}.valid_until IS NULL)`)
      }
    }

    if (opts.asOf) {
      params.push(opts.asOf)
      const i = params.length
      clauses.push(`(${alias}.valid_from IS NULL OR ${alias}.valid_from <= $${i})`)
      clauses.push(`(${alias}.valid_until IS NULL OR ${alias}.valid_until > $${i})`)
    }

    if (opts.believedAt) {
      params.push(opts.believedAt)
      const i = params.length
      clauses.push(`${alias}.recorded_at <= $${i}`)
      clauses.push(`(${alias}.superseded_at IS NULL OR ${alias}.superseded_at > $${i})`)
    }

    const filter = opts.filter
    if (!filter) return
    if (filter.types && filter.types.length > 0) {
      params.push(filter.types)
      clauses.push(`${alias}.type = ANY($${params.length}::text[])`)
    }
    if (filter.minConfidence !== undefined) {
      params.push(filter.minConfidence)
      clauses.push(`${alias}.confidence >= $${params.length}`)
    }
    if (filter.minImportance !== undefined) {
      params.push(filter.minImportance)
      clauses.push(`${alias}.importance >= $${params.length}`)
    }
    if (filter.agentIds && filter.agentIds.length > 0) {
      params.push(filter.agentIds)
      clauses.push(`${alias}.agent_id = ANY($${params.length}::text[])`)
    }
    if (filter.entityIds && filter.entityIds.length > 0) {
      params.push(filter.entityIds)
      clauses.push(
        `EXISTS (SELECT 1 FROM memory_entities me2
                  WHERE me2.memory_id = ${alias}.id
                    AND me2.entity_id = ANY($${params.length}::text[]))`,
      )
    }
  }
}

function toHits(rows: Array<{ id: string; score: number | string | null }>): SearchHit[] {
  return rows.map((row, index) => ({
    memoryId: row.id,
    score: row.score === null ? 0 : Number(row.score),
    rank: index + 1,
  }))
}

/** Escape LIKE wildcards so a query containing `%` cannot match everything. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/** Re-exported so callers can build a filter the same way the store does. */
export { buildFilter }
