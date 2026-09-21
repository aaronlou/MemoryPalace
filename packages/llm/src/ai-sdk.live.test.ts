import { AdjudicationOutput, ExtractionOutput } from "@memory-palace/core"
import { ensureEnvLoaded, loadConfig } from "@memory-palace/shared"
import { describe, expect, it } from "vitest"
import { AiSdkLlm } from "./ai-sdk.js"
import { MemoryCache } from "./cache.js"

/**
 * Live provider test.
 *
 * Skipped unless credentials are present, so the suite stays green offline. It
 * exists because the mock provider can never catch a broken provider
 * integration: a wrong request shape, a renamed SDK field, or a provider that
 * silently ignores the schema would all pass every other test in this repo and
 * fail only in front of a real user.
 *
 * Run explicitly with:
 *   DEEPSEEK_API_KEY=... pnpm test ai-sdk.live
 */

// Must happen BEFORE the guard below. Without this, a credential that only
// exists in .env is invisible here and the suite skips itself while appearing to
// pass — a silent no-op, which is the worst possible outcome for a test whose
// entire job is to catch a broken provider integration.
ensureEnvLoaded()

const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY)
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY)

// Fail loudly if someone expects these to run but they cannot: a skip that
// nobody notices is indistinguishable from coverage that does not exist.
if (process.env.MP_REQUIRE_LIVE_TESTS === "1" && !hasDeepSeek && !hasOpenAI) {
  throw new Error("MP_REQUIRE_LIVE_TESTS=1 but no provider credentials are configured")
}

function makeLlm(): AiSdkLlm {
  const config = loadConfig({
    llm: {
      provider: hasDeepSeek ? "deepseek" : "openai",
      ...(hasDeepSeek ? { deepseekApiKey: process.env.DEEPSEEK_API_KEY } : {}),
      ...(hasOpenAI ? { openaiApiKey: process.env.OPENAI_API_KEY } : {}),
    },
  })
  return new AiSdkLlm(config, new MemoryCache())
}

const describeLive = hasDeepSeek || hasOpenAI ? describe : describe.skip

describeLive("live provider integration", () => {
  it("extracts schema-valid candidates from real input", async () => {
    const llm = makeLlm()
    const result = await llm.generateObject({
      schema: ExtractionOutput,
      schemaName: "MemoryExtraction",
      instructions:
        "Extract durable long-term memories about the user. Return an empty array if nothing is durable.",
      prompt: [
        '<observation source="user" occurred_at="2026-09-21T00:00:00.000Z">',
        "我最近开始系统学习 Effect-TS。以后你给我讲 TypeScript 的时候，先从整体结构和设计思想讲，再深入 API。",
        "</observation>",
        "",
        "Extract the durable memories from this observation.",
      ].join("\n"),
      temperature: 0,
    })

    // The schema parse already happened inside the adapter; this asserts the
    // provider produced something meaningful rather than an empty result.
    expect(Array.isArray(result.value.candidates)).toBe(true)
    expect(result.value.candidates.length).toBeGreaterThan(0)

    for (const candidate of result.value.candidates) {
      expect(candidate.content.length).toBeGreaterThan(0)
      expect(candidate.confidence).toBeGreaterThanOrEqual(0)
      expect(candidate.confidence).toBeLessThanOrEqual(1)
      expect(candidate.importance).toBeGreaterThanOrEqual(0)
      expect(candidate.importance).toBeLessThanOrEqual(1)
    }

    // Token accounting must be populated, or cost reporting is fiction.
    expect(result.usage.inputTokens).toBeGreaterThan(0)
    expect(result.usage.outputTokens).toBeGreaterThan(0)
    expect(result.modelId).toBeTruthy()
  }, 90_000)

  it("adjudicates against an existing memory", async () => {
    const llm = makeLlm()
    const result = await llm.generateObject({
      schema: AdjudicationOutput,
      schemaName: "MemoryAdjudication",
      instructions:
        "Decide how the candidate relates to existing memories. A change of state is SUPERSEDE, never CONTRADICT.",
      prompt: [
        "Today's date is 2026-09-21.",
        "",
        "<candidate>",
        "type: fact",
        "content: 用户改用 React",
        "</candidate>",
        "",
        "<existing_memories>",
        "[0] id=mem_abc type=fact confidence=0.95 valid_from=2025-01-01",
        "    用户一直在用 Vue",
        "</existing_memories>",
        "",
        "Decide how the candidate relates to these existing memories.",
      ].join("\n"),
      temperature: 0,
    })

    // The design doc's own scenario: switching frameworks must supersede.
    expect(result.value.decision).toBe("SUPERSEDE")
    expect(result.value.targetMemoryIds).toContain("mem_abc")
    expect(result.value.reason.length).toBeGreaterThan(0)
  }, 90_000)

  it("returns an empty candidate list for input with nothing durable", async () => {
    const llm = makeLlm()
    const result = await llm.generateObject({
      schema: ExtractionOutput,
      schemaName: "MemoryExtraction",
      instructions:
        "Extract durable long-term memories about the user. Return an empty array if nothing is durable.",
      prompt: [
        '<observation source="user" occurred_at="2026-09-21T00:00:00.000Z">',
        "帮我看看这个报错是什么意思？",
        "</observation>",
        "",
        "Extract the durable memories from this observation.",
      ].join("\n"),
      temperature: 0,
    })

    // Over-extraction is the failure mode that quietly ruins a memory system.
    expect(result.value.candidates).toHaveLength(0)
  }, 90_000)
})
