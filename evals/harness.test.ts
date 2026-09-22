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
   * The README publishes the offline recall figures, and nothing pinned them.
   * They drifted: the table claimed 0.750 / 0.857 for `oracle` and `mock`, while
   * the command reported 0.714 / 0.786 — and no commit ever produced 0.857, so a
   * number nobody could reproduce sat in the README as a benchmark.
   *
   * These are not quality gates. The stand-in embedder is a hash, so its recall
   * says nothing about the product; the real stack is the quality measurement.
   * What is asserted here is fidelity — that the table matches what the command
   * prints. If this fails, either the README or the dataset moved, and the two
   * have to move together.
   */
  it("reproduces the offline recall figures the README publishes", async () => {
    for (const provider of ["oracle", "mock"] as const) {
      const report = await runEval({ provider, filter: "rec-", label: `${provider}-recall` })

      expect(report.recall.precisionAtK).toBeCloseTo(0.714, 3)
      expect(report.recall.recallAtK).toBeCloseTo(0.786, 3)
      expect(report.recall.negativeAccuracy).toBeCloseTo(1, 5)

      // The misses are structural and the README names them: each needs a term
      // that appears only in the memory, never in the query. Pinning the list
      // means a case that starts failing shows up as a changed claim rather than
      // a quietly lower average.
      const missed = report.recall.cases.filter((c) => c.recallAtK < 1).map((c) => c.id)
      expect(missed).toEqual(["rec-003", "rec-010", "rec-013"])
    }
  }, 180_000)
})
