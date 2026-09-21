import type { PgDatabase } from "./client.js"

/**
 * The width of the `memory_embeddings.embedding` column, as the database
 * actually declares it.
 *
 * Asking the schema instead of trusting a constant in the source means the
 * application can never disagree with its own database. A hardcoded check would
 * silently pass after a migration changed the column, and then fail much later
 * with a driver error on the first recall.
 */
export async function readEmbeddingDim(db: PgDatabase): Promise<number | null> {
  const { rows } = await db.query<{ dim: number | null; pretty: string | null }>(
    `SELECT a.atttypmod AS dim, format_type(a.atttypid, a.atttypmod) AS pretty
       FROM pg_attribute a
      WHERE a.attrelid = 'memory_embeddings'::regclass
        AND a.attname = 'embedding'`,
  )
  const dim = rows[0]?.dim
  if (dim === undefined || dim === null || dim <= 0) return null
  return dim
}

export interface DimChangeResult {
  previous: number | null
  next: number
  embeddingsDeleted: number
}

/**
 * Change the column width so a different embedding model can be used.
 *
 * Existing vectors cannot be reinterpreted — an embedding from another model
 * lives in a different vector space and simply has a different length, so they
 * are removed rather than cast. They must be recomputed with the new model,
 * which is what `reembed` does. This is destructive and says so.
 */
export async function changeEmbeddingDim(db: PgDatabase, dim: number): Promise<DimChangeResult> {
  if (!Number.isInteger(dim) || dim <= 0 || dim > 16000) {
    throw new Error(`invalid embedding dimension: ${dim}`)
  }

  const previous = await readEmbeddingDim(db)

  return db.withTransaction(async (client) => {
    const deleted = await client.query("DELETE FROM memory_embeddings")
    // The HNSW index is dimension-specific; it has to go before the type change.
    await client.query("DROP INDEX IF EXISTS memory_embeddings_hnsw_idx")
    await client.query(`ALTER TABLE memory_embeddings ALTER COLUMN embedding TYPE vector(${dim})`)
    await client.query(
      `CREATE INDEX memory_embeddings_hnsw_idx
         ON memory_embeddings USING hnsw (embedding vector_cosine_ops)`,
    )
    return { previous, next: dim, embeddingsDeleted: deleted.rowCount ?? 0 }
  })
}
