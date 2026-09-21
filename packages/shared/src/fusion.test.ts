import { describe, expect, it } from "vitest"
import { fuseAndNormalize, normalizeRrf, reciprocalRankFusion } from "./fusion.js"

describe("reciprocalRankFusion", () => {
  it("rewards items that appear in more routes", () => {
    const fused = reciprocalRankFusion([
      { route: "semantic", items: [{ id: "a" }, { id: "b" }] },
      { route: "lexical", items: [{ id: "b" }, { id: "c" }] },
    ])
    // b is top-2 in both lists; a is top-1 in one. b must win.
    expect(fused[0]?.id).toBe("b")
    expect(fused[0]?.routes).toHaveLength(2)
  })

  it("uses rank, not raw score, so incomparable scales still fuse", () => {
    // A cosine score of 0.9 and a ts_rank of 0.001 contribute identically when
    // they occupy the same rank — that is the whole point.
    const fused = reciprocalRankFusion([
      { route: "semantic", items: [{ id: "a", score: 0.9 }] },
      { route: "lexical", items: [{ id: "a", score: 0.0001 }] },
    ])
    const expected = 1 / 61 + 1 / 61
    expect(fused[0]?.rrf).toBeCloseTo(expected, 10)
  })

  it("counts a repeated id only once per route", () => {
    const fused = reciprocalRankFusion([
      { route: "semantic", items: [{ id: "a" }, { id: "a" }, { id: "b" }] },
    ])
    const a = fused.find((f) => f.id === "a")
    expect(a?.routes).toHaveLength(1)
    expect(a?.rrf).toBeCloseTo(1 / 61, 10)
  })

  it("honours route weights and skips zero-weighted routes", () => {
    const fused = reciprocalRankFusion(
      [
        { route: "trusted", items: [{ id: "a" }] },
        { route: "ignored", items: [{ id: "b" }] },
      ],
      60,
      { ignored: 0 },
    )
    expect(fused.map((f) => f.id)).toEqual(["a"])
  })

  it("returns an empty list when every route is empty", () => {
    expect(reciprocalRankFusion([{ route: "semantic", items: [] }])).toEqual([])
    expect(reciprocalRankFusion([])).toEqual([])
  })
})

describe("normalizeRrf", () => {
  it("scales against the number of routes actually used", () => {
    // Two routes produce a higher theoretical maximum than one, so the same
    // raw score must normalise differently — otherwise a single fixed threshold
    // would behave inconsistently between the fast and smart paths.
    const fused = reciprocalRankFusion([{ route: "semantic", items: [{ id: "a" }] }])
    expect(normalizeRrf(fused, 1)[0]).toBeCloseTo(1, 10)
    expect(normalizeRrf(fused, 2)[0]).toBeCloseTo(0.5, 10)
  })

  it("never exceeds 1", () => {
    const fused = reciprocalRankFusion([
      { route: "a", items: [{ id: "x" }] },
      { route: "b", items: [{ id: "x" }] },
    ])
    const normalized = normalizeRrf(fused, 1)
    expect(normalized[0]).toBeLessThanOrEqual(1)
  })
})

describe("fuseAndNormalize", () => {
  it("ignores empty routes when computing the normalisation base", () => {
    const result = fuseAndNormalize([
      { route: "semantic", items: [{ id: "a" }] },
      { route: "lexical", items: [] },
    ])
    // Only one route contributed, so the top item normalises to 1.0.
    expect(result[0]?.normalized).toBeCloseTo(1, 10)
  })
})
