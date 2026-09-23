import type { PgDatabase } from "./client.js"

/**
 * Export / import.
 *
 * For a local-first product this is the trust foundation: the user must be able
 * to take their memory elsewhere, and to verify that "delete" really deletes.
 * It is also the only workable backup story before there is a sync protocol.
 *
 * Implemented at the storage layer rather than through the domain ports because
 * it needs whole-table access, and because a round-trip test
 * (export → wipe → import → identical eval score) is the acceptance criterion.
 */

export interface TransferBundle {
  format: "memory-palace/export"
  version: 1
  exportedAt: string
  userId: string
  /** Present only when embeddings were requested (they are large and rebuildable). */
  embeddings?: Array<{
    memoryId: string
    model: string
    dim: number
    vector: number[]
  }>
  observations: Array<Record<string, unknown>>
  memories: Array<Record<string, unknown>>
  relations: Array<Record<string, unknown>>
  entities: Array<Record<string, unknown>>
  memoryEntities: Array<Record<string, unknown>>
  policies: Array<Record<string, unknown>>
  runs: Array<Record<string, unknown>>
  /** Absent from bundles written before prior art existed; treated as empty. */
  priorArt?: Array<Record<string, unknown>>
}

export interface ExportOptions {
  /** Include embedding vectors. Large; omit unless migrating machines verbatim. */
  includeEmbeddings?: boolean
}

export async function exportAll(
  db: PgDatabase,
  userId: string,
  options: ExportOptions = {},
): Promise<TransferBundle> {
  const [observations, memories, relations, entities, memoryEntities, policies, runs, priorArt] =
    await Promise.all([
      db.query("SELECT * FROM observations WHERE user_id = $1 ORDER BY created_at", [userId]),
      db.query("SELECT * FROM memories WHERE user_id = $1 ORDER BY recorded_at", [userId]),
      db.query("SELECT * FROM memory_relations WHERE user_id = $1 ORDER BY created_at", [userId]),
      db.query("SELECT * FROM entities WHERE user_id = $1 ORDER BY created_at", [userId]),
      db.query(
        `SELECT me.* FROM memory_entities me
           JOIN memories m ON m.id = me.memory_id
          WHERE m.user_id = $1`,
        [userId],
      ),
      db.query("SELECT * FROM agent_policies WHERE user_id = $1", [userId]),
      db.query("SELECT * FROM extraction_runs WHERE user_id = $1 ORDER BY created_at", [userId]),
      db.query("SELECT * FROM prior_art WHERE user_id = $1 ORDER BY added_at", [userId]),
    ])

  const bundle: TransferBundle = {
    format: "memory-palace/export",
    version: 1,
    exportedAt: new Date().toISOString(),
    userId,
    observations: observations.rows.map(stripNulls),
    // content_tsv is a generated column; including it would fail on import.
    memories: memories.rows.map((row) => stripNulls(omit(row, ["content_tsv"]))),
    relations: relations.rows.map(stripNulls),
    entities: entities.rows.map(stripNulls),
    memoryEntities: memoryEntities.rows.map(stripNulls),
    policies: policies.rows.map(stripNulls),
    runs: runs.rows.map(stripNulls),
    priorArt: priorArt.rows.map(stripNulls),
  }

  if (options.includeEmbeddings) {
    const rows = await db.query<{
      memory_id: string
      model: string
      dim: number
      embedding: string
    }>("SELECT memory_id, model, dim, embedding::text FROM memory_embeddings WHERE user_id = $1", [
      userId,
    ])
    bundle.embeddings = rows.rows.map((r) => ({
      memoryId: r.memory_id,
      model: r.model,
      dim: r.dim,
      vector: parseVectorLiteral(r.embedding),
    }))
  }

  return bundle
}

export interface ImportResult {
  observations: number
  memories: number
  relations: number
  entities: number
  memoryEntities: number
  policies: number
  embeddings: number
  priorArt: number
}

export interface ImportOptions {
  /** Delete everything for this user first, so the import is a true restore. */
  replace?: boolean
}

/**
 * Import a bundle. Idempotent: re-importing the same file does not duplicate
 * rows, which matters because the natural failure mode of a restore is being
 * run twice.
 */
export async function importAll(
  db: PgDatabase,
  bundle: TransferBundle,
  options: ImportOptions = {},
): Promise<ImportResult> {
  if (bundle.format !== "memory-palace/export") {
    throw new Error(`unrecognised bundle format: ${String(bundle.format)}`)
  }
  if (bundle.version !== 1) {
    throw new Error(`unsupported bundle version: ${String(bundle.version)}`)
  }
  const userId = bundle.userId

  return db.withTransaction(async (client) => {
    if (options.replace) {
      await wipeUser(db, userId, client)
    }

    const result: ImportResult = {
      observations: 0,
      memories: 0,
      relations: 0,
      entities: 0,
      memoryEntities: 0,
      policies: 0,
      embeddings: 0,
      priorArt: 0,
    }

    // Order matters: foreign keys require referenced rows to exist first.
    result.entities = await insertRows(client, "entities", bundle.entities)
    result.observations = await insertRows(client, "observations", bundle.observations)
    result.memories = await insertRows(client, "memories", bundle.memories, ["content_tsv"])

    if (bundle.embeddings && bundle.embeddings.length > 0) {
      for (const item of bundle.embeddings) {
        await client.query(
          `INSERT INTO memory_embeddings (memory_id, user_id, model, dim, embedding)
           VALUES ($1,$2,$3,$4,$5::vector)
           ON CONFLICT (memory_id, model) DO NOTHING`,
          [item.memoryId, userId, item.model, item.dim, `[${item.vector.join(",")}]`],
        )
        result.embeddings += 1
      }
    }

    result.memoryEntities = await insertRows(
      client,
      "memory_entities",
      bundle.memoryEntities,
      [],
      ["memory_id", "entity_id"],
    )
    result.relations = await insertRows(client, "memory_relations", bundle.relations)
    result.policies = await insertRows(
      client,
      "agent_policies",
      bundle.policies,
      [],
      ["user_id", "agent_id"],
    )
    // Absent from bundles written before prior art existed, so `?? []`.
    result.priorArt = await insertRows(
      client,
      "prior_art",
      bundle.priorArt ?? [],
      [],
      ["user_id", "repo"],
    )

    // The schema_migrations table is intentionally NOT part of a bundle: schema
    // version is a property of the deployment, not of the user's data.

    return result
  })
}

/** Delete every row belonging to a user. Used by `replace` imports and by "erase me". */
export async function wipeUser(
  db: PgDatabase,
  userId: string,
  client?: import("pg").PoolClient,
): Promise<void> {
  const run = async (c: { query: (t: string, p?: unknown[]) => Promise<unknown> }) => {
    // memory_relations / memory_entities / memory_embeddings / memory_sources all
    // cascade from memories, but deleting them explicitly keeps this correct even
    // if a future migration drops a cascade.
    await c.query(
      "DELETE FROM memory_entities WHERE memory_id IN (SELECT id FROM memories WHERE user_id = $1)",
      [userId],
    )
    await c.query("DELETE FROM memory_relations WHERE user_id = $1", [userId])
    await c.query("DELETE FROM memory_embeddings WHERE user_id = $1", [userId])
    await c.query(
      "DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM memories WHERE user_id = $1)",
      [userId],
    )
    await c.query("DELETE FROM extraction_runs WHERE user_id = $1", [userId])
    // Prior art has no foreign key to memories, so it needs its own delete. An
    // "erase me" that left the reference list behind would be a lie, and the whole
    // point of this layer is that "delete" really deletes.
    await c.query("DELETE FROM prior_art WHERE user_id = $1", [userId])
    await c.query("DELETE FROM memories WHERE user_id = $1", [userId])
    await c.query("DELETE FROM observations WHERE user_id = $1", [userId])
    await c.query("DELETE FROM entities WHERE user_id = $1", [userId])
    await c.query("DELETE FROM agent_policies WHERE user_id = $1", [userId])
  }

  if (client) {
    await run({ query: (t, p) => client.query(t, p as never[]) })
  } else {
    await db.withTransaction(async (c) => {
      await run({ query: (t, p) => c.query(t, p as never[]) })
    })
  }
}

// ---------------------------------------------------------------------------
// Generic row inserters
// ---------------------------------------------------------------------------

async function insertRows(
  client: import("pg").PoolClient,
  table: string,
  rows: Array<Record<string, unknown>>,
  skipColumns: string[] = [],
  conflictColumns: string[] = [],
): Promise<number> {
  let count = 0
  for (const row of rows) {
    const columns = Object.keys(row).filter((c) => !skipColumns.includes(c))
    if (columns.length === 0) continue
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(",")
    const jsonColumns = await jsonColumnsOf(client, table)
    const values = columns.map((c) => normaliseValue(row[c], jsonColumns.has(c)))
    const conflict =
      conflictColumns.length > 0
        ? ` ON CONFLICT (${conflictColumns.join(",")}) DO NOTHING`
        : " ON CONFLICT DO NOTHING"

    const result = await client.query(
      `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(",")})
       VALUES (${placeholders})${conflict}`,
      values as never[],
    )
    count += result.rowCount ?? 0
  }
  return count
}

/** Table and column names come from our own bundle shape, but quote anyway. */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to build SQL with unexpected identifier: ${name}`)
  }
  return `"${name}"`
}

/**
 * The jsonb columns of a table, asked of the database rather than listed here.
 *
 * This has to be type-aware, not shape-aware. `node-postgres` serialises a JS
 * array as a Postgres array literal, which is right for `entities.aliases` and the
 * two policy columns, and wrong for a jsonb array — it fails with "invalid input
 * syntax for type json". An earlier version stringified objects but deliberately
 * left arrays alone, so `prior_art.evidence` broke the whole restore: the insert
 * threw, the transaction rolled back, and a backup containing a prior-art entry
 * could not be imported at all.
 *
 * Asking the catalogue means a future jsonb column is handled the day it is added,
 * which is exactly the mistake this replaces.
 */
async function jsonColumnsOf(client: import("pg").PoolClient, table: string): Promise<Set<string>> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
        AND data_type IN ('json', 'jsonb')`,
    [table],
  )
  return new Set(rows.map((row) => row.column_name))
}

function normaliseValue(value: unknown, isJson: boolean): unknown {
  if (value === null || value === undefined) return null
  // Timestamps come back from node-postgres as Date objects. They must become
  // ISO strings here, at import time, so the two representations of a bundle
  // are identical.
  if (value instanceof Date) return value.toISOString()
  // jsonb takes JSON text; a JS array would otherwise be read as a Postgres array.
  if (isJson) return JSON.stringify(value)
  if (typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value)
  return value
}

function omit(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v
  return out
}

/**
 * Make a row JSON-safe and drop nulls.
 *
 * The Date conversion is not cosmetic: without it the in-memory bundle holds
 * `Date` objects while a bundle read back from disk holds ISO strings, so code
 * written against one shape silently breaks on the other. Normalising here means
 * there is only ever one shape.
 */
function stripNulls(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === null) continue
    out[k] = v instanceof Date ? v.toISOString() : v
  }
  return out
}

function parseVectorLiteral(literal: string): number[] {
  return literal
    .replace(/^\[|\]$/g, "")
    .split(",")
    .filter((s) => s !== "")
    .map(Number)
}
