import { ConfigurationError } from "./errors.js"

/**
 * Which databases a destructive command is allowed to erase.
 *
 * This exists because the same mistake was made three times, each time with a
 * different mechanism: an eval run pointed at the development database, a test
 * run pointed at it, and a destructive endpoint exercised against a live server.
 * Documentation did not prevent any of them. A guard does, because it fails at the
 * moment of the mistake rather than in a paragraph someone read last week.
 *
 * The rule is deliberately narrow. It does NOT protect the product's own
 * endpoints: `POST /api/erase` erasing the configured database is the feature
 * working, and `pnpm restore` replacing your data is what it is for. What it
 * protects is the *tooling* — the test suite and the evaluation harness, which
 * truncate every table and have no business doing so anywhere but a scratch
 * database.
 */

/** The database the application uses. Never a target for the tooling. */
export const DEV_DATABASE_NAME = "memory_palace"

/** The scratch database the test suite and evaluation runs default to. */
export const SCRATCH_DATABASE_NAME = "memory_palace_test"
export const SCRATCH_DATABASE_URL = `postgresql://mp@127.0.0.1:55432/${SCRATCH_DATABASE_NAME}`

/**
 * Names that read as disposable.
 *
 * A naming convention rather than a proof — but the failure mode it prevents is
 * "pointed at the wrong database", and the wrong database is always the one with
 * a real name.
 */
const DISPOSABLE = /(_test|_scratch|_eval|_tmp|_ci)$/

/** The database name in a connection string, or undefined if it cannot be read. */
export function databaseNameOf(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined
  try {
    const name = new URL(connectionString).pathname.replace(/^\//, "")
    return name === "" ? undefined : name
  } catch {
    return undefined
  }
}

export function isScratchDatabaseName(name: string | undefined): boolean {
  if (!name) return false
  // Named explicitly rather than relying on the pattern: a development database
  // called `memory_palace_test` would otherwise be treated as disposable.
  if (name === DEV_DATABASE_NAME) return false
  return DISPOSABLE.test(name)
}

/**
 * Throws unless the target is disposable, or the operator has said otherwise.
 *
 * `MP_ALLOW_DESTRUCTIVE=1` is the escape hatch for the legitimate case — erasing a
 * copy of real data on purpose. It is an explicit act, not a default.
 */
export function assertScratchDatabase(name: string | undefined, context: string): void {
  if (process.env.MP_ALLOW_DESTRUCTIVE === "1") return
  if (isScratchDatabaseName(name)) return

  const target = name ?? "<unknown>"
  throw new ConfigurationError(
    `${context} truncates every table, and "${target}" is not a scratch database.\n` +
      `  Point it somewhere disposable:  DATABASE_URL=${SCRATCH_DATABASE_URL}\n` +
      `  Create that database once with:  pnpm db:test\n` +
      `  Deliberately erasing real data?  MP_ALLOW_DESTRUCTIVE=1`,
  )
}
