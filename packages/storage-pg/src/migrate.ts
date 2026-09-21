import type { PgDatabase } from "./client.js"
import { BOOTSTRAP_SQL, MIGRATIONS } from "./migrations.js"

export interface MigrationResult {
  applied: string[]
  alreadyApplied: string[]
}

/**
 * Apply pending migrations.
 *
 * Each migration runs in its own transaction and is recorded by id, so a
 * partially-applied schema is not possible and re-running is a no-op.
 */
export async function migrate(db: PgDatabase): Promise<MigrationResult> {
  await db.query(BOOTSTRAP_SQL)

  const existing = await db.query<{ id: string }>("SELECT id FROM schema_migrations")
  const applied = new Set(existing.rows.map((r) => r.id))

  const result: MigrationResult = { applied: [], alreadyApplied: [] }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      result.alreadyApplied.push(migration.id)
      continue
    }
    await db.withTransaction(async (client) => {
      await client.query(migration.sql)
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id])
    })
    result.applied.push(migration.id)
  }

  return result
}

/** Which extensions and versions the connected server actually has. */
export async function inspectCapabilities(db: PgDatabase): Promise<{
  postgres: string
  vector: string | null
  pgTrgm: boolean
}> {
  const version = await db.query<{ version: string }>("SELECT version() AS version")
  const extensions = await db.query<{ extname: string; extversion: string }>(
    "SELECT extname, extversion FROM pg_extension",
  )
  const byName = new Map(extensions.rows.map((r) => [r.extname, r.extversion]))
  return {
    postgres: (version.rows[0]?.version ?? "unknown").split(" ").slice(0, 2).join(" "),
    vector: byName.get("vector") ?? null,
    pgTrgm: byName.has("pg_trgm"),
  }
}
