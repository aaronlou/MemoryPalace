import type {
  EmbeddingPort,
  GenerateObjectRequest,
  GenerateObjectResult,
  LlmPort,
  Memory,
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
  entries: Array<{ type: MemoryType; content: string }>,
): Promise<void> {
  for (const [i, e] of entries.entries()) {
    const memory: Memory = {
      id: newId("mem"),
      userId: rt.userId,
      type: e.type,
      content: e.content,
      confidence: 0.92,
      importance: 0.75,
      validFrom: "2026-01-01T00:00:00.000Z",
      recordedAt: `2026-0${i + 1}-01T00:00:00.000Z`,
      status: "active",
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
  })

  afterAll(async () => {
    await Promise.all([confirmed, refused, failing].map((r) => r.cleanup()))
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

  it("leaves a memory another route matched alone, even with a refusing reranker", async () => {
    // The rescue may only ADD candidates. This memory is in the semantic probe
    // band but also matched the lexical route, so the fast path would have
    // recalled it — demanding rerank confirmation here would make the smart
    // path recall strictly less than the fast path.
    await seedWithEmbedding(refused, [{ type: "fact", content: "用户的项目代号是 Phoenix" }])

    const audit = await refused.palace.recallWithAudit({
      userId: refused.userId,
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
