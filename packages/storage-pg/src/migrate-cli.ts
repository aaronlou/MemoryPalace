/**
 * `pnpm migrate` — apply pending migrations.
 *
 * A CLI rather than an app-startup side effect: schema changes should be a
 * deliberate act with visible output, not something that happens the first time
 * a server boots.
 */
import { loadConfig } from "@memory-palace/shared"
import { PgDatabase } from "./client.js"
import { readEmbeddingDim } from "./embedding-dim.js"
import { inspectCapabilities, migrate } from "./migrate.js"

async function main(): Promise<void> {
  const config = loadConfig()
  const db = new PgDatabase(config.databaseUrl, 2)

  try {
    await db.ping()
  } catch (error) {
    console.error(`\nCannot reach Postgres at ${redact(config.databaseUrl)}`)
    console.error(error instanceof Error ? error.message : String(error))
    console.error(
      "\nStart the repo-local cluster with:\n  pnpm db:start\n" +
        "or point DATABASE_URL at your own Postgres 18 instance with pgvector installed.",
    )
    process.exitCode = 1
    return
  }

  try {
    const result = await migrate(db)
    const capabilities = await inspectCapabilities(db)

    console.log(`Postgres: ${capabilities.postgres}`)
    console.log(`pgvector: ${capabilities.vector ?? "MISSING"}`)
    console.log(`pg_trgm:  ${capabilities.pgTrgm ? "yes" : "MISSING"}`)

    if (!capabilities.vector) {
      console.error("\nERROR: the vector extension is not installed. Run `pnpm db:start` (which")
      console.error("creates it) or install pgvector in your own server.")
      process.exitCode = 1
      return
    }

    const declared = await readEmbeddingDim(db)
    if (declared !== null && declared !== config.embedding.dim) {
      console.warn(
        `\nWARNING: the schema stores vector(${declared}) but MP_EMBEDDING_DIM=${config.embedding.dim}.\n` +
          `Semantic search will refuse to run. Fix it with:\n` +
          `  pnpm embedding:dim ${config.embedding.dim}\n` +
          `  pnpm embedding:reembed`,
      )
    }

    if (result.applied.length > 0) {
      console.log(`\nApplied ${result.applied.length} migration(s):`)
      for (const id of result.applied) console.log(`  + ${id}`)
    } else {
      console.log(
        `\nSchema up to date (${result.alreadyApplied.length} migration(s) already applied).`,
      )
    }
  } finally {
    await db.close()
  }
}

/** Never print credentials, even in a local error message. */
function redact(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    if (url.password) url.password = "***"
    return url.toString()
  } catch {
    return "<unparsable connection string>"
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
