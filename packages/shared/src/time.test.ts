import { describe, expect, it } from "vitest"
import { normaliseStatedDate } from "./time.js"

/**
 * `normaliseStatedDate` exists because a model asked for an "ISO-8601 date" will
 * write `2026-06` for "2026年6月" — valid ISO, invalid `timestamptz`, so the
 * insert throws and the user's sentence is lost.
 *
 * The subtle requirement is the second half of that: every form must resolve in
 * UTC. `new Date("June 2026")` reads the string in the machine's local timezone,
 * so the same input would store a different day on a laptop in UTC+8 than on a
 * CI runner in UTC. A memory system whose dates depend on where it runs is worse
 * than one with no dates at all, so unrecognised forms are dropped, not guessed.
 */
describe("normaliseStatedDate", () => {
  it("expands a partial date to the start of the period it names", () => {
    // The reported failure: "2026年6月换成了 React" extracted as "2026-06".
    expect(normaliseStatedDate("2026-06")).toBe("2026-06-01T00:00:00.000Z")
    expect(normaliseStatedDate("2026")).toBe("2026-01-01T00:00:00.000Z")
    expect(normaliseStatedDate("2026-06-15")).toBe("2026-06-15T00:00:00.000Z")
  })

  it("reads CJK and slash notation the same way", () => {
    expect(normaliseStatedDate("2026年6月")).toBe("2026-06-01T00:00:00.000Z")
    expect(normaliseStatedDate("2026年6月15日")).toBe("2026-06-15T00:00:00.000Z")
    expect(normaliseStatedDate("2026年")).toBe("2026-01-01T00:00:00.000Z")
    expect(normaliseStatedDate("2026/6")).toBe("2026-06-01T00:00:00.000Z")
    expect(normaliseStatedDate("2026/6/15")).toBe("2026-06-15T00:00:00.000Z")
  })

  it("preserves a full instant, keeping its offset", () => {
    expect(normaliseStatedDate("2026-06-15T10:30:00Z")).toBe("2026-06-15T10:30:00.000Z")
    // 10:30 in UTC+8 is 02:30 UTC — the offset must be honoured, not discarded.
    expect(normaliseStatedDate("2026-06-15T10:30:00+08:00")).toBe("2026-06-15T02:30:00.000Z")
  })

  it("treats an offset-less timestamp as UTC rather than local time", () => {
    // This is the assertion that would fail if this delegated to `new Date()`
    // under a non-UTC TZ, which is exactly why it does not.
    expect(normaliseStatedDate("2026-06-15T10:30:00")).toBe("2026-06-15T10:30:00.000Z")
    expect(normaliseStatedDate("2026-06-15 10:30")).toBe("2026-06-15T10:30:00.000Z")
  })

  it("drops anything it cannot read deterministically", () => {
    // "June 2026" and "last year" are parseable by `new Date()` in some
    // timezones and not others. Dropping beats guessing: the caller falls back
    // to when the memory was learned, which is at least true.
    expect(normaliseStatedDate("June 2026")).toBeUndefined()
    expect(normaliseStatedDate("last year")).toBeUndefined()
    expect(normaliseStatedDate("yesterday")).toBeUndefined()
    expect(normaliseStatedDate("")).toBeUndefined()
    expect(normaliseStatedDate("   ")).toBeUndefined()
    expect(normaliseStatedDate(null)).toBeUndefined()
    expect(normaliseStatedDate(undefined)).toBeUndefined()
    expect(normaliseStatedDate(20260615)).toBeUndefined()
  })

  it("rejects calendar dates that do not exist", () => {
    expect(normaliseStatedDate("2026-02-31")).toBeUndefined()
    expect(normaliseStatedDate("2026-13")).toBeUndefined()
    expect(normaliseStatedDate("2026-00")).toBeUndefined()
    expect(normaliseStatedDate("2026-06-00")).toBeUndefined()
    // A leap day is real in 2028 and not in 2026.
    expect(normaliseStatedDate("2028-02-29")).toBe("2028-02-29T00:00:00.000Z")
    expect(normaliseStatedDate("2026-02-29")).toBeUndefined()
  })
})
