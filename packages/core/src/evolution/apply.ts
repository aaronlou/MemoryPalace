import type { Clock, Logger } from "@memory-palace/shared"
import { newId } from "@memory-palace/shared"
import type { FormationPlan, PlannedAction } from "../formation/pipeline.js"
import type {
  ExtractionRun,
  Memory,
  MemoryEntityLink,
  MemoryRelation,
  WriteOutcome,
} from "../memory/types.js"
import { embeddingText } from "../policies.js"
import type { EmbeddingPort } from "../ports/llm.js"
import type { MemoryStore } from "../ports/storage.js"

export interface EvolutionDeps {
  store: MemoryStore
  embeddings: EmbeddingPort
  clock: Clock
  logger: Logger
}

/**
 * Applies a formation plan.
 *
 * Everything that mutates state happens inside one transaction, so a failure
 * halfway through can never leave a half-written memory — no memory with its
 * predecessor still active, no relation edge pointing at a row that was never
 * inserted.
 *
 * Embedding calls happen BEFORE the transaction opens: they are network calls,
 * and holding a database transaction open across them would serialise writes
 * behind the slowest provider.
 */
export async function applyFormationPlan(
  deps: EvolutionDeps,
  plan: FormationPlan,
): Promise<WriteOutcome> {
  const { store, embeddings, clock, logger } = deps
  const userId = plan.observation.userId
  const now = clock.now().toISOString()

  if (plan.deferred) {
    return {
      observationId: plan.observation.id,
      memories: [],
      relations: [],
      candidateCount: plan.candidateCount,
      deferred: true,
      runId: plan.runId,
      error: plan.error,
    }
  }

  if (plan.actions.length === 0) {
    await store.transaction(async (tx) => {
      await tx.setObservationStatus(userId, plan.observation.id, "processed")
      await tx.insertExtractionRun(makeRun(plan, 0, 0, now))
    })
    return {
      observationId: plan.observation.id,
      memories: [],
      relations: [],
      candidateCount: 0,
      deferred: false,
      runId: plan.runId,
    }
  }

  // --- phase 1: embed everything that needs a vector, outside the transaction --
  const toEmbed = plan.actions.filter(
    (a): a is Extract<PlannedAction, { kind: "create" | "refine" | "supersede" | "dispute" }> =>
      a.kind === "create" || a.kind === "refine" || a.kind === "supersede" || a.kind === "dispute",
  )
  const vectors = new Map<string, number[]>()
  if (toEmbed.length > 0) {
    try {
      const embedded = await embeddings.embed(toEmbed.map((a) => embeddingText(a.memory)))
      toEmbed.forEach((action, i) => {
        const vector = embedded[i]
        if (vector) vectors.set(action.memory.id, vector)
      })
    } catch (error) {
      // A missing vector degrades semantic recall but must not block the write;
      // lexical and entity routes still work, and a reindex can fill it later.
      logger.warn("embedding failed; memory will be written without a vector", {
        error: error instanceof Error ? error.message : String(error),
        count: toEmbed.length,
      })
    }
  }

  // --- phase 2: apply everything atomically ----------------------------------
  const written: Memory[] = []
  const relations: MemoryRelation[] = []

  await store.transaction(async (tx) => {
    for (const action of plan.actions) {
      switch (action.kind) {
        case "create": {
          await tx.insertMemory(action.memory)
          written.push(action.memory)
          await linkEntities(tx, action.memory, action.entityIds)
          await storeVector(tx, userId, action.memory, vectors, embeddings)
          break
        }

        case "refine": {
          // Same fact, better wording: the predecessor stops being the current
          // version but its VALID time is untouched, because the fact did not
          // change — only our description of it did.
          // Close the predecessor FIRST, then insert. The exclusion constraint
          // only tolerates two rows sharing a slot while at most one is active,
          // so inserting an overlapping refinement before retiring its
          // predecessor would be rejected. Both statements are in one
          // transaction, so no reader ever sees the intermediate state.
          await tx.markSupersededByRefinement(userId, action.targetId, { supersededAt: now })
          await tx.insertMemory(action.memory)
          written.push(action.memory)
          relations.push(
            makeRelation(userId, action.memory.id, action.targetId, "refines", action.reason, now),
          )
          await linkEntities(tx, action.memory, action.entityIds)
          await storeVector(tx, userId, action.memory, vectors, embeddings)
          break
        }

        case "reinforce": {
          await tx.reinforceMemory(userId, action.memoryId, {
            confidence: action.confidence,
            importance: action.importance,
            recordedAt: now,
          })
          break
        }

        case "supersede": {
          // The predecessor genuinely stopped being true: close its valid time at
          // the moment the new state began, so both intervals stay truthful.
          // Retire the superseded versions before inserting the replacement, for
          // the same reason as REFINE: the slot may only ever hold one active row.
          for (const targetId of action.targetIds) {
            await tx.supersedeMemory(userId, targetId, {
              validUntil: action.effectiveFrom,
              supersededAt: now,
              status: "superseded",
            })
            relations.push(
              makeRelation(userId, action.memory.id, targetId, "supersedes", action.reason, now),
            )
          }
          await tx.insertMemory(action.memory)
          written.push(action.memory)
          await linkEntities(tx, action.memory, action.entityIds)
          await storeVector(tx, userId, action.memory, vectors, embeddings)
          break
        }

        case "dispute": {
          // Unresolvable conflict: park BOTH sides in the confirmation queue
          // rather than picking a winner. Neither is silently trusted.
          const disputed: Memory = { ...action.memory, status: "pending" }
          await tx.insertMemory(disputed)
          for (const targetId of action.targetIds) {
            await tx.updateMemoryStatus(userId, [targetId], "pending")
            relations.push(
              makeRelation(userId, disputed.id, targetId, "contradicts", action.reason, now),
            )
          }
          written.push(disputed)
          await linkEntities(tx, disputed, action.entityIds)
          await storeVector(tx, userId, disputed, vectors, embeddings)
          break
        }
      }
    }

    if (relations.length > 0) await tx.insertRelations(relations)
    await tx.setObservationStatus(userId, plan.observation.id, "processed")
    await tx.insertExtractionRun(makeRun(plan, plan.candidateCount, written.length, now))
  })

  return {
    observationId: plan.observation.id,
    memories: written,
    relations,
    candidateCount: plan.candidateCount,
    deferred: false,
    runId: plan.runId,
  }
}

function makeRelation(
  userId: string,
  fromMemoryId: string,
  toMemoryId: string,
  kind: MemoryRelation["kind"],
  reason: string,
  now: string,
): MemoryRelation {
  return {
    id: newId("rel"),
    userId,
    fromMemoryId,
    toMemoryId,
    kind,
    reason,
    createdAt: now,
  }
}

function makeRun(
  plan: FormationPlan,
  candidates: number,
  written: number,
  now: string,
): ExtractionRun {
  return {
    id: plan.runId,
    userId: plan.observation.userId,
    observationId: plan.observation.id,
    promptVersion: plan.promptVersion,
    modelId: plan.modelId,
    inputTokens: plan.usage.inputTokens,
    outputTokens: plan.usage.outputTokens,
    costUsd: plan.usage.costUsd,
    latencyMs: plan.latencyMs,
    candidatesProduced: candidates,
    memoriesWritten: written,
    languageRetries: plan.languageRetries,
    createdAt: now,
  }
}

type TxStore = MemoryStore

async function linkEntities(tx: TxStore, memory: Memory, entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return
  const links: MemoryEntityLink[] = entityIds.map((entityId) => ({
    memoryId: memory.id,
    entityId,
  }))
  await tx.linkMemoryEntities(links)
}

async function storeVector(
  tx: TxStore,
  userId: string,
  memory: Memory,
  vectors: Map<string, number[]>,
  embeddings: EmbeddingPort,
): Promise<void> {
  const vector = vectors.get(memory.id)
  if (!vector) return
  await tx.upsertEmbedding({
    userId,
    memoryId: memory.id,
    model: embeddings.modelId,
    dim: embeddings.dim,
    vector,
  })
}
