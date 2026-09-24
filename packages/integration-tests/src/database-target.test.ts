import { DEV_DATABASE_NAME, databaseNameOf, isScratchDatabaseName } from "@memory-palace/shared"
import { createTestRuntime, TEST_DB_URL } from "@memory-palace/test-support"
import { afterAll, describe, expect, it } from "vitest"

/**
 * Which database the suite talks to.
 *
 * The suite truncates every table, so this is a safety property rather than a
 * convenience one. It was violated for its entire early life by something that
 * looks like a trivial preference for reading configuration late: `.env` is
 * loaded lazily, by the first `createRuntime`, and loading it mutates
 * `process.env` — including `DATABASE_URL`, which normally names the development
 * database. A test-support that read the URL per call therefore resolved it
 * differently within a single process: the first runtime used a scratch database
 * and every runtime created afterwards silently used the user's own store.
 *
 * The visible symptom was eight failing tests after the truncation guard landed
 * (`memory_palace` is not disposable, correctly). The invisible one was worse and
 * had been there all along: scoped runtimes — `freshPalace`, the recall harness's
 * per-scenario stores — were persisting into real data, and any assertion that
 * read back through a different runtime looked at the wrong database.
 */

describe("the suite cannot be redirected to a real database", () => {
  const originalUrl = process.env.DATABASE_URL

  afterAll(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalUrl
  })

  it("defaults to a database whose name reads as disposable", () => {
    // The truncation guard keys off this name, so aiming the suite anywhere else
    // would put it one edit away from erasing real memories.
    const target = databaseNameOf(TEST_DB_URL)
    expect(target).toBeDefined()
    expect(isScratchDatabaseName(target)).toBe(true)
  })

  it("keeps that target after loading .env has rewritten DATABASE_URL", async () => {
    // Reproducing the mutation directly rather than depending on the machine
    // having a `.env`: with none, this assertion would quietly pass for the
    // wrong reason.
    process.env.DATABASE_URL = `postgresql://mp@127.0.0.1:55432/${DEV_DATABASE_NAME}`

    const rt = await createTestRuntime({ userId: "db-target-check" })
    try {
      expect(rt.config.databaseUrl).toBe(TEST_DB_URL)
    } finally {
      await rt.cleanup()
    }
  })
})
