import { NotFoundError, newId, ValidationError } from "@memory-palace/shared"
import { exportAll, importAll, wipeUser } from "@memory-palace/storage-pg"
import type { TestRuntime } from "@memory-palace/test-support"
import { createTestRuntime, truncateAll } from "@memory-palace/test-support"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

/**
 * Recall feedback: recording a human judgement about a recall, and keeping it.
 *
 * The loop only works if a verdict recorded today is still legible in six months,
 * which is why these tests care so little about the write itself and so much
 * about what comes back: the query verbatim, everything that was returned, and
 * whether this row has already become a golden-set case.
 *
 * The loudness of the validation is the other half. A `missed` verdict with no
 * expectation is worse than no verdict — it inflates the count of failures while
 * being impossible to act on, so it has to be rejected rather than stored.
 */

const USER = "feedback-user"
const OTHER = "feedback-other-user"
let rt: TestRuntime

/**
 * Insert a memory directly, unlike later tests which go through `remember`.
 *
 * Formation rewrites content, and these cases assert against exact ids, so what
 * is needed here is a known row rather than a realistic one.
 */
async function seedMemory(userId: string, content: string) {
  const memory = {
    id: newId("mem"),
    userId,
    type: "fact" as const,
    content,
    confidence: 0.9,
    importance: 0.7,
    validFrom: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
    status: "active" as const,
    reinforcedCount: 0,
  }
  await rt.storage.store.insertMemory(memory)
  return memory
}

beforeAll(async () => {
  rt = await createTestRuntime({ userId: USER, now: "2026-09-21T12:00:00.000Z" })
})

afterAll(async () => {
  await rt.cleanup()
})

beforeEach(async () => {
  await truncateAll(rt.storage.db)
})

describe("recording a judgement", () => {
  it("keeps the query and everything that was returned", async () => {
    const wanted = await seedMemory(USER, "用户希望先了解整体结构再深入 API")

    const recorded = await rt.palace.recordRecallFeedback({
      userId: USER,
      query: "讲解 Effect-TS 的时候应该怎么组织？",
      recallMode: "smart",
      returnedIds: ["mem_noise", wanted.id],
      verdict: "helpful",
      note: "顺序有点怪，但内容对上了",
      source: "web",
    })

    expect(recorded.id).toMatch(/^fb_/)
    expect(recorded.createdAt).toBeTruthy()
    expect(recorded.promotedTo).toBeNull()
    // The point of storing the whole returned list: at labelling time nobody
    // knows which half will matter later.
    expect(recorded.returnedIds).toEqual(["mem_noise", wanted.id])
    expect(recorded.note).toBe("顺序有点怪，但内容对上了")
    expect(recorded.source).toBe("web")
  })

  it("records an empty result honestly", async () => {
    // Recall returning nothing is a correct answer, not an error, so it must be
    // possible to say "that empty answer was wrong" without fabricating ids.
    const recorded = await rt.palace.recordRecallFeedback({
      userId: USER,
      query: "用户之前用什么框架？",
      recallMode: "fast",
      returnedIds: [],
      verdict: "missed",
      expectedText: "用户之前用 Vue",
      source: "web",
    })

    expect(recorded.returnedIds).toEqual([])
    expect(recorded.expectedText).toBe("用户之前用 Vue")
  })

  it("refuses a missed verdict that does not say what was missed", async () => {
    await expect(
      rt.palace.recordRecallFeedback({
        userId: USER,
        query: "用户之前用什么框架？",
        recallMode: "fast",
        returnedIds: [],
        verdict: "missed",
      }),
    ).rejects.toThrow(ValidationError)
  })

  it("refuses an empty query", async () => {
    await expect(
      rt.palace.recordRecallFeedback({
        userId: USER,
        query: "   ",
        recallMode: "fast",
        returnedIds: [],
        verdict: "helpful",
      }),
    ).rejects.toThrow(ValidationError)
  })

  it("refuses an expectation pointing at another user's memory", async () => {
    const theirs = await seedMemory(OTHER, "他们是另一个用户的记忆")

    await expect(
      rt.palace.recordRecallFeedback({
        userId: USER,
        query: "用户之前用什么框架？",
        recallMode: "fast",
        returnedIds: [],
        verdict: "missed",
        expectedMemoryId: theirs.id,
      }),
    ).rejects.toThrow(NotFoundError)
  })

  it("refuses an expectation pointing at nothing", async () => {
    await expect(
      rt.palace.recordRecallFeedback({
        userId: USER,
        query: "用户之前用什么框架？",
        recallMode: "fast",
        returnedIds: [],
        verdict: "missed",
        expectedMemoryId: "mem_does_not_exist",
      }),
    ).rejects.toThrow(NotFoundError)
  })
})

describe("the review queue", () => {
  async function record(verdict: "helpful" | "not_relevant" | "missed", query: string) {
    return rt.palace.recordRecallFeedback({
      userId: USER,
      query,
      recallMode: "fast",
      returnedIds: [],
      verdict,
      expectedText: verdict === "missed" ? "缺少的内容" : undefined,
    })
  }

  it("returns newest first", async () => {
    await record("helpful", "第一条")
    await record("not_relevant", "第二条")

    const listed = await rt.palace.listRecallFeedback(USER)

    // Newest first because review starts at the recent end, where context is
    // still available.
    expect(listed.map((f) => f.query)).toEqual(["第二条", "第一条"])
  })

  it("separates what has already become a test case", async () => {
    const promoted = await record("missed", "已经入选的那条")
    await record("missed", "还没入选的那条")

    await rt.storage.store.markFeedbackPromoted(USER, promoted.id, "rec-099")

    const unresolved = await rt.palace.listRecallFeedback(USER, { unresolvedOnly: true })
    expect(unresolved.map((f) => f.query)).toEqual(["还没入选的那条"])

    const all = await rt.palace.listRecallFeedback(USER)
    expect(all).toHaveLength(2)
    expect(all.find((f) => f.id === promoted.id)?.promotedTo).toBe("rec-099")
  })

  it("filters by verdict", async () => {
    await record("helpful", "评价好的一条")
    await record("not_relevant", "评价差的一条")

    const missed = await rt.palace.listRecallFeedback(USER, { verdict: "missed" })
    expect(missed).toHaveLength(0)

    const helpful = await rt.palace.listRecallFeedback(USER, { verdict: "helpful" })
    expect(helpful.map((f) => f.query)).toEqual(["评价好的一条"])
  })

  it("does not read another user's judgements", async () => {
    await record("helpful", "甲的一条")

    expect(await rt.palace.listRecallFeedback(OTHER)).toHaveLength(0)
  })
})

describe("survives the lifecycle it lives through", () => {
  it("round-trips through export and restore", async () => {
    const recorded = await rt.palace.recordRecallFeedback({
      userId: USER,
      query: "用户之前用什么框架？",
      recallMode: "fast",
      returnedIds: [],
      verdict: "missed",
      expectedText: "用户之前用 Vue",
      note: "写 Memo 的时候发现的",
    })

    const bundle = await exportAll(rt.storage.db, USER)
    await wipeUser(rt.storage.db, USER)
    expect(await rt.palace.listRecallFeedback(USER)).toHaveLength(0)

    const restored = await importAll(rt.storage.db, bundle)

    // Not merely present: this is the least recoverable data in the store. It was
    // typed by a person at a moment that cannot be replayed, so a backup that
    // drops it quietly is not restoring what the user had.
    expect(restored.recallFeedback).toBe(1)
    const [row] = await rt.palace.listRecallFeedback(USER)
    expect(row?.id).toBe(recorded.id)
    expect(row?.expectedText).toBe("用户之前用 Vue")
    expect(row?.note).toBe("写 Memo 的时候发现的")
  })

  it("is deleted by erase", async () => {
    // "Delete really deletes" is the promise this layer exists to keep, and a
    // record of what somebody judged is still their data.
    await rt.palace.recordRecallFeedback({
      userId: USER,
      query: "用户之前用什么框架？",
      recallMode: "fast",
      returnedIds: [],
      verdict: "missed",
      expectedText: "用户之前用 Vue",
    })

    await wipeUser(rt.storage.db, USER)

    expect(await rt.palace.listRecallFeedback(USER)).toHaveLength(0)
  })
})
