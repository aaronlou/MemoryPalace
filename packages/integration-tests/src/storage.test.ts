import { createHash } from "node:crypto"
import type { Memory, Observation } from "@memory-palace/core"
import { ConflictError, newId } from "@memory-palace/shared"
import type { TestRuntime } from "@memory-palace/test-support"
import { createTestRuntime, truncateAll } from "@memory-palace/test-support"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

/**
 * Phase 1 acceptance tests.
 *
 * These exercise the storage semantics directly, with no LLM in the loop, so a
 * failure here means the temporal model is wrong rather than that a prompt is
 * wrong. That distinction is the whole reason the project stores *versions*
 * with two time axes instead of mutable rows.
 */

const USER = "temporal-test-user"
let rt: TestRuntime

beforeAll(async () => {
  rt = await createTestRuntime({ userId: USER, now: "2026-09-21T12:00:00.000Z" })
})

afterAll(async () => {
  await rt.cleanup()
})

beforeEach(async () => {
  await truncateAll(rt.storage.db)
})

function memory(overrides: Partial<Memory> & Pick<Memory, "content">): Memory {
  return {
    id: newId("mem"),
    userId: USER,
    type: "fact",
    confidence: 0.95,
    importance: 0.8,
    recordedAt: "2024-01-01T00:00:00.000Z",
    status: "active",
    reinforcedCount: 0,
    ...overrides,
  }
}

/** The canonical scenario from the design doc: React → Vue → back to React. */
async function seedTechTimeline(): Promise<{ react1: Memory; vue: Memory; react2: Memory }> {
  const store = rt.storage.store

  const react1 = memory({
    content: "用户使用 React",
    slotKey: "tech.frontend",
    validFrom: "2025-01-01T00:00:00.000Z",
    validUntil: "2026-01-01T00:00:00.000Z",
    recordedAt: "2025-01-05T00:00:00.000Z",
    supersededAt: "2026-01-05T00:00:00.000Z",
    status: "superseded",
  })
  const vue = memory({
    content: "用户使用 Vue",
    slotKey: "tech.frontend",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-03-01T00:00:00.000Z",
    recordedAt: "2026-01-05T00:00:00.000Z",
    supersededAt: "2027-03-02T00:00:00.000Z",
    status: "superseded",
  })
  const react2 = memory({
    content: "用户使用 React",
    slotKey: "tech.frontend",
    validFrom: "2027-03-01T00:00:00.000Z",
    recordedAt: "2027-03-02T00:00:00.000Z",
    status: "active",
  })

  await store.insertMemory(react1)
  await store.insertMemory(vue)
  await store.insertMemory(react2)
  await store.insertRelations([
    {
      id: newId("rel"),
      userId: USER,
      fromMemoryId: vue.id,
      toMemoryId: react1.id,
      kind: "supersedes",
      reason: "用户表示已转用 Vue",
      createdAt: "2026-01-05T00:00:00.000Z",
    },
    {
      id: newId("rel"),
      userId: USER,
      fromMemoryId: react2.id,
      toMemoryId: vue.id,
      kind: "supersedes",
      reason: "用户表示又用回 React",
      createdAt: "2027-03-02T00:00:00.000Z",
    },
  ])

  return { react1, vue, react2 }
}

describe("memory round-trip", () => {
  it("preserves every field", async () => {
    const store = rt.storage.store
    const original = memory({
      content: "用户正在学习 Effect-TS",
      type: "goal",
      summary: "学习 Effect-TS",
      slotKey: "learning.effect-ts",
      validFrom: "2026-09-01T00:00:00.000Z",
      confidence: 0.92,
      importance: 0.85,
      originObservationId: undefined,
      agentId: "test-agent",
      metadata: { taskType: "learning" },
    })

    await store.insertMemory(original)
    const loaded = await store.getMemory(USER, original.id)

    expect(loaded).not.toBeNull()
    expect(loaded!.content).toBe(original.content)
    expect(loaded!.type).toBe("goal")
    expect(loaded!.summary).toBe("学习 Effect-TS")
    expect(loaded!.confidence).toBeCloseTo(0.92)
    expect(loaded!.validFrom).toBe(original.validFrom)
    expect(loaded!.validUntil).toBeUndefined()
    expect(loaded!.agentId).toBe("test-agent")
    expect(loaded!.metadata).toEqual({ taskType: "learning" })
  })

  it("scopes reads by user", async () => {
    const store = rt.storage.store
    const m = memory({ content: "用户使用 React" })
    await store.insertMemory(m)
    expect(await store.getMemory("someone-else", m.id)).toBeNull()
  })
})

describe("valid-time travel — 'what was true then'", () => {
  it("answers the design doc's React → Vue → React scenario", async () => {
    await seedTechTimeline()
    const store = rt.storage.store

    const y2025 = await store.findValidAt(USER, "2025-06-01T00:00:00.000Z")
    const y2026 = await store.findValidAt(USER, "2026-06-01T00:00:00.000Z")
    const y2027 = await store.findValidAt(USER, "2027-06-01T00:00:00.000Z")

    expect(y2025.map((m) => m.content)).toEqual(["用户使用 React"])
    expect(y2026.map((m) => m.content)).toEqual(["用户使用 Vue"])
    // The 2027 answer is the THIRD version, not the first one resurrected.
    expect(y2027.map((m) => m.content)).toEqual(["用户使用 React"])
    expect(y2027[0]?.id).not.toBe(y2025[0]?.id)
  })

  it("treats the interval as half-open [from, until)", async () => {
    await seedTechTimeline()
    const store = rt.storage.store
    // Exactly at the boundary the NEW state holds; the old one has ended.
    const atBoundary = await store.findValidAt(USER, "2026-01-01T00:00:00.000Z")
    expect(atBoundary.map((m) => m.content)).toEqual(["用户使用 Vue"])
  })

  it("returns the version that was true then, even though it is superseded now", async () => {
    const { react1, vue, react2 } = await seedTechTimeline()
    const store = rt.storage.store

    // Vue is superseded TODAY, but in 2026-06 it was the truth. Answering
    // historical questions is the entire reason versions are kept, so a
    // historical lookup must not be silently narrowed to currently-active rows.
    const in2026 = await store.findValidAt(USER, "2026-06-01T00:00:00.000Z")
    expect(in2026.map((m) => m.id)).toEqual([vue.id])

    const in2025 = await store.findValidAt(USER, "2025-06-01T00:00:00.000Z")
    expect(in2025.map((m) => m.id)).toEqual([react1.id])

    // An explicit status filter is honoured literally: nothing we CURRENTLY
    // believe was already true in 2026-06 in this timeline.
    const activeOnly = await store.findValidAt(USER, "2026-06-01T00:00:00.000Z", {
      statuses: ["active"],
    })
    expect(activeOnly).toEqual([])

    const all = await store.listMemories(USER, {})
    expect(new Set(all.map((m) => m.id))).toEqual(new Set([react1.id, vue.id, react2.id]))
    expect(react2.status).toBe("active")
  })
})

describe("transaction-time travel — 'what did we believe then'", () => {
  it("distinguishes when a fact was true from when we learned it", async () => {
    await seedTechTimeline()
    const store = rt.storage.store

    // In mid-2026 we believed Vue was the current technology.
    const believedIn2026 = await store.findBelievedAt(
      USER,
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    )
    expect(believedIn2026.map((m) => m.content)).toEqual(["用户使用 Vue"])

    // By mid-2026 we had already learned React was over, so we make NO claim
    // about mid-2025 any more. A single-timeline model cannot express this.
    const retro = await store.findBelievedAt(
      USER,
      "2025-06-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    )
    expect(retro).toHaveLength(0)

    // But as of mid-2025 we did believe React.
    const asOf2025 = await store.findBelievedAt(
      USER,
      "2025-06-01T00:00:00.000Z",
      "2025-06-01T00:00:00.000Z",
    )
    expect(asOf2025.map((m) => m.content)).toEqual(["用户使用 React"])
  })

  it("does not filter on status, because status is the CURRENT projection", async () => {
    const { vue } = await seedTechTimeline()
    const store = rt.storage.store
    // Vue is superseded today, but it was active in 2026. Filtering on the
    // current status here would erase exactly the history being asked for.
    const believed = await store.findBelievedAt(
      USER,
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    )
    expect(believed.map((m) => m.id)).toEqual([vue.id])
  })
})

describe("evolution chain", () => {
  it("reconstructs the full history oldest-first", async () => {
    const { react1, vue, react2 } = await seedTechTimeline()
    const chain = await rt.storage.store.supersedesChain(USER, react2.id)

    expect(chain.map((m) => m.id)).toEqual([react1.id, vue.id, react2.id])
    expect(chain.map((m) => m.content)).toEqual([
      "用户使用 React",
      "用户使用 Vue",
      "用户使用 React",
    ])
  })

  it("stops at the beginning of the chain", async () => {
    const { react1 } = await seedTechTimeline()
    const chain = await rt.storage.store.supersedesChain(USER, react1.id)
    expect(chain.map((m) => m.id)).toEqual([react1.id])
  })

  it("preserves the reason for each change", async () => {
    const { react2 } = await seedTechTimeline()
    const relations = await rt.storage.store.relationsFrom(USER, [react2.id], "supersedes")
    expect(relations[0]?.reason).toBe("用户表示又用回 React")
  })
})

describe("database-enforced mutual exclusion", () => {
  it("rejects two active memories claiming the same slot over overlapping time", async () => {
    const store = rt.storage.store
    await store.insertMemory(
      memory({
        content: "用户使用 React",
        slotKey: "tech.frontend",
        validFrom: "2025-01-01T00:00:00.000Z",
      }),
    )

    // The rule is enforced by a GiST exclusion constraint, not by application
    // code, so no write path can bypass it.
    await expect(
      store.insertMemory(
        memory({
          content: "用户使用 Vue",
          slotKey: "tech.frontend",
          validFrom: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(ConflictError)
  })

  it("allows a non-overlapping successor in the same slot", async () => {
    const store = rt.storage.store
    const first = memory({
      content: "用户使用 React",
      slotKey: "tech.frontend",
      validFrom: "2025-01-01T00:00:00.000Z",
    })
    await store.insertMemory(first)
    await store.supersedeMemory(USER, first.id, {
      validUntil: "2026-01-01T00:00:00.000Z",
      supersededAt: "2026-01-05T00:00:00.000Z",
    })
    await expect(
      store.insertMemory(
        memory({
          content: "用户使用 Vue",
          slotKey: "tech.frontend",
          validFrom: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("allows overlapping validity when no slot is declared", async () => {
    const store = rt.storage.store
    await store.insertMemory(
      memory({ content: "用户使用 React", validFrom: "2025-01-01T00:00:00.000Z" }),
    )
    await expect(
      store.insertMemory(
        memory({ content: "用户喜欢咖啡", validFrom: "2025-06-01T00:00:00.000Z" }),
      ),
    ).resolves.toBeUndefined()
  })
})

describe("status projection stays consistent with relation edges", () => {
  it("derives the same status the projector stored", async () => {
    await seedTechTimeline()
    const { rows } = await rt.storage.db.query<{
      id: string
      stored: string
      derived: string
    }>(
      `SELECT m.id,
              m.status AS stored,
              CASE WHEN EXISTS (
                SELECT 1 FROM memory_relations r
                 WHERE r.to_memory_id = m.id AND r.kind IN ('supersedes','refines')
              ) THEN 'superseded' ELSE 'active' END AS derived
         FROM memories m WHERE m.user_id = $1`,
      [USER],
    )
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.stored).toBe(row.derived)
    }
  })
})

describe("refinement keeps the validity range intact", () => {
  it("changes the wording without changing when the fact was true", async () => {
    const store = rt.storage.store
    const original = memory({
      content: "用户在学习 Effect-TS",
      type: "goal",
      validFrom: "2026-01-01T00:00:00.000Z",
    })
    await store.insertMemory(original)

    const refined = memory({
      content: "用户正在系统地学习 Effect-TS，重点是类型系统",
      type: "goal",
      validFrom: original.validFrom,
      recordedAt: "2026-02-01T00:00:00.000Z",
    })
    await store.insertMemory(refined)
    await store.markSupersededByRefinement(USER, original.id, {
      supersededAt: "2026-02-01T00:00:00.000Z",
    })

    const old = await store.getMemory(USER, original.id)
    const current = await store.getMemory(USER, refined.id)

    // The predecessor is no longer current, but it is NOT invalidated: the fact
    // still held, only our description of it improved.
    expect(old!.status).toBe("superseded")
    expect(old!.validUntil).toBeUndefined()
    expect(current!.validFrom).toBe("2026-01-01T00:00:00.000Z")

    const valid = await store.findValidAt(USER, "2026-06-01T00:00:00.000Z")
    expect(valid.map((m) => m.id)).toEqual([refined.id])
  })

  it("does not report a reworded predecessor twice", async () => {
    const store = rt.storage.store
    const original = memory({
      content: "用户使用 React",
      validFrom: "2025-01-01T00:00:00.000Z",
    })
    await store.insertMemory(original)
    const refined = memory({
      content: "用户使用 React 18",
      validFrom: "2025-01-01T00:00:00.000Z",
    })
    // Retire first, then insert — the order the persistence stage uses.
    await store.markSupersededByRefinement(USER, original.id, {
      supersededAt: "2025-02-01T00:00:00.000Z",
    })
    await store.insertMemory(refined)

    // Both rows cover 2025-06. Only the better-worded one may be returned,
    // otherwise every refinement would double-report the same fact.
    const valid = await store.findValidAt(USER, "2025-06-01T00:00:00.000Z")
    expect(valid.map((m) => m.id)).toEqual([refined.id])

    // An explicit "give me history" request still sees both.
    const full = await store.findValidAt(USER, "2025-06-01T00:00:00.000Z", {
      statuses: ["active", "superseded"],
    })
    expect(new Set(full.map((m) => m.id))).toEqual(new Set([original.id, refined.id]))
  })

  it("tolerates a refinement in a slot alongside the original", async () => {
    // This is why the exclusion constraint is scoped to status = 'active': a
    // refinement deliberately overlaps its predecessor's validity.
    const store = rt.storage.store
    const original = memory({
      content: "用户使用 React",
      slotKey: "tech.frontend",
      validFrom: "2025-01-01T00:00:00.000Z",
    })
    await store.insertMemory(original)
    const refined = memory({
      content: "用户使用 React 18",
      slotKey: "tech.frontend",
      validFrom: "2025-01-01T00:00:00.000Z",
    })
    // Retire the predecessor before inserting, or the slot would briefly hold
    // two active rows and the exclusion constraint would reject the write.
    await store.markSupersededByRefinement(USER, original.id, {
      supersededAt: "2025-02-01T00:00:00.000Z",
    })
    await store.insertMemory(refined)
    expect((await store.getMemory(USER, refined.id))!.status).toBe("active")
  })
})

describe("reinforcement mutates assessment, never the claim", () => {
  it("raises confidence and counts sightings without a new version", async () => {
    const store = rt.storage.store
    const m = memory({ content: "用户喜欢先理解架构", type: "preference", confidence: 0.7 })
    await store.insertMemory(m)

    await store.reinforceMemory(USER, m.id, {
      confidence: 0.95,
      importance: 0.9,
      recordedAt: "2026-10-01T00:00:00.000Z",
    })

    const loaded = await store.getMemory(USER, m.id)
    expect(loaded!.confidence).toBeCloseTo(0.95)
    expect(loaded!.reinforcedCount).toBe(1)
    expect(loaded!.lastSeenAt).toBe("2026-10-01T00:00:00.000Z")
    // Still exactly one row: re-observing is not a new version.
    expect(await store.countMemories(USER, {})).toBe(1)
  })

  it("never lowers confidence on a weaker sighting", async () => {
    const store = rt.storage.store
    const m = memory({ content: "用户喜欢先理解架构", type: "preference", confidence: 0.9 })
    await store.insertMemory(m)
    await store.reinforceMemory(USER, m.id, {
      confidence: 0.5,
      recordedAt: "2026-10-01T00:00:00.000Z",
    })
    expect((await store.getMemory(USER, m.id))!.confidence).toBeCloseTo(0.9)
  })
})

describe("observation idempotency", () => {
  function observation(content: string): Observation {
    return {
      id: newId("obs"),
      userId: USER,
      content,
      sourceKind: "user",
      occurredAt: "2026-09-21T12:00:00.000Z",
      createdAt: "2026-09-21T12:00:00.000Z",
      status: "pending",
    }
  }

  it("ignores a duplicate observation", async () => {
    const store = rt.storage.store
    await store.insertObservation(observation("我最近开始学习 Effect-TS"))
    await store.insertObservation(observation("我最近开始学习 Effect-TS"))
    expect(await store.countObservations(USER)).toBe(1)
  })

  it("can be looked up by content hash after insertion", async () => {
    const store = rt.storage.store
    await store.insertObservation(observation("hello world"))
    const hash = createHash("sha256").update("hello world").digest("hex")
    expect(await store.findObservationByHash(USER, hash)).not.toBeNull()
  })
})

describe("embeddings are per-model, so models can coexist", () => {
  it("stores two models for one memory independently", async () => {
    const store = rt.storage.store
    const m = memory({ content: "用户使用 React" })
    await store.insertMemory(m)

    // The width is a deployment property, so build vectors at the schema's
    // width rather than a literal.
    const dim = rt.config.embedding.dim
    const v1 = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0))
    const v2 = Array.from({ length: dim }, (_, i) => (i === 1 ? 1 : 0))

    await store.upsertEmbedding({
      userId: USER,
      memoryId: m.id,
      model: "model-a",
      dim,
      vector: v1,
    })
    await store.upsertEmbedding({
      userId: USER,
      memoryId: m.id,
      model: "model-b",
      dim,
      vector: v2,
    })

    expect((await store.listEmbeddingModels(USER)).sort()).toEqual(["model-a", "model-b"])
    expect(await store.countEmbeddings(USER, "model-a")).toBe(1)
    expect(await store.countEmbeddings(USER, "model-b")).toBe(1)
  })

  it("cascades embeddings away when a memory is deleted", async () => {
    const store = rt.storage.store
    const m = memory({ content: "用户使用 React" })
    await store.insertMemory(m)
    await store.upsertEmbedding({
      userId: USER,
      memoryId: m.id,
      model: "model-a",
      dim: rt.config.embedding.dim,
      vector: Array.from({ length: rt.config.embedding.dim }, () => 0),
    })
    await store.deleteMemories(USER, [m.id])
    expect(await store.countEmbeddings(USER, "model-a")).toBe(0)
  })
})

describe("entity resolution keys", () => {
  it("merges spelling variants into one entity", async () => {
    const store = rt.storage.store
    const a = await store.upsertEntity({
      id: newId("ent"),
      userId: USER,
      canonicalName: "Effect-TS",
      kind: "technology",
      aliases: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const b = await store.upsertEntity({
      id: newId("ent"),
      userId: USER,
      canonicalName: "effect ts",
      kind: "technology",
      aliases: [],
      createdAt: "2026-01-02T00:00:00.000Z",
    })
    expect(b.id).toBe(a.id)
    expect(await store.countEntities(USER)).toBe(1)
  })

  it("finds an entity by any of its aliases", async () => {
    const store = rt.storage.store
    await store.upsertEntity({
      id: newId("ent"),
      userId: USER,
      canonicalName: "PostgreSQL",
      kind: "technology",
      aliases: ["postgres"],
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const found = await store.findEntitiesByNames(USER, ["Postgres"])
    expect(found).toHaveLength(1)
    expect(found[0]?.canonicalName).toBe("PostgreSQL")
  })
})

describe("transactions roll back cleanly", () => {
  it("leaves no partial writes when the callback throws", async () => {
    const store = rt.storage.store
    const m = memory({ content: "用户使用 React" })

    await expect(
      store.transaction(async (tx) => {
        await tx.insertMemory(m)
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    expect(await store.getMemory(USER, m.id)).toBeNull()
    expect(await store.countMemories(USER, {})).toBe(0)
  })
})
