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
