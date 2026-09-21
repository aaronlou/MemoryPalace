/**
 * Backup and restore, as a CLI.
 *
 *   pnpm backup [file]          write a full JSON backup (default: backups/<date>.json)
 *   pnpm restore <file>         replace all data from a backup
 *   pnpm backup check <file>    verify a backup WITHOUT touching the database
 *
 * A local-first product lives or dies on this working, so export, restore and
 * verification are first-class commands rather than something you reach for
 * through an HTTP API after the database is already gone.
 *
 * All logic lives in @memory-palace/runtime so it can be tested; this file is
 * only argument handling and I/O.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  createRuntime,
  defaultBackupPath,
  formatSummary,
  parseBackupArgs,
  summariseBundle,
  validateBundle,
} from "@memory-palace/runtime"
import { loadConfig } from "@memory-palace/shared"
import { exportAll, importAll } from "@memory-palace/storage-pg"

async function main(): Promise<void> {
  const args = parseBackupArgs(process.argv.slice(2))

  // `check` deliberately never opens a database connection: verifying a backup
  // must be possible on a machine that has no Postgres at all.
  if (args.command === "check") {
    if (!args.file) throw new Error("usage: pnpm backup check <file>")
    const text = readFileSync(args.file, "utf8")
    const bundle: unknown = JSON.parse(text)
    validateBundle(bundle)
    console.log(`verified ${args.file}`)
    console.log(formatSummary(summariseBundle(args.file, bundle, Buffer.byteLength(text))))
    return
  }

  const config = loadConfig(args.user ? { userId: args.user } : {})
  const runtime = createRuntime({ config: { userId: config.userId, logLevel: "warn" } })

  try {
    if (args.command === "backup") {
      const file = args.file ?? defaultBackupPath()
      const bundle = await exportAll(runtime.storage.db, config.userId, {
        includeEmbeddings: args.includeEmbeddings,
      })
      const text = JSON.stringify(bundle, null, 2)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text, "utf8")
      console.log(`wrote ${file} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KiB)`)
      console.log(formatSummary(summariseBundle(file, bundle, Buffer.byteLength(text))))
      return
    }

    if (!args.file) throw new Error("usage: pnpm restore <file>")
    const bundle: unknown = JSON.parse(readFileSync(args.file, "utf8"))
    // Validate before opening a transaction, so a wrong file changes nothing.
    validateBundle(bundle)

    if (bundle.userId !== config.userId) {
      process.stderr.write(
        `note: the backup belongs to "${bundle.userId}" but this instance is "${config.userId}".\n` +
          `      It will be written under "${config.userId}". Pass --user ${bundle.userId} to keep the original.\n`,
      )
    }

    const result = await importAll(
      runtime.storage.db,
      { ...bundle, userId: config.userId },
      { replace: true },
    )
    console.log(`restored into "${config.userId}":`)
    console.log(
      formatSummary({
        ...summariseBundle(args.file, bundle, 0),
        ...result,
        embeddings: result.embeddings,
      }),
    )
    console.log("\nVerify with: pnpm demo")
  } finally {
    await runtime.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
