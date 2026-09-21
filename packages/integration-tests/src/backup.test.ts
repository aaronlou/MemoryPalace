import {
  defaultBackupPath,
  parseBackupArgs,
  summariseBundle,
  validateBundle,
} from "@memory-palace/runtime"
import { exportAll, importAll, wipeUser } from "@memory-palace/storage-pg"
import type { TestRuntime } from "@memory-palace/test-support"
import { createTestRuntime, truncateAll } from "@memory-palace/test-support"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Backup and restore.
 *
 * The plan's Phase 8 criterion is "back up → restore into an empty database →
 * evaluation score unchanged". Rather than comparing a single number, this
 * captures the system's entire observable behaviour before and after — the
 * recalled memories, their order, their scores, the rendered context, the
 * validity windows and the relation history — and requires them to be equal.
 *
 * A backup that restores the right row count but changes what the system answers
 * is not a backup.
 */

const USER = "backup-test-user"
let rt: TestRuntime

beforeAll(async () => {
  rt = await createTestRuntime({ userId: USER, now: "2026-09-21T12:00:00.000Z" })
})

afterAll(async () => {
  await rt.cleanup()
})

const QUERIES = [
  "Effect-TS 的 Context.Service 怎么理解？",
  "用户希望先了解整体结构和设计思想吗？",
  "用户用 Vue 吗？",
  "用户使用 PostgreSQL 吗？",
]

interface Snapshot {
  stats: Record<string, number>
  memories: Array<{
    id: string
    content: string
    status: string
    validFrom?: string
    validUntil?: string
  }>
  timeline: Array<{ id: string; validFrom?: string }>
  history: string[][]
  recall: Array<{
    query: string
    ids: string[]
    scores: number[]
    routes: string[][]
    context: string
    empty: boolean
  }>
}

/** Seed a scenario that exercises supersede, history and multiple types. */
async function seed(): Promise<void> {
  await truncateAll(rt.storage.db)
  const palace = rt.palace
  await palace.remember({
    userId: USER,
    content:
      "我最近开始系统学习 Effect-TS。以后你给我讲 TypeScript 的时候，先从整体结构和设计思想讲，再深入 API。",
    sourceKind: "user",
  })
  await palace.remember({
    userId: USER,
    content: "用户使用 PostgreSQL 作为主要数据库。",
    sourceKind: "user",
  })
  await palace.remember({
    userId: USER,
    content: "我一直在用 Vue。",
    sourceKind: "user",
    occurredAt: "2025-01-01T00:00:00.000Z",
  })
  await palace.remember({
    userId: USER,
    content: "我现在不用 Vue 了，改用 React。",
    sourceKind: "user",
  })
}

async function snapshot(): Promise<Snapshot> {
  const palace = rt.palace
  const stats = await palace.stats(USER)
  const memories = await palace.listMemories(USER, {}, { limit: 200 })
  const timeline = await palace.listMemories(
    USER,
    { statuses: ["active", "superseded", "archived", "pending"] },
    { limit: 200 },
  )

  // Walk the history of every active memory, so the relation edges are compared
  // too and not just the rows.
  const history: string[][] = []
  for (const memory of memories.filter((m) => m.status === "active")) {
    const chain = await palace.getHistory(USER, memory.id)
    history.push(chain.map((m) => `${m.id}:${m.status}:${m.validFrom ?? ""}:${m.validUntil ?? ""}`))
  }

  const recall: Snapshot["recall"] = []
  for (const query of QUERIES) {
    const result = await palace.recall({ userId: USER, query, mode: "fast", includeHistory: true })
    recall.push({
      query,
      ids: result.memories.map((m) => m.memory.id),
      scores: result.memories.map((m) => Number(m.score.toFixed(6))),
      routes: result.memories.map((m) => m.routes.map((r) => r.route).sort()),
      context: result.context,
      empty: result.diagnostics.returnedEmpty,
    })
  }

  return {
    stats: {
      active: stats.active,
      pending: stats.pending,
      superseded: stats.superseded,
      archived: stats.archived,
      observations: stats.observations,
      entities: stats.entities,
    },
    memories: memories
      .map((m) => ({
        id: m.id,
        content: m.content,
        status: m.status,
        validFrom: m.validFrom,
        validUntil: m.validUntil,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    timeline: timeline
      .map((m) => ({ id: m.id, validFrom: m.validFrom }))
      .sort((a, b) => (a.validFrom ?? "").localeCompare(b.validFrom ?? "")),
    history,
    recall,
  }
}

describe("behaviour is identical after a backup and restore", () => {
  it("preserves memories, history, timeline and recall output exactly", async () => {
    await seed()
    const before = await snapshot()
    expect(before.stats.active).toBeGreaterThan(0)
    expect(before.stats.superseded).toBeGreaterThan(0)
    expect(before.recall.some((r) => r.ids.length > 0)).toBe(true)

    const bundle = await exportAll(rt.storage.db, USER, { includeEmbeddings: true })

    // Empty the database completely, then restore from the bundle alone.
    await wipeUser(rt.storage.db, USER)
    expect((await rt.palace.stats(USER)).active).toBe(0)

    await importAll(rt.storage.db, bundle)

    const after = await snapshot()
    expect(after.stats).toEqual(before.stats)
    expect(after.memories).toEqual(before.memories)
    expect(after.timeline).toEqual(before.timeline)
    expect(after.history).toEqual(before.history)
    // Recall must return the same rows in the same order with the same scores.
    expect(after.recall).toEqual(before.recall)
  })

  it("restores working embeddings, not just rows", async () => {
    await seed()
    const bundle = await exportAll(rt.storage.db, USER, { includeEmbeddings: true })
    expect(bundle.embeddings!.length).toBeGreaterThan(0)

    await wipeUser(rt.storage.db, USER)
    await importAll(rt.storage.db, bundle)

    // A restored memory with no vector would be invisible to the semantic route,
    // so recall quality would silently degrade even though the rows are present.
    const models = await rt.storage.store.listEmbeddingModels(USER)
    expect(models.length).toBeGreaterThan(0)
    const hits = await rt.storage.search.semantic(
      USER,
      (await rt.llm.embeddings.embed(["Effect-TS"]))[0]!,
      { limit: 5, minScore: 0.05 },
    )
    expect(hits.length).toBeGreaterThan(0)
  })

  it("is idempotent, so a restore interrupted and rerun does not duplicate", async () => {
    await seed()
    const bundle = await exportAll(rt.storage.db, USER, {})
    const before = await rt.storage.store.countMemories(USER, {})

    await importAll(rt.storage.db, bundle)
    await importAll(rt.storage.db, bundle)

    expect(await rt.storage.store.countMemories(USER, {})).toBe(before)
  })
})

describe("bundle validation", () => {
  const validBundle = {
    format: "memory-palace/export",
    version: 1,
    exportedAt: "2026-09-21T00:00:00.000Z",
    userId: "someone",
    observations: [],
    memories: [],
    relations: [],
    entities: [],
    memoryEntities: [],
    policies: [],
    runs: [],
  }

  it("accepts a well-formed bundle", () => {
    expect(() => validateBundle(validBundle)).not.toThrow()
  })

  it("rejects a bundle from something else", () => {
    expect(() => validateBundle({ ...validBundle, format: "other-app" })).toThrow(
      /not a Memory Palace backup/,
    )
  })

  it("rejects an unsupported version", () => {
    expect(() => validateBundle({ ...validBundle, version: 99 })).toThrow(
      /unsupported backup version/,
    )
  })

  it("rejects a missing user", () => {
    expect(() => validateBundle({ ...validBundle, userId: "" })).toThrow(/no userId/)
  })

  it("rejects a bundle missing its row arrays", () => {
    const { memories: _dropped, ...rest } = validBundle
    expect(() => validateBundle(rest)).toThrow(/missing its memories array/)
  })

  it("rejects non-objects without crashing", () => {
    for (const value of [null, undefined, 42, "a string", []]) {
      expect(() => validateBundle(value)).toThrow()
    }
  })

  it("refuses a malformed bundle before deleting anything", async () => {
    await seed()
    const before = await rt.storage.store.countMemories(USER, {})
    await expect(
      importAll(rt.storage.db, { format: "other", version: 1 } as never),
    ).rejects.toThrow()
    // The destructive path must not have run.
    expect(await rt.storage.store.countMemories(USER, {})).toBe(before)
  })
})

describe("CLI argument parsing", () => {
  it("defaults to backup", () => {
    expect(parseBackupArgs([])).toEqual({
      command: "backup",
      file: undefined,
      user: undefined,
      includeEmbeddings: true,
    })
    expect(parseBackupArgs(["out.json"]).file).toBe("out.json")
  })

  it("recognises restore and check", () => {
    expect(parseBackupArgs(["restore", "in.json"])).toMatchObject({
      command: "restore",
      file: "in.json",
    })
    expect(parseBackupArgs(["check", "in.json"])).toMatchObject({
      command: "check",
      file: "in.json",
    })
  })

  it("parses flags in any position", () => {
    expect(parseBackupArgs(["restore", "--user", "alice", "in.json"])).toMatchObject({
      command: "restore",
      file: "in.json",
      user: "alice",
    })
    expect(parseBackupArgs(["--no-embeddings", "out.json"]).includeEmbeddings).toBe(false)
  })

  it("names backup files so they sort chronologically", () => {
    const path = defaultBackupPath(new Date("2026-09-21T10:11:12.000Z"))
    expect(path).toContain("2026-09-21T10-11-12")
    expect(path.endsWith(".json")).toBe(true)
  })

  it("summarises a bundle without reading the database", () => {
    const summary = summariseBundle(
      "x.json",
      {
        format: "memory-palace/export",
        version: 1,
        exportedAt: "2026-09-21T00:00:00.000Z",
        userId: "u",
        observations: [{}],
        memories: [{}, {}],
        relations: [{}],
        entities: [{}],
        memoryEntities: [],
        policies: [],
        runs: [],
      } as never,
      1024,
    )
    expect(summary).toMatchObject({
      memories: 2,
      observations: 1,
      relations: 1,
      entities: 1,
      embeddings: 0,
    })
  })
})
