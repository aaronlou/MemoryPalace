import { changeEmbeddingDim, readEmbeddingDim } from "@memory-palace/storage-pg"
import type { TestRuntime } from "@memory-palace/test-support"
import { createTestRuntime } from "@memory-palace/test-support"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Embedding-width administration.
 *
 * Changing embedding model is only safe if the schema width and the configured
 * width can be kept in step. `readEmbeddingDim` is what lets the application
 * check its own configuration against the database instead of trusting a
 * constant in the source, and `changeEmbeddingDim` is the supported way to move.
 *
 * These tests restore the width they started with, so they leave the deployment
 * exactly as they found it.
 */

let rt: TestRuntime

beforeAll(async () => {
  rt = await createTestRuntime({ userId: "dim-test-user" })
})

afterAll(async () => {
  await rt.cleanup()
})

describe("reading the declared width", () => {
  it("reports what the schema actually says", async () => {
    const dim = await readEmbeddingDim(rt.storage.db)
    expect(dim).toBe(rt.config.embedding.dim)
    expect(dim).toBeGreaterThan(0)
  })
})

describe("changing the width", () => {
  it("alters the column, discards stale vectors, and rebuilds the index", async () => {
    const original = (await readEmbeddingDim(rt.storage.db))!
    const target = original === 256 ? 320 : 256

    try {
      const result = await changeEmbeddingDim(rt.storage.db, target)
      expect(result.previous).toBe(original)
      expect(result.next).toBe(target)
      expect(await readEmbeddingDim(rt.storage.db)).toBe(target)

      // The HNSW index must still exist and still be usable at the new width —
      // dropping it is easy, forgetting to recreate it would silently turn every
      // semantic query into a sequential scan.
      const { rows } = await rt.storage.db.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'memory_embeddings_hnsw_idx'",
      )
      expect(rows[0]?.indexdef).toContain("hnsw")
    } finally {
      await changeEmbeddingDim(rt.storage.db, original)
      expect(await readEmbeddingDim(rt.storage.db)).toBe(original)
    }
  })

  it("refuses an absurd width instead of corrupting the schema", async () => {
    await expect(changeEmbeddingDim(rt.storage.db, 0)).rejects.toThrow(
      /invalid embedding dimension/,
    )
    await expect(changeEmbeddingDim(rt.storage.db, -5)).rejects.toThrow(
      /invalid embedding dimension/,
    )
    await expect(changeEmbeddingDim(rt.storage.db, 1.5)).rejects.toThrow(
      /invalid embedding dimension/,
    )
    await expect(changeEmbeddingDim(rt.storage.db, 999_999)).rejects.toThrow(
      /invalid embedding dimension/,
    )
    // And the schema is untouched.
    expect(await readEmbeddingDim(rt.storage.db)).toBe(rt.config.embedding.dim)
  })
})

describe("the runtime refuses to run against a mismatched schema", () => {
  it("explains the fix rather than failing on the first recall", async () => {
    const original = (await readEmbeddingDim(rt.storage.db))!
    const wrong = original === 128 ? 192 : 128
    await changeEmbeddingDim(rt.storage.db, wrong)

    // A runtime configured for the ORIGINAL width, against a schema now at `wrong`.
    const mismatched = await createTestRuntime({
      userId: "dim-mismatch-user",
      config: { embedding: { dim: original } },
    })
    try {
      await expect(mismatched.assertSchemaMatchesConfig()).rejects.toThrow(
        /vector\(128\)|vector\(192\)/,
      )
      await expect(mismatched.assertSchemaMatchesConfig()).rejects.toThrow(/pnpm embedding:dim/)
    } finally {
      await mismatched.cleanup()
      await changeEmbeddingDim(rt.storage.db, original)
      expect(await readEmbeddingDim(rt.storage.db)).toBe(original)
    }
  })
})
