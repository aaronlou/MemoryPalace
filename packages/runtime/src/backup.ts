import { resolve } from "node:path"
import type { TransferBundle } from "@memory-palace/storage-pg"

/**
 * Backup helpers.
 *
 * The logic lives here rather than in `scripts/backup.ts` so it can be imported
 * and tested; the script is only argument parsing and I/O. Restore is the one
 * operation that can destroy everything a user has, so the validation path being
 * unit-testable matters more than usual.
 */

export interface BackupArgs {
  command: "backup" | "restore" | "check"
  file?: string
  user?: string
  includeEmbeddings: boolean
}

export function parseBackupArgs(argv: string[]): BackupArgs {
  const positional: string[] = []
  let includeEmbeddings = true
  let user: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--no-embeddings") includeEmbeddings = false
    else if (arg === "--user") user = argv[++i]
    else positional.push(arg)
  }

  const [first, ...rest] = positional
  if (first === "restore") return { command: "restore", file: rest[0], user, includeEmbeddings }
  if (first === "check") return { command: "check", file: rest[0], user, includeEmbeddings }
  return { command: "backup", file: first, user, includeEmbeddings }
}

/**
 * Structural validation, so a wrong file fails BEFORE anything is deleted.
 * Restore replaces all data, so this must reject rather than guess.
 */
export function validateBundle(raw: unknown): asserts raw is TransferBundle {
  if (typeof raw !== "object" || raw === null) throw new Error("backup is not an object")
  const bundle = raw as Partial<TransferBundle>
  if (bundle.format !== "memory-palace/export") {
    throw new Error(`not a Memory Palace backup (format: ${String(bundle.format)})`)
  }
  if (bundle.version !== 1) {
    throw new Error(`unsupported backup version: ${String(bundle.version)}`)
  }
  if (typeof bundle.userId !== "string" || bundle.userId === "") {
    throw new Error("backup has no userId")
  }
  for (const key of ["observations", "memories", "relations", "entities"] as const) {
    if (!Array.isArray(bundle[key])) throw new Error(`backup is missing its ${key} array`)
  }
}

export interface BackupSummary {
  file: string
  bytes: number
  userId: string
  exportedAt: string
  memories: number
  observations: number
  entities: number
  relations: number
  embeddings: number
}

export function summariseBundle(
  file: string,
  bundle: TransferBundle,
  bytes: number,
): BackupSummary {
  return {
    file,
    bytes,
    userId: bundle.userId,
    exportedAt: bundle.exportedAt,
    memories: bundle.memories.length,
    observations: bundle.observations.length,
    entities: bundle.entities.length,
    relations: bundle.relations.length,
    embeddings: bundle.embeddings?.length ?? 0,
  }
}

export function defaultBackupPath(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return resolve("backups", `memory-palace-${stamp}.json`)
}

export function formatSummary(summary: BackupSummary): string {
  const lines = [
    `user         ${summary.userId}`,
    `exported     ${summary.exportedAt}`,
    `memories     ${summary.memories}`,
    `observations ${summary.observations}`,
    `entities     ${summary.entities}`,
    `relations    ${summary.relations}`,
    `embeddings   ${summary.embeddings}`,
  ]
  return lines.join("\n")
}
