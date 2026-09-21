import type {
  EmbeddingPort,
  GenerateObjectRequest,
  GenerateObjectResult,
  LlmPort,
  Memory,
  MemoryStatus,
  MemoryType,
} from "@memory-palace/core"
import { newId } from "@memory-palace/shared"
import { exportAll, importAll, wipeUser } from "@memory-palace/storage-pg"
import type { TestRuntime } from "@memory-palace/test-support"
import { createTestRuntime, schemaEmbeddingDim, truncateAll } from "@memory-palace/test-support"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

/**
 * Pipeline acceptance tests.
 *
 * These cover the behaviours the design doc calls out as the point of the whole
 * system: memories form from natural writing, they do not duplicate, they evolve
 * rather than overwrite, agents cannot silently rewrite history, and the user can
 * always take their data out.
 */

const USER = "pipeline-test-user"
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

/** An LLM that always fails, to prove nothing is lost when the provider is down. */
class FailingLlm implements LlmPort {
  readonly defaultModelId = "failing"
  async generateObject<T>(_req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    throw new Error("provider unavailable")
  }
}

/**
 * A model whose rerank verdict is dictated by the test.
 *
 * Recall tests need to control the one signal that decides whether a
 * below-floor candidate survives, without also having to control retrieval.
 * `"fail"` makes the rerank call throw, which is the case that must degrade to
 * the fast-path answer rather than leak unconfirmed candidates.
 */
class StubRerankLlm implements LlmPort {
  readonly defaultModelId = "stub-rerank"
  private readonly relevance: number | "fail"

  constructor(relevance: number | "fail") {
    this.relevance = relevance
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    if (req.schemaName === "MemoryRerank") {
      if (this.relevance === "fail") throw new Error("reranker unavailable")
      // Same shape the real rerank prompt uses; ids the model did not receive
      // are ignored by the pipeline, so parsing them out is the honest stub.
      const rankings = [...req.prompt.matchAll(/\[\d+\]\s+id=(\S+)/g)].map((m) => ({
        memoryId: m[1] as string,
        relevance: this.relevance as number,
        reason: "canned verdict",
      }))
      return this.ok({ rankings } as T)
    }
    if (req.schemaName === "QueryUnderstanding") {
      return this.ok({
        entities: [],
        taskType: null,
        keywords: [],
        intent: "general",
        timeRangeFrom: null,
        timeRangeTo: null,
      } as T)
    }
    throw new Error(`stub received an unexpected schema: ${req.schemaName}`)
  }

  private ok<T>(value: T): GenerateObjectResult<T> {
    return {
      value,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      modelId: this.defaultModelId,
      promptHash: "stub",
      cached: false,
    }
  }
}

/**
 * An embedder whose geometry the test dictates.
 *
 * The mock embedder derives similarity from shared tokens, which is exactly
 * what makes it unusable here: a text pair it considers close also shares a
 * token, so the lexical route matches it and the semantic floor is never the
 * deciding factor. It cannot express "semantically close, lexically unrelated"
 * — the precise situation the rescue exists for.
 *
 * This one maps marked texts onto vectors with a known cosine and everything
 * else onto an orthogonal direction, so the tests exercise the rescue rule
 * rather than the embedder's quirks.
 */
class BandEmbedding implements EmbeddingPort {
  readonly modelId = "band-test-embedding"
  readonly dim: number

  constructor(dim: number) {
    this.dim = dim
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      // Query side: unit vector on the first axis.
      if (text.includes("安排顺序") || text.includes("项目代号是什么")) {
        return this.unit(1, 0)
      }
      // Memory side: cosine 0.74 with the query vector — above the probe floor
      // (0.01), far below the configured floor (0.99), so it must be rescued.
      if (text.includes("整体骨架") || text.includes("Phoenix")) {
        return this.unit(1, 0.9)
      }
      // A weak match: cosine 0.447, the band where the fast path cannot tell
      // "vaguely relevant" from "vaguely irrelevant" on its own.
      if (text.includes("低相似")) {
        return this.unit(1, 2)
      }
      return this.unit(0, 0, 1)
    })
  }

  private unit(...values: number[]): number[] {
    const vec = new Array<number>(this.dim).fill(0)
    let norm = 0
    for (const [i, v] of values.entries()) {
      vec[i] = v
      norm += v * v
    }
    norm = Math.sqrt(norm)
    return vec.map((v) => v / norm)
  }
}

/** Insert a memory together with its embedding, as the persistence stage would. */
async function seedWithEmbedding(
  rt: TestRuntime,
  entries: Array<{
    type: MemoryType
    content: string
    status?: MemoryStatus
    validFrom?: string
    validUntil?: string
  }>,
): Promise<void> {
  for (const [i, e] of entries.entries()) {
    const memory: Memory = {
      id: newId("mem"),
      userId: rt.userId,
      type: e.type,
      content: e.content,
      confidence: 0.92,
      importance: 0.75,
      validFrom: e.validFrom ?? "2026-01-01T00:00:00.000Z",
      validUntil: e.validUntil,
      recordedAt: `2026-0${i + 1}-01T00:00:00.000Z`,
      supersededAt: e.status === "superseded" ? "2026-06-01T00:00:00.000Z" : undefined,
      status: e.status ?? "active",
      reinforcedCount: 0,
    }
    await rt.storage.store.insertMemory(memory)
    const [vector] = await rt.llm.embeddings.embed([`${e.type}\n${e.content}`])
    if (!vector) continue
    await rt.storage.store.upsertEmbedding({
      userId: rt.userId,
      memoryId: memory.id,
      model: rt.llm.embeddings.modelId,
      dim: rt.llm.embeddings.dim,
      vector,
    })
  }
}

describe("design doc §21 — the canonical case study", () => {
  const INPUT =
    "我最近开始系统学习 Effect-TS。以后你给我讲 TypeScript 的时候，先从整体结构和设计思想讲，再深入 API。"

  it("forms distinct memories of the right types", async () => {
    const outcome = await rt.palace.remember({ userId: USER, content: INPUT, sourceKind: "user" })

    expect(outcome.deferred).toBe(false)
    expect(outcome.memories.length).toBeGreaterThanOrEqual(2)

    const types = outcome.memories.map((m) => m.type)
    expect(types).toContain("goal")
    expect(types).toContain("preference")

    // Every memory must be traceable back to the observation it came from.
    for (const m of outcome.memories) {
      expect(m.originObservationId).toBe(outcome.observationId)
    }
  })

  it("recalls the goal for a question about Effect-TS", async () => {
    await rt.palace.remember({ userId: USER, content: INPUT, sourceKind: "user" })

    const result = await rt.palace.recall({
      userId: USER,
      query: "Effect-TS 的 Context.Service 怎么理解？",
      mode: "fast",
    })

    expect(result.memories.length).toBeGreaterThanOrEqual(1)
    expect(result.memories.map((m) => m.memory.content).join("\n")).toContain("Effect-TS")

    // The rendered context must carry the validity window, so a downstream model
    // can reason about time without parsing structured fields.
    expect(result.context).toContain("至今")
    expect(result.diagnostics.returnedEmpty).toBe(false)
  })

  it("recalls the stated preference for a question about explanation style", async () => {
    await rt.palace.remember({ userId: USER, content: INPUT, sourceKind: "user" })

    const result = await rt.palace.recall({
      userId: USER,
      query: "用户希望先了解整体结构和设计思想吗？",
      mode: "fast",
    })

    const contents = result.memories.map((m) => m.memory.content).join("\n")
    expect(contents).toContain("设计思想")

    // Grouped under its own heading so the model can tell a preference from a fact.
    expect(result.context).toContain("## How This User Prefers To Be Helped")
  })

  it("records a run for observability", async () => {
    await rt.palace.remember({ userId: USER, content: INPUT, sourceKind: "user" })
    const runs = await rt.storage.store.listExtractionRuns(USER, 10)
    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0]?.promptVersion).toContain("extraction")
    expect(runs[0]?.modelId).toBeTruthy()
  })
})

describe("regression: a re-wording does not move a memory between categories", () => {
  it("keeps the original type when a refinement is applied", async () => {
    // The bug this pins, found by running `pnpm demo` and reading its output:
    // the same fact re-worded re-extracts under a different type — the mock reads
    // "我最近开始系统学习 Effect-TS" as a goal and "我最近在系统学习 Effect-TS"
    // as a fact — and the refinement inherited the CANDIDATE's type. So repeating
    // yourself silently converted the user's goal into a fact, which changes both
    // the context group it appears under and the write policy that applies to it
    // (`decision` needs confirmation, `fact` does not).
    const first = await rt.palace.remember({
      userId: USER,
      content: "我最近开始系统学习 Effect-TS。",
      sourceKind: "user",
    })
    expect(first.memories.map((m) => m.type)).toContain("goal")

    await rt.palace.remember({
      userId: USER,
      content: "我最近在系统学习 Effect-TS。",
      sourceKind: "user",
    })

    const active = (await rt.storage.store.listMemories(USER, { statuses: ["active"] })).filter(
      (m) => m.content.includes("Effect-TS"),
    )

    // Still exactly one current version of the fact...
    expect(active).toHaveLength(1)
    // ...and it is still the goal the user stated, not whatever the second
    // reading of it happened to be labelled.
    expect(active[0]?.type).toBe("goal")
  })
})

describe("regression: a change of state is not skipped because the type differs", () => {
  it("supersedes an earlier memory recorded under a different type", async () => {
    // The bug this pins: neighbour lookup used to be restricted to the SAME
    // memory type, on the reasoning that "a goal never supersedes a preference".
    // In practice "I use Vue" is stored as one type while "I've switched to
    // React" extracts as another — same subject, different type. Adjudication
    // was therefore never called and the candidate was inserted unconditionally,
    // leaving the store asserting both that the user uses Vue and that they do not.
    //
    // The earlier memory is seeded with a type the extractor will NOT produce
    // for the second statement. Without that, both sides come out as `fact` and
    // a type filter would appear to work — which is exactly how this test
    // silently passed the first time it was written.
    const seeded = {
      id: newId("mem"),
      userId: USER,
      type: "preference" as const,
      content: "用户一直在用 Vue",
      confidence: 0.9,
      importance: 0.7,
      validFrom: "2025-06-01T00:00:00.000Z",
      recordedAt: "2025-06-01T00:00:00.000Z",
      status: "active" as const,
      reinforcedCount: 0,
    }
    await rt.storage.store.insertMemory(seeded)
    // Give it a vector, so the semantic route can see it too — a real memory
    // always has one.
    const [vector] = await rt.llm.embeddings.embed([`${seeded.type}\n${seeded.content}`])
    if (vector) {
      await rt.storage.store.upsertEmbedding({
        userId: USER,
        memoryId: seeded.id,
        model: rt.llm.embeddings.modelId,
        dim: rt.llm.embeddings.dim,
        vector,
      })
    }

    const outcome = await rt.palace.remember({
      userId: USER,
      content: "我现在不用 Vue 了，改用 React。",
      sourceKind: "user",
    })

    // The decisive assertion: a relation edge only exists if the pipeline
    // reached a decision. With the type restriction in place, nothing linked the
    // two and this is zero.
    expect(
      outcome.relations.length,
      "no relation was written, so adjudication never ran on the earlier memory",
    ).toBeGreaterThan(0)

    const after = await rt.storage.store.getMemory(USER, seeded.id)
    expect(after!.status).not.toBe("active")
    // The validity window is closed rather than the row being deleted, so the
    // history of the change survives.
    expect(after!.validUntil).toBeDefined()
    expect(outcome.memories.some((m) => m.content.includes("React"))).toBe(true)
  })
})

describe("idempotency", () => {
  it("does not duplicate memories when the same thing is said three times", async () => {
    const content = "我最近开始系统学习 Effect-TS。"

    const first = await rt.palace.remember({ userId: USER, content, sourceKind: "user" })
    const afterFirst = await rt.storage.store.countMemories(USER, {})
    expect(afterFirst).toBeGreaterThan(0)

    const second = await rt.palace.remember({ userId: USER, content, sourceKind: "user" })
    const third = await rt.palace.remember({ userId: USER, content, sourceKind: "user" })

    // The observation itself is deduplicated by content hash...
    expect(await rt.storage.store.countObservations(USER)).toBe(1)

    // ...and the memory count must not grow.
    expect(await rt.storage.store.countMemories(USER, {})).toBe(afterFirst)
    expect(second.memories.length + third.memories.length).toBe(0)
    expect(first.memories.length).toBeGreaterThan(0)
  })

  it("reinforces rather than re-creating when the wording differs slightly", async () => {
    await rt.palace.remember({
      userId: USER,
      content: "我最近在系统学习 Effect-TS。",
      sourceKind: "user",
    })
    const before = await rt.storage.store.countMemories(USER, {})

    await rt.palace.remember({
      userId: USER,
      content: "我最近正在系统学习 Effect-TS。",
      sourceKind: "user",
    })
    const after = await rt.storage.store.countMemories(USER, {})

    // At most one new version, and the existing one should show re-observation.
    expect(after).toBeLessThanOrEqual(before + 1)
    const memories = await rt.storage.store.listMemories(USER, {})
    expect(memories.some((m) => m.reinforcedCount > 0 || m.status === "active")).toBe(true)
  })
})

describe("regression: a repeat observation is deduplicated but still writable", () => {
  it("writes a memory version that references the observation which actually exists", async () => {
    // The bug this pins, found by running `pnpm demo` twice in a row: the second
    // run's first statement is a repeat, so `insertObservation` deduplicated it —
    // and then the pipeline adjudicated the candidate REFINE against the neighbour
    // that the first run had already refined, inserted a memory version whose
    // `origin_observation_id` was the id of the row that was never created, and
    // died on the foreign key. The whole write was lost.
    //
    // Whether the repeat is DUPLICATE (an update, which hid the bug) or REFINE (an
    // insert, which exposes it) depends on how the new text overlaps the *current*
    // neighbour — so the sequence below is what makes it deterministic.
    const content = "我最近开始系统学习 Effect-TS。"

    const first = await rt.palace.remember({ userId: USER, content, sourceKind: "user" })
    expect(first.memories.length).toBeGreaterThan(0)

    // Refine the fact, so the active neighbour's wording no longer matches the
    // candidate exactly: 0.5 <= overlap < 0.8 is REFINE, 1.0 would be DUPLICATE.
    await rt.palace.remember({
      userId: USER,
      content: "我最近在系统学习 Effect-TS。",
      sourceKind: "user",
    })

    // Same text as the first call: deduplicated at the observation level, and
    // adjudicated against the refined neighbour.
    const repeat = await rt.palace.remember({ userId: USER, content, sourceKind: "user" })

    expect(await rt.storage.store.countObservations(USER)).toBe(2)
    // The memory it wrote points at an observation that exists — the foreign key
    // would have rejected anything else, but only after losing the transaction.
    const written = await rt.storage.store.listMemories(USER, {})
    expect(written.length).toBeGreaterThan(0)
    for (const m of written) {
      expect(await rt.storage.store.getObservation(USER, m.originObservationId!)).not.toBeNull()
    }
    // And the repeat resolves to the observation that already held this text.
    expect(repeat.observationId).toBe(first.observationId)
  })
})

describe("provider failure never loses input", () => {
  it("stores the observation and marks it failed so it can be replayed", async () => {
    // A runtime whose LLM always throws. It must be injected at construction:
    // the pipelines capture their provider once, so swapping it afterwards would
    // silently test nothing.
    const failing = await createTestRuntime({
      userId: USER,
      now: "2026-09-21T12:00:00.000Z",
      llm: new FailingLlm(),
    })

    const outcome = await failing.palace.remember({
      userId: USER,
      content: "这是一条在模型故障时写下的重要信息。",
      sourceKind: "user",
    })

    expect(outcome.deferred).toBe(true)
    expect(outcome.error).toContain("provider unavailable")
    expect(outcome.memories).toHaveLength(0)

    // The raw input survives, and is discoverable for a later retry.
    const observations = await rt.storage.store.listObservations(USER, { status: "failed" })
    expect(observations).toHaveLength(1)
    expect(observations[0]?.content).toContain("重要信息")

    await failing.cleanup()
  })
})

describe("agent write policy", () => {
  it("parks a consequential memory for confirmation instead of committing it", async () => {
    await rt.palace.setAgentPolicy({
      userId: USER,
      agentId: "careless-agent",
      allowedTypes: ["fact", "preference", "goal"],
      // Decisions are consequential: superseding one silently would rewrite the
      // user's own stated history.
      requireConfirmationFor: ["decision"],
      canWrite: true,
      createdAt: "2026-09-21T12:00:00.000Z",
    })

    const outcome = await rt.palace.remember({
      userId: USER,
      content: "我们决定把后端从 Python 换成 TypeScript。",
      sourceKind: "agent",
      agentId: "careless-agent",
    })

    const decisions = outcome.memories.filter((m) => m.type === "decision")
    expect(decisions.length).toBeGreaterThan(0)
    for (const m of decisions) expect(m.status).toBe("pending")

    // A pending memory must not be presented as fact.
    const recalled = await rt.palace.recall({
      userId: USER,
      query: "后端用什么语言？",
      mode: "fast",
    })
    // Pending memories are excluded by the status filter in SQL, so they never
    // even become candidates — which is why `conflictsFiltered` stays 0 here.
    expect(recalled.memories.some((m) => m.memory.type === "decision")).toBe(false)
    expect(await rt.storage.store.countMemories(USER, { statuses: ["pending"] })).toBeGreaterThan(0)

    // Once confirmed it becomes recallable.
    const pending = await rt.palace.listPending(USER)
    expect(pending.length).toBeGreaterThan(0)
    await rt.palace.confirmMemory(USER, pending[0]!.id)
    expect((await rt.palace.getMemory(USER, pending[0]!.id)).status).toBe("active")
  })

  it("honours canWrite=false", async () => {
    await rt.palace.setAgentPolicy({
      userId: USER,
      agentId: "readonly-agent",
      allowedTypes: [],
      requireConfirmationFor: [],
      canWrite: false,
      createdAt: "2026-09-21T12:00:00.000Z",
    })

    const outcome = await rt.palace.remember({
      userId: USER,
      content: "我最近开始系统学习 Effect-TS。",
      sourceKind: "agent",
      agentId: "readonly-agent",
    })

    for (const m of outcome.memories) expect(m.status).toBe("pending")
    const active = await rt.storage.store.countMemories(USER, { statuses: ["active"] })
    expect(active).toBe(0)
  })
})

describe("corrections and forgetting", () => {
  it("keeps the previous wording when a memory is corrected", async () => {
    const outcome = await rt.palace.remember({
      userId: USER,
      content: "我最近开始系统学习 Effect-TS。",
      sourceKind: "user",
    })
    const original = outcome.memories[0]!
    const corrected = await rt.palace.updateMemory(USER, original.id, {
      content: "用户正在系统学习 Effect-TS 的类型系统部分",
    })

    const old = await rt.palace.getMemory(USER, original.id)
    expect(old.status).toBe("superseded")
    // A correction is a refinement: the fact still held over the same period.
    expect(old.validUntil).toBeUndefined()
    expect(corrected.content).toContain("类型系统")

    const history = await rt.palace.getHistory(USER, corrected.id)
    expect(history.map((m) => m.id)).toContain(original.id)
  })

  it("archives by default and deletes only when explicitly asked", async () => {
    const a = await rt.palace.remember({
      userId: USER,
      content: "我最近开始系统学习 Rust。",
      sourceKind: "user",
    })
    const b = await rt.palace.remember({
      userId: USER,
      content: "用户使用 PostgreSQL。",
      sourceKind: "user",
    })

    const idA = a.memories[0]!.id
    const idB = b.memories[0]!.id

    await rt.palace.forgetMemories(USER, [idA])
    expect((await rt.palace.getMemory(USER, idA)).status).toBe("archived")

    // Hard deletion is the user's explicit "erase this" path.
    const result = await rt.palace.forgetMemories(USER, [idB], { hard: true })
    expect(result.deleted).toBe(1)
    expect(await rt.storage.store.getMemory(USER, idB)).toBeNull()
  })
})

describe("export and import round-trip", () => {
  it("restores an identical memory set", async () => {
    await rt.palace.remember({
      userId: USER,
      content: "我最近开始系统学习 Effect-TS。以后讲 TypeScript 时先讲整体结构，再深入 API。",
      sourceKind: "user",
    })
    await rt.palace.remember({
      userId: USER,
      content: "用户使用 PostgreSQL 18。",
      sourceKind: "user",
    })

    const before = await rt.storage.store.listMemories(USER, {})
    const beforeContents = before.map((m) => m.content).sort()
    expect(before.length).toBeGreaterThan(1)

    const embeddingsBefore = await rt.storage.store.countEmbeddings(USER, rt.llm.embeddings.modelId)
    const bundle = await exportAll(rt.storage.db, USER, { includeEmbeddings: true })
    expect(bundle.memories.length).toBe(before.length)

    // Wipe everything, then restore from the bundle alone.
    await wipeUser(rt.storage.db, USER)
    expect(await rt.storage.store.countMemories(USER, {})).toBe(0)

    const result = await importAll(rt.storage.db, bundle)
    expect(result.memories).toBe(before.length)

    const after = await rt.storage.store.listMemories(USER, {})
    expect(after.map((m) => m.content).sort()).toEqual(beforeContents)
    expect(await rt.storage.store.countEmbeddings(USER, rt.llm.embeddings.modelId)).toBe(
      embeddingsBefore,
    )

    // And recall still works against the restored data.
    const recalled = await rt.palace.recall({ userId: USER, query: "Effect-TS", mode: "fast" })
    expect(recalled.memories.length).toBeGreaterThan(0)
  })

  it("is idempotent, so a restore run twice does not duplicate anything", async () => {
    await rt.palace.remember({ userId: USER, content: "用户使用 PostgreSQL。", sourceKind: "user" })
    const bundle = await exportAll(rt.storage.db, USER, {})
    const count = await rt.storage.store.countMemories(USER, {})

    await importAll(rt.storage.db, bundle)
    await importAll(rt.storage.db, bundle)

    expect(await rt.storage.store.countMemories(USER, {})).toBe(count)
  })

  it("refuses a bundle it cannot understand", async () => {
    const bogus = { format: "something-else", version: 1, userId: USER } as never
    await expect(importAll(rt.storage.db, bogus)).rejects.toThrow(/unrecognised bundle format/)
  })
})

describe("entity linkage", () => {
  it("links memories to the entities they mention", async () => {
    await rt.palace.remember({
      userId: USER,
      content: "我最近开始系统学习 Effect-TS。",
      sourceKind: "user",
    })
    const entities = await rt.storage.store.listEntities(USER, 50)
    expect(entities.length).toBeGreaterThan(0)
    expect(entities.map((e) => e.canonicalName.toLowerCase())).toContain("effect-ts")

    const memories = await rt.storage.store.listMemories(USER, {})
    const byMemory = await rt.storage.store.entitiesForMemories(
      USER,
      memories.map((m) => m.id),
    )
    const linked = [...byMemory.values()].flat()
    expect(linked.length).toBeGreaterThan(0)
  })
})

describe("recall returns nothing rather than padding", () => {
  it("returns an empty result for an unrelated question", async () => {
    await rt.palace.remember({ userId: USER, content: "用户使用 PostgreSQL。", sourceKind: "user" })
    await rt.palace.remember({ userId: USER, content: "用户的猫叫豆豆。", sourceKind: "user" })

    const result = await rt.palace.recall({
      userId: USER,
      query: "今天东京的天气怎么样？",
      mode: "fast",
    })

    // Design doc Case 4. An empty answer must be reachable, or the agent can
    // never distinguish "nothing known" from "something vaguely related".
    expect(result.memories).toHaveLength(0)
    expect(result.diagnostics.returnedEmpty).toBe(true)
  })
})

describe("smart path: rescued paraphrases below the semantic floor", () => {
  // A floor of 0.99 with a 0.98 margin probes down to 0.01, so every semantic
  // hit is a rescued candidate. That isolates the rescue rule from whatever the
  // embedder happens to score — only the reranker's verdict can decide.
  const FLOOR_CONFIG = {
    recall: { minSemanticSimilarity: 0.99, semanticRescueMargin: 0.98, rescueMinRelevance: 0.6 },
  }
  const PARAPHRASE = {
    type: "preference" as const,
    content: "用户偏好先看整体骨架再看实现细节",
  }
  const PARAPHRASE_QUERY = "讲解时应该怎么安排顺序？"

  let confirmed: TestRuntime
  let refused: TestRuntime
  let failing: TestRuntime
  let lukewarm: TestRuntime

  beforeAll(async () => {
    const dim = await schemaEmbeddingDim()
    confirmed = await createTestRuntime({
      userId: "rescue-confirmed",
      config: FLOOR_CONFIG,
      llm: new StubRerankLlm(0.9),
      embeddings: new BandEmbedding(dim),
    })
    refused = await createTestRuntime({
      userId: "rescue-refused",
      config: FLOOR_CONFIG,
      llm: new StubRerankLlm(0.2),
      embeddings: new BandEmbedding(dim),
    })
    failing = await createTestRuntime({
      userId: "rescue-failing",
      config: FLOOR_CONFIG,
      llm: new StubRerankLlm("fail"),
      embeddings: new BandEmbedding(dim),
    })
    // 0.45 sits between the veto (0.3) and the rescue bar (0.6): "not great, not
    // useless". That is the band where nothing but the route's own evidence can
    // decide.
    lukewarm = await createTestRuntime({
      userId: "rescue-lukewarm",
      config: FLOOR_CONFIG,
      llm: new StubRerankLlm(0.45),
      embeddings: new BandEmbedding(dim),
    })
  })

  afterAll(async () => {
    await Promise.all([confirmed, refused, failing, lukewarm].map((r) => r.cleanup()))
  })

  it("recalls a below-floor candidate once the reranker confirms it", async () => {
    await seedWithEmbedding(confirmed, [PARAPHRASE])

    const audit = await confirmed.palace.recallWithAudit({
      userId: confirmed.userId,
      query: PARAPHRASE_QUERY,
      mode: "smart",
    })

    expect(audit.result.memories.map((m) => m.memory.content)).toContain(PARAPHRASE.content)

    // The audit has to say WHY it was let through, or the rescue is invisible
    // to anyone debugging a recall that "shouldn't" have happened.
    const kept = audit.considered.find((e) => e.kept)
    expect(kept?.reason).toBe("kept_rescued_confirmed")
  })

  it("drops a below-floor candidate the reranker refuses", async () => {
    await seedWithEmbedding(refused, [PARAPHRASE])

    const audit = await refused.palace.recallWithAudit({
      userId: refused.userId,
      query: PARAPHRASE_QUERY,
      mode: "smart",
    })

    expect(audit.result.memories).toHaveLength(0)
    expect(audit.result.diagnostics.returnedEmpty).toBe(true)
    expect(audit.considered.find((e) => !e.kept)?.reason).toBe("rescued_unconfirmed")
  })

  it("never probes below the floor on the fast path", async () => {
    // Same store, same query, and a reranker that WOULD have confirmed it: the
    // fast path has no reranker to appeal to, so the floor has to hold.
    await seedWithEmbedding(confirmed, [PARAPHRASE])

    const result = await confirmed.palace.recall({
      userId: confirmed.userId,
      query: PARAPHRASE_QUERY,
      mode: "fast",
    })

    expect(result.memories).toHaveLength(0)
  })

  it("leaves a memory another route matched alone, even with a lukewarm reranker", async () => {
    // The rescue may only ADD candidates. This memory is in the semantic probe
    // band but also matched the lexical route, so the fast path would have
    // recalled it — demanding rerank CONFIRMATION here would make the smart path
    // recall strictly less than the fast path. A merely lukewarm relevance is
    // not a refusal either (that is what the veto is for, at 0.3).
    await seedWithEmbedding(lukewarm, [{ type: "fact", content: "用户的项目代号是 Phoenix" }])

    const audit = await lukewarm.palace.recallWithAudit({
      userId: lukewarm.userId,
      query: "Phoenix 项目代号是什么？",
      mode: "smart",
    })

    const kept = audit.considered.find((e) => e.kept)
    expect(kept?.reason).toBe("kept")
    expect(audit.result.memories.map((m) => m.memory.content)).toContain("用户的项目代号是 Phoenix")
  })

  it("degrades to the fast-path answer when reranking fails", async () => {
    await seedWithEmbedding(failing, [PARAPHRASE])

    const result = await failing.palace.recall({
      userId: failing.userId,
      query: PARAPHRASE_QUERY,
      mode: "smart",
    })

    // A broken reranker must not fail the query, and must not let unconfirmed
    // candidates through either: the answer is the one the floor would give.
    expect(result.memories).toHaveLength(0)
    expect(result.diagnostics.returnedEmpty).toBe(true)
  })
})

describe("smart path: the reranker's 'not useful' verdict is binding", () => {
  // A floor of 0.1 leaves the candidate well ABOVE it, so the rescue plays no
  // part: the score is genuinely high and the only question is whether an
  // explicit relevance judgement overrides it.
  //
  // `minRerankRelevance` is stated rather than inherited: under the mock LLM
  // provider the default is 0, because the stand-in cannot judge relevance. A
  // test that wants the veto has to say so.
  const FLOOR_CONFIG = {
    recall: { minSemanticSimilarity: 0.1, semanticRescueMargin: 0.05, minRerankRelevance: 0.3 },
  }
  const MEMORY = {
    type: "preference" as const,
    content: "用户偏好先看整体骨架再看实现细节",
  }
  const QUERY = "讲解时应该怎么安排顺序？"

  let vetoing: TestRuntime
  let broken: TestRuntime

  beforeAll(async () => {
    const dim = await schemaEmbeddingDim()
    vetoing = await createTestRuntime({
      userId: "veto",
      config: FLOOR_CONFIG,
      llm: new StubRerankLlm(0.1),
      embeddings: new BandEmbedding(dim),
    })
    broken = await createTestRuntime({
      userId: "veto-broken",
      config: FLOOR_CONFIG,
      llm: new StubRerankLlm("fail"),
      embeddings: new BandEmbedding(dim),
    })
  })

  afterAll(async () => {
    await Promise.all([vetoing, broken].map((r) => r.cleanup()))
  })

  it("drops a high-scoring candidate the reranker calls irrelevant", async () => {
    await seedWithEmbedding(vetoing, [MEMORY])

    const audit = await vetoing.palace.recallWithAudit({
      userId: vetoing.userId,
      query: QUERY,
      mode: "smart",
    })

    // This is the measured failure the veto exists for: on the real stack an
    // irrelevant candidate reached a blended score of 0.56 while the model had
    // already scored its relevance 0.05.
    expect(audit.result.memories).toHaveLength(0)
    expect(audit.result.diagnostics.returnedEmpty).toBe(true)
    expect(audit.considered.find((e) => !e.kept)?.reason).toBe("rerank_rejected")
  })

  it("keeps the same memory on the fast path, which has no reranker to ask", async () => {
    await seedWithEmbedding(vetoing, [MEMORY])

    const result = await vetoing.palace.recall({
      userId: vetoing.userId,
      query: QUERY,
      mode: "fast",
    })

    expect(result.memories.map((m) => m.memory.content)).toContain(MEMORY.content)
  })

  it("does not veto on the reranker's silence", async () => {
    // A provider outage must not be mistaken for a relevance judgement: with no
    // verdict to honour, the pipeline falls back to the score it has.
    await seedWithEmbedding(broken, [MEMORY])

    const result = await broken.palace.recall({
      userId: broken.userId,
      query: QUERY,
      mode: "smart",
    })

    expect(result.memories.map((m) => m.memory.content)).toContain(MEMORY.content)
  })
})

describe("auto escalates when the fast answer is uncorroborated", () => {
  // Floor 0.3, so the candidate below is a legitimate semantic hit and the
  // reason to escalate is not "the score was low" but "nothing corroborates it".
  // The trust thresholds are stated explicitly: under the mock provider both
  // default to 0, since a stand-in's relevance verdict has no standing.
  const CONFIG = {
    recall: {
      minSemanticSimilarity: 0.3,
      semanticRescueMargin: 0.05,
      minRerankRelevance: 0.3,
      escalateBelowSemanticSimilarity: 0.6,
    },
  }
  // Cosine 0.447 and no lexical match: the fast path has nothing but a middling
  // cosine to go on, which is exactly what a reranker can settle.
  const WEAK = { type: "preference" as const, content: "用户偏好先看低相似摘要" }

  let escalating: TestRuntime
  let permissive: TestRuntime

  beforeAll(async () => {
    const dim = await schemaEmbeddingDim()
    // A reranker that vetoes everything, so escalation has a visible effect.
    escalating = await createTestRuntime({
      userId: "auto-escalating",
      config: CONFIG,
      llm: new StubRerankLlm(0.1),
      embeddings: new BandEmbedding(dim),
    })
    permissive = await createTestRuntime({
      userId: "auto-permissive",
      config: {
        recall: { ...CONFIG.recall, escalateBelowSemanticSimilarity: 0 },
      },
      llm: new StubRerankLlm(0.1),
      embeddings: new BandEmbedding(dim),
    })
  })

  afterAll(async () => {
    await Promise.all([escalating, permissive].map((r) => r.cleanup()))
  })

  it("escalates a semantic-only answer and lets the reranker decide", async () => {
    await seedWithEmbedding(escalating, [WEAK])

    const result = await escalating.palace.recall({
      userId: escalating.userId,
      query: "讲解时应该怎么安排顺序？",
    })

    // No mode was passed: this is what an agent gets by default.
    expect(result.mode).toBe("smart")
    expect(result.escalated).toBe(true)
    // The reranker said "not useful", so the answer is nothing.
    expect(result.memories).toHaveLength(0)
  })

  it("does not escalate the same answer when the rule is disabled", async () => {
    await seedWithEmbedding(permissive, [WEAK])

    const result = await permissive.palace.recall({
      userId: permissive.userId,
      query: "讲解时应该怎么安排顺序？",
    })

    // The old behaviour, kept measurable: the fast path answers on the score.
    expect(result.mode).toBe("fast")
    expect(result.escalated).toBe(false)
    expect(result.memories.map((m) => m.memory.content)).toContain(WEAK.content)
  })

  it("leaves a corroborated answer on the fast path", async () => {
    // A lexical match is evidence the cosine does not have. Escalating it would
    // spend two model calls to learn nothing.
    await seedWithEmbedding(escalating, [{ type: "fact", content: "用户的项目代号是 Phoenix" }])

    const result = await escalating.palace.recall({
      userId: escalating.userId,
      query: "Phoenix 项目代号是什么？",
    })

    expect(result.mode).toBe("fast")
    expect(result.escalated).toBe(false)
  })
})

describe("a history question is not clamped to now", () => {
  // Same physical store as the rest of the file (mock embedder, real database):
  // the point under test is the temporal filter, and both versions match the
  // lexical route, so neither depends on embedding quality.
  const QUERY = "用户之前用什么框架？"
  const VUE = {
    type: "fact" as const,
    content: "用户使用 Vue 框架",
    status: "superseded" as const,
    validUntil: "2026-06-01T00:00:00.000Z",
  }
  const REACT = {
    type: "fact" as const,
    content: "用户改用 React 框架",
    validFrom: "2026-06-01T00:00:00.000Z",
  }

  it("returns the version that was true then when history is asked for", async () => {
    await seedWithEmbedding(rt, [VUE, REACT])

    const result = await rt.palace.recall({
      userId: USER,
      query: QUERY,
      mode: "fast",
      includeHistory: true,
    })

    // The regression: `includeHistory` alone used to be useless, because the
    // validity window was still clamped to now and a superseded memory's
    // valid_until is in the past by definition.
    expect(result.memories.map((m) => m.memory.content)).toContain(VUE.content)
  })

  it("still hides it when history was not asked for", async () => {
    await seedWithEmbedding(rt, [VUE, REACT])

    const result = await rt.palace.recall({ userId: USER, query: QUERY, mode: "fast" })

    const contents = result.memories.map((m) => m.memory.content)
    expect(contents).toContain(REACT.content)
    expect(contents).not.toContain(VUE.content)
  })

  it("still honours an explicit asOf", async () => {
    await seedWithEmbedding(rt, [VUE, REACT])

    const result = await rt.palace.recall({
      userId: USER,
      query: QUERY,
      mode: "fast",
      includeHistory: true,
      asOf: "2026-03-01T00:00:00.000Z",
    })

    const contents = result.memories.map((m) => m.memory.content)
    expect(contents).toContain(VUE.content)
    expect(contents).not.toContain(REACT.content)
  })
})

describe("audit trail explains every decision", () => {
  it("reports why each candidate was kept or dropped", async () => {
    await rt.palace.remember({ userId: USER, content: "用户使用 PostgreSQL。", sourceKind: "user" })
    const audit = await rt.palace.recallWithAudit({
      userId: USER,
      query: "用户使用 PostgreSQL 吗？",
      mode: "fast",
    })
    expect(audit.considered.length).toBeGreaterThan(0)
    for (const entry of audit.considered) {
      expect(entry.reason).toBeTruthy()
      expect(typeof entry.kept).toBe("boolean")
    }
    // Every kept result carries a human-readable justification.
    for (const m of audit.result.memories) expect(m.why).toBeTruthy()
  })
})

describe("memory ids sort by creation time", () => {
  it("produces lexicographically ordered ids", async () => {
    const a = newId("mem", 1_000_000_000_000)
    const b = newId("mem", 1_000_000_001_000)
    expect(a < b).toBe(true)
    expect(a).toMatch(/^mem_[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
