import type { EmbeddingPort, MemoryStore } from "@memory-palace/core"
import { embeddingText } from "@memory-palace/core"

/**
 * Embedding maintenance.
 *
 * Changing embedding model is not a config edit alone: vectors from different
 * models live in different spaces and usually have different widths, so the
 * column has to change and every vector has to be recomputed. Without these two
 * operations that would be manual DDL, and "switch embedding model" would be a
 * thing nobody dares do.
 */

export interface ReembedResult {
  total: number
  embedded: number
  failed: number
  model: string
  dim: number
}

export interface ReembedOptions {
  /** How many memories to embed per provider call. */
  batchSize?: number
  /** Called after each batch, for progress output. */
  onProgress?: (done: number, total: number) => void
}

/**
 * Recompute embeddings for every memory.
 *
 * Idempotent by construction: it upserts per (memory, model), so running it
 * twice is harmless and an interrupted run can simply be started again.
 */
export async function reembedAll(
  store: MemoryStore,
  embeddings: EmbeddingPort,
  userId: string,
  options: ReembedOptions = {},
): Promise<ReembedResult> {
  const batchSize = options.batchSize ?? 16
  const memories = await store.listMemories(
    userId,
    { statuses: ["active", "pending", "superseded", "archived"] },
    { limit: 1_000_000 },
  )

  let embedded = 0
  let failed = 0

  for (let i = 0; i < memories.length; i += batchSize) {
    const batch = memories.slice(i, i + batchSize)
    try {
      const vectors = await embeddings.embed(batch.map((m) => embeddingText(m)))
      for (const [index, memory] of batch.entries()) {
        const vector = vectors[index]
        if (!vector) continue
        await store.upsertEmbedding({
          userId,
          memoryId: memory.id,
          model: embeddings.modelId,
          dim: embeddings.dim,
          vector,
        })
        embedded += 1
      }
    } catch (error) {
      // Keep going: a batch that fails should not abandon the other thousands.
      failed += batch.length
      process.stderr.write(
        `reembed: batch at ${i} failed — ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
    options.onProgress?.(Math.min(i + batchSize, memories.length), memories.length)
  }

  return {
    total: memories.length,
    embedded,
    failed,
    model: embeddings.modelId,
    dim: embeddings.dim,
  }
}

/** How many memories have a vector for a given model. */
export async function embeddingCoverage(
  store: MemoryStore,
  userId: string,
  model: string,
): Promise<{ withVector: number; total: number }> {
  const [withVector, total] = await Promise.all([
    store.countEmbeddings(userId, model),
    store.countMemories(userId, { statuses: ["active", "pending", "superseded", "archived"] }),
  ])
  return { withVector, total }
}
