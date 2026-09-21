import type { GenerateObjectRequest, GenerateObjectResult, LlmPort } from "@memory-palace/core"
import { MockEmbedding } from "@memory-palace/llm"
import type { TestRuntime } from "@memory-palace/test-support"
import { createTestRuntime, truncateAll } from "@memory-palace/test-support"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Language guard.
 *
 * A model occasionally answers in the wrong language — observed about once in 55
 * extractions of Chinese input, and not reproducible on demand, which is exactly
 * why it needs a deterministic test rather than a statistical one. The failure is
 * close to silent: an English memory in a Chinese memory store is nearly
 * unfindable, because CJK lexical matching is bigram-based.
 *
 * The stub below returns English on the first call and Chinese on the retry, so
 * every branch is exercised without a network call or a real model.
 */

const USER = "lang-guard-user"
let rt: TestRuntime

/** Counts calls and answers English first, Chinese when asked explicitly. */
class DriftingLlm implements LlmPort {
  readonly defaultModelId = "drifting"
  extractionCalls = 0
  prompts: string[] = []
  /** When true the retry also drifts, so the original answer must be kept. */
  alwaysDrifts = false

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    if (req.schemaName === "MemoryExtraction") {
      this.extractionCalls += 1
      this.prompts.push(req.prompt)
      const isRetry = req.prompt.includes("IMPORTANT: Write every memory in")
      const drifted = !isRetry || this.alwaysDrifts
      const value = {
        candidates: [
          {
            type: "fact",
            content: drifted ? "The user uses Vue." : "用户一直在使用 Vue。",
            summary: null,
            entities: [],
            confidence: 0.9,
            importance: 0.7,
            validFrom: null,
            reasoning: "stub",
          },
        ],
      }
      return {
        value: req.schema.parse(value) as T,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
        modelId: this.defaultModelId,
        promptHash: `stub-${this.extractionCalls}`,
        cached: false,
      }
    }
    // Keep adjudication inert so it does not add calls to the count.
    const value = {
      decision: "NEW",
      targetMemoryIds: [],
      mergedContent: null,
      effectiveFrom: null,
      confidenceDelta: 0,
      reason: "stub",
    }
    return {
      value: req.schema.parse(value) as T,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      modelId: this.defaultModelId,
      promptHash: "stub-adj",
      cached: false,
    }
  }
}

beforeAll(async () => {
  rt = await createTestRuntime({ userId: USER, now: "2026-09-21T12:00:00.000Z" })
})

afterAll(async () => {
  await rt.cleanup()
})

/** Always answers in the input's language. Must never trigger a retry. */
class CorrectLlm implements LlmPort {
  readonly defaultModelId = "correct"
  extractionCalls = 0

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    if (req.schemaName === "MemoryExtraction") this.extractionCalls += 1
    return {
      value: req.schema.parse(this.answer(req.schemaName)) as T,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
      modelId: this.defaultModelId,
      promptHash: "stub",
      cached: false,
    }
  }

  protected answer(schemaName: string): unknown {
    return schemaName === "MemoryExtraction"
      ? {
          candidates: [
            {
              type: "fact",
              content: "用户一直在使用 Vue。",
              summary: null,
              entities: [],
              confidence: 0.9,
              importance: 0.7,
              validFrom: null,
              reasoning: "stub",
            },
          ],
        }
      : {
          decision: "NEW",
          targetMemoryIds: [],
          mergedContent: null,
          effectiveFrom: null,
          confidenceDelta: 0,
          reason: "stub",
        }
  }
}

/** Returns whatever content it was constructed with, once. */
class CannedLlm extends CorrectLlm {
  private readonly content: string
  constructor(content: string) {
    super()
    this.content = content
  }
  protected override answer(schemaName: string): unknown {
    if (schemaName !== "MemoryExtraction") return super.answer(schemaName)
    const base = super.answer(schemaName) as { candidates: Array<Record<string, unknown>> }
    return { candidates: [{ ...base.candidates[0], content: this.content }] }
  }
}

async function freshPalace(stub: LlmPort) {
  const scoped = await createTestRuntime({
    userId: USER,
    now: "2026-09-21T12:00:00.000Z",
    llm: stub,
    embeddings: new MockEmbedding(rt.config.embedding.dim),
  })
  await truncateAll(scoped.storage.db)
  return scoped
}

describe("language drift is detected and corrected", () => {
  it("re-asks once and stores the memory in the input's language", async () => {
    const llm = new DriftingLlm()
    const scoped = await freshPalace(llm)
    try {
      const outcome = await scoped.palace.remember({
        userId: USER,
        content: "我一直在用 Vue。",
        sourceKind: "user",
      })

      expect(llm.extractionCalls, "expected exactly one retry, not a loop").toBe(2)
      expect(outcome.memories).toHaveLength(1)
      // The decisive assertion: what got stored is Chinese.
      expect(outcome.memories[0]!.content).toContain("用户")
      expect(outcome.memories[0]!.content).not.toMatch(/The user/)

      // And the retry was recorded, so drift is visible rather than silent.
      const runs = await scoped.storage.store.listExtractionRuns(USER, 5)
      expect(runs.some((r) => r.languageRetries === 1)).toBe(true)
    } finally {
      await scoped.cleanup()
    }
  })

  it("names the language in the retry prompt instead of repeating the instruction", async () => {
    const llm = new DriftingLlm()
    const scoped = await freshPalace(llm)
    try {
      await scoped.palace.remember({
        userId: USER,
        content: "我一直在用 Vue。",
        sourceKind: "user",
      })
      const retryPrompt = llm.prompts.find((p) => p.includes("IMPORTANT: Write every memory in"))
      expect(retryPrompt).toContain("Chinese")
    } finally {
      await scoped.cleanup()
    }
  })

  it("keeps the original answer when the retry also drifts", async () => {
    const llm = new DriftingLlm()
    llm.alwaysDrifts = true
    const scoped = await freshPalace(llm)
    try {
      const outcome = await scoped.palace.remember({
        userId: USER,
        content: "我一直在用 Vue。",
        sourceKind: "user",
      })
      // Two attempts and no more: a retry loop against a stubborn model would
      // burn tokens and delay every write.
      expect(llm.extractionCalls).toBe(2)
      expect(outcome.memories).toHaveLength(1)
      // Nothing is lost even though the guard could not fix it.
      expect(outcome.memories[0]!.content.length).toBeGreaterThan(0)
      const runs = await scoped.storage.store.listExtractionRuns(USER, 5)
      // The retry is only counted when it actually corrected the mismatch.
      expect(runs.every((r) => r.languageRetries === 0)).toBe(true)
    } finally {
      await scoped.cleanup()
    }
  })
})

describe("the guard stays out of the way when there is no drift", () => {
  it("does not retry when the answer is in the input's language", async () => {
    const correct = new CorrectLlm()
    const scoped = await freshPalace(correct)
    try {
      await scoped.palace.remember({
        userId: USER,
        content: "我一直在用 Vue。",
        sourceKind: "user",
      })
      expect(correct.extractionCalls, "a correct answer must not be re-asked").toBe(1)
      const runs = await scoped.storage.store.listExtractionRuns(USER, 5)
      expect(runs.every((r) => r.languageRetries === 0)).toBe(true)
    } finally {
      await scoped.cleanup()
    }
  })

  it("does not fire on Chinese text that legitimately contains latin terms", async () => {
    // "用户使用 PostgreSQL" mixes scripts and is entirely normal. Treating that
    // as drift would double the cost of most Chinese memories, so the guard
    // requires the output to be *entirely* latin before it intervenes.
    const mixed = new CannedLlm("用户使用 PostgreSQL 作为主要数据库。")
    const scoped = await freshPalace(mixed)
    try {
      const outcome = await scoped.palace.remember({
        userId: USER,
        content: "我用 PostgreSQL 做主库。",
        sourceKind: "user",
      })
      expect(outcome.memories.length).toBeGreaterThan(0)
      expect(mixed.extractionCalls).toBe(1)
      const runs = await scoped.storage.store.listExtractionRuns(USER, 5)
      expect(runs.every((r) => r.languageRetries === 0)).toBe(true)
    } finally {
      await scoped.cleanup()
    }
  })

  it("does not fire for English input answered in English", async () => {
    const english = new CannedLlm("The user uses PostgreSQL.")
    const scoped = await freshPalace(english)
    try {
      await scoped.palace.remember({
        userId: USER,
        content: "I use PostgreSQL.",
        sourceKind: "user",
      })
      expect(english.extractionCalls).toBe(1)
    } finally {
      await scoped.cleanup()
    }
  })
})
