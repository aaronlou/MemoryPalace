import type { TestRuntime } from "@memory-palace/test-support"
import { createTestRuntime, truncateAll } from "@memory-palace/test-support"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createApp, mountMcp } from "./app.js"

/**
 * HTTP API acceptance tests.
 *
 * These exercise the real Hono app over `app.request()`, which runs the full
 * middleware stack — routing, validation, error mapping, JSON serialisation —
 * without binding a port. Without them the entire application layer (the thing
 * the web UI and remote MCP clients actually talk to) would have no automated
 * coverage at all, and the plan's Phase 7 criteria would be asserted nowhere:
 * browse, correct, delete, resolve conflicts, and read history, all without SQL.
 */

/** The subset of a memory the HTTP API returns that these tests assert on. */
interface ApiMemory {
  id: string
  type: string
  content: string
  status: string
  confidence: number
  importance: number
  validFrom?: string
  validUntil?: string
}

interface RememberBody {
  observationId: string
  memories: ApiMemory[]
  relations: Array<{ kind: string; reason?: string }>
  candidateCount: number
}

interface MemoriesBody {
  memories: ApiMemory[]
}

interface RecallBody {
  memories: Array<{
    memory: ApiMemory
    score: number
    why: string
    routes: Array<{ route: string }>
  }>
  context: string
  diagnostics: { latencyMs: number; returnedEmpty: boolean; routesUsed: string[] }
}

interface AuditBody {
  result: RecallBody
  considered: Array<{ memoryId: string; score: number; kept: boolean; reason: string }>
}

interface HistoryBody {
  history: ApiMemory[]
}

interface PendingBody {
  pending: ApiMemory[]
}

interface ExportBody {
  format: string
  memories: Array<{ content: string }>
}

const USER = "api-test-user"
let rt: TestRuntime
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  rt = await createTestRuntime({ userId: USER, now: "2026-09-21T12:00:00.000Z" })
  app = createApp(rt)
  await mountMcp(app, rt)
})

afterAll(async () => {
  await rt.cleanup()
})

beforeEach(async () => {
  await truncateAll(rt.storage.db)
})

// ---------------------------------------------------------------- helpers ---

async function json<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await app.request(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as T) : (null as T) }
}

const post = <T = unknown>(path: string, body: unknown) =>
  json<T>(path, { method: "POST", body: JSON.stringify(body) })

const remember = (content: string, extra: Record<string, unknown> = {}) =>
  post<RememberBody>("/api/remember", { content, sourceKind: "user", ...extra })

// ------------------------------------------------------------------ tests ---

describe("health and stats", () => {
  it("reports the running providers", async () => {
    const { status, body } = await json<{ ok: boolean; providers: string }>("/health")
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.providers).toContain("mock")
  })

  it("reports counts by status", async () => {
    await remember("我最近开始系统学习 Effect-TS。")
    const { body } = await json<{ active: number; observations: number; embeddingDim: number }>(
      "/api/stats",
    )
    expect(body.active).toBeGreaterThan(0)
    expect(body.observations).toBe(1)
    // The width is a deployment property (pnpm embedding:dim), so assert it
    // matches the schema rather than hardcoding a number.
    expect(body.embeddingDim).toBe(rt.config.embedding.dim)
  })
})

describe("remember and browse", () => {
  it("stores memories and lists them", async () => {
    const { status, body } = await remember(
      "我最近开始系统学习 Effect-TS。以后讲 TypeScript 时先从整体结构和设计思想讲。",
    )
    expect(status).toBe(200)
    expect(body.memories.length).toBeGreaterThanOrEqual(2)

    const list = await json<MemoriesBody>("/api/memories?limit=50")
    expect(list.status).toBe(200)
    expect(list.body.memories.length).toBe(body.memories.length)

    // Every memory is addressable on its own.
    const one = await json<ApiMemory>(`/api/memories/${body.memories[0]!.id}`)
    expect(one.status).toBe(200)
    expect(one.body.id).toBe(body.memories[0]!.id)
  })

  it("filters by type and status", async () => {
    await remember("我最近开始系统学习 Effect-TS。")
    await remember("我希望你先给结论，再讲推导过程。")

    const goals = await json<MemoriesBody>("/api/memories?types=goal")
    expect(goals.body.memories.every((m) => m.type === "goal")).toBe(true)

    const prefs = await json<MemoriesBody>("/api/memories?types=preference")
    expect(prefs.body.memories.every((m) => m.type === "preference")).toBe(true)

    const none = await json<MemoriesBody>("/api/memories?statuses=archived")
    expect(none.body.memories).toEqual([])
  })

  it("searches by text rather than listing everything", async () => {
    await remember("我最近开始系统学习 Effect-TS。")
    await remember("用户使用 PostgreSQL 作为主要数据库。")
    const { body } = await json<MemoriesBody>("/api/memories?q=Effect-TS")
    // Search unions a semantic route with a lexical one, so a weakly related
    // memory may also appear. What matters is that the relevant one is found.
    expect(body.memories.some((m) => m.content.includes("Effect-TS"))).toBe(true)
  })

  it("rejects an empty statement", async () => {
    const { status, body } = await post<{ error: { code: string } }>("/api/remember", {
      content: "   ",
    })
    expect(status).toBe(400)
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  it("404s an unknown memory", async () => {
    const { status, body } = await json<{ error: { code: string } }>(
      "/api/memories/mem_does_not_exist",
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe("NOT_FOUND")
  })

  it("404s an unknown route with a readable body", async () => {
    const { status, body } = await json<{ error: { message: string } }>("/api/nope")
    expect(status).toBe(404)
    expect(body.error.message).toContain("/api/nope")
  })
})

describe("correcting a memory keeps its history", () => {
  it("supersedes the wording but not the fact", async () => {
    const created = await remember("我最近开始系统学习 Effect-TS。")
    const original = created.body.memories[0]!

    const patched = await json<ApiMemory>(`/api/memories/${original.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "用户正在系统学习 Effect-TS 的类型系统部分" }),
    })
    expect(patched.status).toBe(200)
    expect(patched.body.content).toContain("类型系统")

    // The predecessor stops being current but its VALID time is untouched,
    // because only the wording improved.
    const old = await json<ApiMemory>(`/api/memories/${original.id}`)
    expect(old.body.status).toBe("superseded")
    expect(old.body.validUntil).toBeUndefined()

    const history = await json<HistoryBody>(`/api/memories/${patched.body.id}/history`)
    expect(history.status).toBe(200)
    expect(history.body.history.map((m) => m.id)).toContain(original.id)
    expect(history.body.history.length).toBeGreaterThanOrEqual(2)
  })

  it("rejects blanking a memory out", async () => {
    const created = await remember("我最近开始系统学习 Effect-TS。")
    const { status } = await json(`/api/memories/${created.body.memories[0]!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "  " }),
    })
    expect(status).toBe(400)
  })
})

describe("deleting", () => {
  it("archives by default and truly deletes when asked", async () => {
    const a = await remember("我最近开始系统学习 Effect-TS。")
    const b = await remember("用户使用 PostgreSQL 作为主要数据库。")

    const archived = await json<{ archived: number }>(`/api/memories/${a.body.memories[0]!.id}`, {
      method: "DELETE",
    })
    expect(archived.status).toBe(200)
    expect(archived.body.archived).toBe(1)
    expect((await json<ApiMemory>(`/api/memories/${a.body.memories[0]!.id}`)).body.status).toBe(
      "archived",
    )

    const deleted = await json<{ deleted: number }>(
      `/api/memories/${b.body.memories[0]!.id}?hard=true`,
      {
        method: "DELETE",
      },
    )
    expect(deleted.body.deleted).toBe(1)
    expect((await json(`/api/memories/${b.body.memories[0]!.id}`)).status).toBe(404)
  })
})

describe("recall", () => {
  it("returns a rendered briefing", async () => {
    await remember("我最近开始系统学习 Effect-TS。")
    const { status, body } = await post<RecallBody>("/api/recall", {
      query: "Effect-TS 怎么理解？",
      mode: "fast",
    })
    expect(status).toBe(200)
    expect(body.memories.length).toBeGreaterThan(0)
    expect(body.context).toContain("Effect-TS")
    expect(body.diagnostics.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("returns structured output when asked", async () => {
    await remember("我最近开始系统学习 Effect-TS。")
    const { body } = await post<RecallBody>("/api/recall", { query: "Effect-TS", format: "json" })
    const parsed = JSON.parse(body.context)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0]).toHaveProperty("why")
  })

  it("includes the audit trail when asked", async () => {
    await remember("我最近开始系统学习 Effect-TS。")
    const { body } = await post<AuditBody>("/api/recall", { query: "Effect-TS", audit: true })
    expect(body.result).toBeDefined()
    expect(Array.isArray(body.considered)).toBe(true)
    expect(body.considered.every((c) => typeof c.reason === "string")).toBe(true)
  })

  it("returns nothing for an unrelated question instead of padding", async () => {
    await remember("用户使用 PostgreSQL 作为主要数据库。")
    const { body } = await post<RecallBody>("/api/recall", {
      query: "今天东京的天气怎么样？",
      mode: "fast",
    })
    expect(body.memories).toEqual([])
    expect(body.diagnostics.returnedEmpty).toBe(true)
  })

  it("requires a query", async () => {
    const { status } = await post("/api/recall", {})
    expect(status).toBe(400)
  })
})

describe("the confirmation queue", () => {
  it("lists, confirms and rejects", async () => {
    // A decision written by an agent needs confirmation before it counts.
    await post("/api/remember", {
      content: "我们决定后端用 TypeScript 而不是 Python。",
      sourceKind: "agent",
      agentId: "coding-agent",
    })

    const pending = await json<PendingBody>("/api/pending")
    expect(pending.status).toBe(200)
    expect(pending.body.pending.length).toBeGreaterThan(0)
    const id = pending.body.pending[0]!.id

    // Not recalled while awaiting review.
    const before = await post<RecallBody>("/api/recall", {
      query: "后端用什么语言？",
      mode: "fast",
    })
    expect(before.body.memories.some((m) => m.memory.id === id)).toBe(false)

    const confirmed = await post<ApiMemory>(`/api/pending/${id}/confirm`, {})
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.status).toBe("active")

    // A second one, rejected instead.
    await post("/api/remember", {
      content: "我们决定把数据库换成 MySQL。",
      sourceKind: "agent",
      agentId: "coding-agent",
    })
    const queue = await json<PendingBody>("/api/pending")
    const second = queue.body.pending[0]!.id
    const rejected = await post<ApiMemory>(`/api/pending/${second}/reject`, { reason: "not true" })
    expect(rejected.body.status).toBe("archived")
  })
})

describe("recall feedback", () => {
  /** A stored row as the API returns it. */
  interface ApiFeedback {
    id: string
    query: string
    verdict: string
    returnedIds: string[]
    expectedText?: string
    promotedTo: string | null
  }

  /** Same shape as `post`, narrowed to the feedback route. */
  const record = (body: Record<string, unknown>) => post<ApiFeedback>("/api/feedback", body)

  it("records a judgement and returns everything needed to review it later", async () => {
    const { status, body } = await record({
      query: "用户之前用什么框架？",
      recallMode: "smart",
      returnedIds: ["mem_returned"],
      verdict: "missed",
      expectedText: "用户之前用 Vue",
      note: "从 Web 界面录的",
    })

    expect(status).toBe(201)
    expect(body.verdict).toBe("missed")
    expect(body.returnedIds).toEqual(["mem_returned"])
    expect(body.promotedTo).toBeNull()

    // What makes this worth having: a later reading can see the whole
    // transaction, not just that somebody was unhappy.
    const listed = await json<{ feedback: ApiFeedback[] }>("/api/feedback")
    expect(listed.body.feedback.map((f) => f.query)).toEqual(["用户之前用什么框架？"])
  })

  it("refuses a miss that says nothing about the miss", async () => {
    const { status } = await record({
      query: "用户之前用什么框架？",
      returnedIds: [],
      verdict: "missed",
    })

    // 400 rather than a stored row nobody can act on.
    expect(status).toBe(400)
  })

  it("separates the review queue from what has already been dealt with", async () => {
    const { body: dealt } = await record({
      query: "已经转成用例的",
      returnedIds: [],
      verdict: "helpful",
    })
    await record({
      query: "还没处理的",
      returnedIds: [],
      verdict: "missed",
      expectedText: "缺的内容",
    })
    // Promotion happens once a case has been adopted into the golden set; until
    // then the row belongs in the queue.
    await rt.storage.store.markFeedbackPromoted(USER, dealt.id, "rec-900")

    const unresolved = await json<{ feedback: ApiFeedback[] }>("/api/feedback?unresolved=1")
    expect(unresolved.body.feedback.map((f) => f.query)).toEqual(["还没处理的"])

    const all = await json<{ feedback: ApiFeedback[] }>("/api/feedback")
    expect(all.body.feedback).toHaveLength(2)
    expect(all.body.feedback.find((f) => f.id === dealt.id)?.promotedTo).toBe("rec-900")
  })
})

describe("timeline", () => {
  it("returns every version ordered by when it was true", async () => {
    await remember("我一直在用 Vue。", { occurredAt: "2025-01-01T00:00:00.000Z" })
    await remember("我现在不用 Vue 了，改用 React。")

    const { status, body } = await json<MemoriesBody>("/api/timeline")
    expect(status).toBe(200)
    expect(body.memories.length).toBeGreaterThanOrEqual(2)

    const validFroms = body.memories.map((m) => m.validFrom)
    const sorted = [...validFroms].sort()
    expect(validFroms).toEqual(sorted)
    // History is present, not just the current state.
    expect(body.memories.some((m) => m.status === "superseded")).toBe(true)
  })
})

describe("dates supplied by a client", () => {
  /**
   * `2026-06` is valid ISO-8601 and invalid `timestamptz`. A model reading
   * "2026年6月" writes exactly that, and the insert used to fail with
   * "invalid input syntax for type timestamp with time zone", losing the whole
   * sentence. Coercing to the start of the named period is the fix; rejecting it
   * would throw away a date the user actually stated.
   */
  it("accepts a partial date and resolves it to the start of the period", async () => {
    const { status, body } = await remember("我 2026 年 6 月换了 React。", {
      occurredAt: "2026-06",
    })
    expect(status).toBe(200)
    expect(body.memories.length).toBeGreaterThan(0)
    expect(body.memories[0]!.validFrom).toBe("2026-06-01T00:00:00.000Z")
  })

  /**
   * The other half of the policy, and the opposite of how model output is
   * treated: a client can correct its input, and quietly reading a bad `asOf` as
   * "now" would answer a question the caller did not ask. So this rejects.
   */
  it("rejects a date it cannot read, rather than silently meaning 'now'", async () => {
    const remembered = await remember("我说过一句话。", { occurredAt: "上周三" })
    expect(remembered.status).toBe(400)
    expect(remembered.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } })

    const recalled = await post("/api/recall", { query: "我说过什么？", asOf: "上周三" })
    expect(recalled.status).toBe(400)
    expect(recalled.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } })
  })

  it("still accepts a full instant unchanged", async () => {
    const { status, body } = await remember("我一直在用 Vue。", {
      occurredAt: "2025-01-01T00:00:00.000Z",
    })
    expect(status).toBe(200)
    expect(body.memories[0]!.validFrom).toBe("2025-01-01T00:00:00.000Z")
  })
})

describe("prior art", () => {
  interface PriorArtBody {
    id: string
    repo: string
    status: string
    title: string
    evidence: Array<{ ref: string; resolved: boolean; detail?: string; problem?: string }>
    unbacked: boolean
    evaluation?: {
      state: string
      error?: string
      revision?: string
      draft?: { suggestedStatus: string; claim: string; rejectedEvidence: Array<{ ref: string }> }
    }
  }

  /** What a reviewer would send back after editing the draft. */
  const reviewed = {
    title: "Trigger-augmented graph memory",
    claim: "Recall is reachability-bounded by similarity.",
    rationale: "The probe band answers the same premise.",
    status: "partial",
    evidence: [{ kind: "path", ref: "docs/adr/0006-confirmed-rescue-below-the-semantic-floor.md" }],
  }

  /**
   * The point of the redesign: a user supplies a repository and nothing else. They
   * are not asked to judge whether a project is worth borrowing from — that is what
   * the evaluation is for.
   */
  it("takes a repository and nothing else, then assesses it in the background", async () => {
    const { status, body } = await post<PriorArtBody>("/api/prior-art", {
      repo: "Sherlockwz/T-Mem",
    })
    expect(status).toBe(200)
    expect(body.repo).toBe("Sherlockwz/T-Mem")
    // Nothing is asserted about it yet, and it says so.
    expect(body.status).toBe("unevaluated")
    expect(["pending", "running", "ready"]).toContain(body.evaluation?.state)
  })

  it("accepts a pasted URL, since that is what users have", async () => {
    const { body } = await post<PriorArtBody>("/api/prior-art", {
      url: "https://github.com/aaronlou/MemoryPalace.git",
    })
    expect(body.repo).toBe("aaronlou/MemoryPalace")
  })

  it("rejects something that is not a repository", async () => {
    const { status, body } = await post<{ error: { message: string } }>("/api/prior-art", {
      repo: "not a repository",
    })
    expect(status).toBe(400)
    expect(body.error.message).toMatch(/owner\/name/)
  })

  it("lists, accepts a reviewed draft, and removes", async () => {
    const created = await post<PriorArtBody>("/api/prior-art", { repo: "Sherlockwz/T-Mem" })
    expect((await json<{ entries: PriorArtBody[] }>("/api/prior-art")).body.entries).toHaveLength(1)

    // Accepting is the only path that writes an assessment, and it carries the
    // reviewer's edits.
    const adopted = await post<PriorArtBody>(`/api/prior-art/${created.body.id}/adopt`, {
      repo: "Sherlockwz/T-Mem",
      ...reviewed,
    })
    expect(adopted.status).toBe(200)
    expect(adopted.body.status).toBe("partial")
    expect(adopted.body.evaluation?.state).toBe("accepted")
    expect(adopted.body.evidence[0]?.resolved).toBe(true)

    const removed = await json<{ removed: boolean }>(`/api/prior-art/${created.body.id}`, {
      method: "DELETE",
    })
    expect(removed.body.removed).toBe(true)
    // A second delete is a 404, not a silent success.
    expect((await json(`/api/prior-art/${created.body.id}`, { method: "DELETE" })).status).toBe(404)
  })

  /**
   * The load-bearing rule survives the new flow: accepting a draft that claims
   * overlap with nothing to point at is refused here exactly as a hand-written
   * entry would be.
   */
  it("refuses to accept a claim with nothing behind it", async () => {
    const created = await post<PriorArtBody>("/api/prior-art", { repo: "owner/name" })
    const { status, body } = await post<{ error: { message: string } }>(
      `/api/prior-art/${created.body.id}/adopt`,
      { repo: "owner/name", ...reviewed, status: "adopted", evidence: [] },
    )
    expect(status).toBe(400)
    expect(body.error.message).toMatch(/needs at least one evidence reference/)
  })

  it("re-queues an assessment on request", async () => {
    const created = await post<PriorArtBody>("/api/prior-art", { repo: "owner/name" })
    const retried = await post<PriorArtBody>(`/api/prior-art/${created.body.id}/evaluate`, {})
    expect(retried.status).toBe(200)
    expect(["pending", "running", "ready"]).toContain(retried.body.evaluation?.state)
  })

  it("404s an assessment of an entry that does not exist", async () => {
    const response = await post(`/api/prior-art/pa_missing/evaluate`, {})
    expect(response.status).toBe(404)
  })
})

describe("agent policies", () => {
  it("defaults, then persists an override", async () => {
    const initial = await json<{ policies: unknown[] }>("/api/policies")
    expect(initial.status).toBe(200)
    expect(initial.body.policies).toEqual([])

    const put = await json<{ allowedTypes: string[] }>("/api/policies/locked-down", {
      method: "PUT",
      body: JSON.stringify({ allowedTypes: ["fact"], canWrite: true }),
    })
    expect(put.status).toBe(200)
    expect(put.body.allowedTypes).toEqual(["fact"])

    const after = await json<{ policies: Array<{ agentId: string }> }>("/api/policies")
    expect(after.body.policies).toHaveLength(1)
    expect(after.body.policies[0]!.agentId).toBe("locked-down")
  })

  it("parks types outside the allow-list for review", async () => {
    await json("/api/policies/picky", {
      method: "PUT",
      body: JSON.stringify({ allowedTypes: ["fact"], requireConfirmationFor: [] }),
    })
    const outcome = await post<RememberBody>("/api/remember", {
      content: "我最近开始系统学习 Effect-TS。",
      sourceKind: "agent",
      agentId: "picky",
    })
    expect(outcome.body.memories.every((m) => m.status === "pending")).toBe(true)
  })
})

describe("export, import and erase", () => {
  it("exports readable Markdown", async () => {
    await remember("我最近开始系统学习 Effect-TS。")
    const response = await app.request("/api/export?format=markdown")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/markdown")
    const text = await response.text()
    expect(text).toContain("# Memory Palace export")
    expect(text).toContain("Effect-TS")
  })

  it("round-trips JSON through a wipe", async () => {
    await remember("我最近开始系统学习 Effect-TS。")
    await remember("用户使用 PostgreSQL 作为主要数据库。")

    const exported = await json<ExportBody>("/api/export?format=json&embeddings=true")
    expect(exported.body.format).toBe("memory-palace/export")
    const before = exported.body.memories.map((m) => m.content).sort()

    const erased = await post<{ erased: boolean }>("/api/erase?confirm=ERASE", {})
    expect(erased.body.erased).toBe(true)
    expect((await json<{ active: number }>("/api/stats")).body.active).toBe(0)

    const imported = await post<{ memories: number }>("/api/import?replace=true", exported.body)
    expect(imported.body.memories).toBe(before.length)

    const after = await json<MemoriesBody>("/api/memories?limit=100")
    expect(after.body.memories.map((m) => m.content).sort()).toEqual(before)

    // And recall works against the restored data.
    const recalled = await post<RecallBody>("/api/recall", { query: "Effect-TS", mode: "fast" })
    expect(recalled.body.memories.length).toBeGreaterThan(0)
  })

  it("refuses to erase without an explicit confirmation token", async () => {
    const { status, body } = await post<{ error: { message: string } }>("/api/erase", {})
    expect(status).toBe(400)
    expect(body.error.message).toContain("confirm=ERASE")
    // The guard must also mean the data is still there.
    await remember("用户使用 PostgreSQL。")
    expect((await json<{ active: number }>("/api/stats")).body.active).toBeGreaterThan(0)
  })

  it("rejects a malformed bundle", async () => {
    const { status } = await post("/api/import", { format: "something-else", version: 1 })
    expect(status).toBeGreaterThanOrEqual(400)
  })
})

describe("MCP over Streamable HTTP", () => {
  const rpc = (body: unknown) =>
    app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    })

  it("answers initialize and advertises the tools", async () => {
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "api-test", version: "1.0.0" },
      },
    })
    expect(init.status).toBe(200)

    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    const payload = (await list.json()) as {
      result: { tools: Array<{ name: string }> }
    }
    const names = payload.result.tools.map((t) => t.name)
    expect(names).toContain("memory_recall")
    expect(names).toContain("memory_remember")
  })

  it("performs a full remember → recall round trip over HTTP", async () => {
    const remembered = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_remember",
        arguments: { content: "我最近开始系统学习 Effect-TS。", source_kind: "user" },
      },
    })
    const rememberedBody = await remembered.json()
    expect(JSON.stringify(rememberedBody)).toContain("Effect-TS")

    const recalled = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "memory_recall", arguments: { query: "Effect-TS 怎么理解？" } },
    })
    const recalledBody = await recalled.json()
    expect(JSON.stringify(recalledBody)).toContain("Effect-TS")
  })
})
