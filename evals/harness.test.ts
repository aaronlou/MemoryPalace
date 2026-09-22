import { createTestRuntime } from "@memory-palace/test-support"
import { beforeAll, describe, expect, it } from "vitest"
import { runEval } from "./harness.js"
import { matchSets, precisionAtK, precisionRecallF1, recallAtK } from "./metrics.js"

/**
 * Harness self-validation — the Phase 2 acceptance criteria.
 *
 * A score is only meaningful if the measuring instrument is calibrated. These
 * tests prove the metrics can reach both endpoints:
 *
 *   - an ORACLE that always returns the expected answer must score perfectly;
 *   - a NULL implementation that returns nothing must score zero.
 *
 * If either end is wrong, then a real score like "F1 = 0.63" is measuring the
 * harness rather than the pipeline.
 *
 * Note on recall: the oracle replaces the *language model*, not the embedding
 * model. Cases that require understanding a paraphrase therefore still miss
 * under the hashing stand-in embedder — that is a property of the provider, not
 * a harness defect, so recall is asserted on the negative cases (which test
 * filtering) rather than on paraphrase recall.
 */

describe("metric primitives", () => {
  it("treats 'found nothing when nothing was expected' as perfect", () => {
    // Returning 0 here would make every negative case look like a miss and
    // permanently depress the average.
    expect(precisionRecallF1(0, 0, 0)).toEqual({ precision: 1, recall: 1, f1: 1 })
  })

  it("scores a false positive as zero precision", () => {
    const { precision, recall } = precisionRecallF1(0, 1, 0)
    expect(precision).toBe(0)
    expect(recall).toBe(1)
  })

  it("scores a missed expectation as zero recall", () => {
    const { precision, recall } = precisionRecallF1(0, 0, 1)
    expect(recall).toBe(0)
    expect(precision).toBe(0)
  })

  it("computes the harmonic mean correctly", () => {
    const { precision, recall, f1 } = precisionRecallF1(3, 1, 1)
    expect(precision).toBeCloseTo(0.75)
    expect(recall).toBeCloseTo(0.75)
    expect(f1).toBeCloseTo(0.75)
  })

  it("matches expectations one-to-one so one memory cannot satisfy two", () => {
    const produced = [{ type: "preference", content: "用户喜欢架构和设计思想" }]
    const expected = [
      { type: "preference" as const, contentContains: ["架构"] },
      { type: "preference" as const, contentContains: ["设计思想"] },
    ]
    const { tp, fn } = matchSets(produced, expected)
    expect(tp).toBe(1)
    expect(fn).toBe(1)
  })

  it("requires the type to match when one is specified", () => {
    const produced = [{ type: "fact", content: "用户喜欢架构" }]
    const { tp } = matchSets(produced, [{ type: "preference", contentContains: ["架构"] }])
    expect(tp).toBe(0)
  })

  it("measures P@k and R@k over an ordered list", () => {
    const returned = ["a", "b", "c", "d", "e", "f"]
    expect(precisionAtK(returned, ["a", "c"], 4)).toBeCloseTo(0.5)
    expect(recallAtK(returned, ["a", "c"], 4)).toBeCloseTo(1)
    // Recall drops when the relevant item falls outside the window.
    expect(recallAtK(returned, ["f"], 4)).toBe(0)
    expect(precisionAtK([], ["a"], 4)).toBe(0)
    expect(precisionAtK([], [], 4)).toBe(1)
  })
})

describe("harness calibration", () => {
  // The eval harness builds its own runtime, so it must be told the schema's
  // width; otherwise a deployment that changed its embedding model would fail
  // calibration for the wrong reason.
  beforeAll(async () => {
    const probe = await createTestRuntime({ userId: "harness-width-probe" })
    process.env.MP_EMBEDDING_DIM = String(probe.config.embedding.dim)
    await probe.cleanup()
  })

  it("scores a perfect model perfectly on extraction and evolution", async () => {
    const report = await runEval({ provider: "oracle", label: "oracle-calibration" })

    expect(report.extraction.precision).toBeCloseTo(1, 5)
    expect(report.extraction.recall).toBeCloseTo(1, 5)
    expect(report.extraction.f1).toBeCloseTo(1, 5)
    expect(report.extraction.totalViolations).toBe(0)

    // Every decision kind must be reachable, or the suite is not exercising the
    // full decision space.
    expect(report.evolution.accuracy).toBeCloseTo(1, 5)
    const expectedKinds = new Set(report.evolution.cases.map((c) => c.expected))
    expect(expectedKinds.size).toBeGreaterThanOrEqual(5)
  }, 120_000)

  it("scores a model that stores nothing at zero", async () => {
    const report = await runEval({ provider: "null", label: "null-calibration" })

    expect(report.extraction.f1).toBe(0)
    // It must also store literally nothing, not merely score badly.
    for (const c of report.extraction.cases) {
      expect(c.produced).toHaveLength(0)
    }
  }, 120_000)

  it("filters irrelevant memories under the oracle (negative cases)", async () => {
    const report = await runEval({ provider: "oracle", filter: "rec-", label: "oracle-recall" })
    // Negative accuracy is the property the harness CAN guarantee regardless of
    // embedding quality: a memory must not be surfaced when nothing is relevant.
    expect(report.recall.negativeAccuracy).toBeCloseTo(1, 5)
    expect(report.recall.forbiddenViolationRate).toBe(0)
  }, 120_000)

  /**
   * The README publishes the offline recall rows, and nothing pinned them.
   *
   * These rows are the *stand-in* stack, so they depend on the stand-in's own
   * configuration in two ways, and both are recorded in the fingerprint:
   *
   *  - the similarity floor is chosen per embedding provider, so
   *    `MP_EMBEDDING_PROVIDER` decides it (0.15 for `mock`, 0.65 for `ollama`).
   *    Pinned here rather than inherited, so the assertion is the same on every
   *    machine.
   *  - `MockEmbedding` hashes each token into `hash % dim`, so the vectors — and
   *    therefore recall — depend on the vector WIDTH, which the schema fixes.
   *    A fresh `pnpm migrate` creates `vector(1024)`, and that is what CI runs, so
   *    the exact figures are asserted at that width. A developer whose database
   *    is a different width gets different numbers for the same reason a
   *    different floor gives different numbers: their configuration differs from
   *    the documented default, which is what `eval:compare` is for.
   *
   * The negative accuracy has no such caveat — it is the property the design
   * actually guarantees — so it is asserted unconditionally.
   *
   * The aggregate moved from 0.750 / 0.857 to 0.646 / 0.708 for one reason: the
   * suite grew ten cases (rec-015 .. rec-024) placed *inside* the probe band, and
   * a hashing bag-of-tokens has no notion of a paraphrase, which is exactly what
   * those cases require. The suite got harder; the system did not get worse.
   * Telling those apart is the whole reason the dataset hash is in the
   * fingerprint.
   */
  it("reproduces the published offline recall rows at the default configuration", async () => {
    const previous = process.env.MP_RECALL_MIN_SEMANTIC_SIMILARITY
    process.env.MP_RECALL_MIN_SEMANTIC_SIMILARITY = "0.15"
    try {
      for (const provider of ["oracle", "mock"] as const) {
        const report = await runEval({ provider, filter: "rec-", label: `${provider}-recall` })

        // True at every width and floor: the stand-in stack never returns a
        // memory it should not. This is the guarantee, so it is not conditional.
        expect(report.recall.negativeAccuracy).toBeCloseTo(1, 5)
        expect(report.recall.forbiddenViolationRate).toBe(0)

        if (report.fingerprint.embeddingDim !== 1024) continue

        expect(report.recall.precisionAtK).toBeCloseTo(0.646, 3)
        expect(report.recall.recallAtK).toBeCloseTo(0.708, 3)

        // Seven misses, and the list is the point: every one needs a term that
        // appears only in the memory and never in the query, so a hashing
        // embedder cannot reach it and the lexical and entity routes have no
        // shared token to match. Pinning the list means a case that starts
        // failing surfaces as a changed claim rather than a quietly lower mean.
        const missed = report.recall.cases.filter((c) => c.recallAtK < 1).map((c) => c.id)
        expect(missed).toEqual([
          "rec-003",
          "rec-013",
          "rec-015",
          "rec-017",
          "rec-019",
          "rec-022",
          "rec-023",
        ])
      }
    } finally {
      if (previous === undefined) delete process.env.MP_RECALL_MIN_SEMANTIC_SIMILARITY
      else process.env.MP_RECALL_MIN_SEMANTIC_SIMILARITY = previous
    }
  }, 180_000)
})
