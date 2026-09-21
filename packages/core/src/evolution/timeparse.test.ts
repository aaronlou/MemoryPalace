import { describe, expect, it } from "vitest"
import {
  hasTemporalExpression,
  parseCnNumber,
  parseRelativeTime,
  temporalDirection,
} from "./timeparse.js"

/**
 * Temporal accuracy is one of the system's headline metrics, so the parser gets
 * exhaustive tests rather than a couple of smoke cases. A wrong date here
 * silently corrupts validity intervals, which then corrupts every
 * "what is true now" answer.
 */

const REF = new Date("2026-09-21T12:00:00Z")

function iso(text: string, ref: Date = REF): string | null {
  return parseRelativeTime(text, ref)?.iso.slice(0, 10) ?? null
}

describe("parseCnNumber", () => {
  it("parses digits, units and compounds", () => {
    expect(parseCnNumber("1")).toBe(1)
    expect(parseCnNumber("十")).toBe(10)
    expect(parseCnNumber("十一")).toBe(11)
    expect(parseCnNumber("二十")).toBe(20)
    expect(parseCnNumber("二十三")).toBe(23)
    expect(parseCnNumber("两")).toBe(2)
  })

  it("returns null for non-numerals", () => {
    expect(parseCnNumber("abc")).toBeNull()
  })
})

describe("parseRelativeTime — Chinese", () => {
  it("resolves day-relative expressions", () => {
    expect(iso("我今天开始学习")).toBe("2026-09-21")
    expect(iso("昨天开始的")).toBe("2026-09-20")
    expect(iso("前天提到的")).toBe("2026-09-19")
  })

  it("resolves counted offsets", () => {
    expect(iso("三天前开始")).toBe("2026-09-18")
    expect(iso("两周前")).toBe("2026-09-07")
    expect(iso("一个月前")).toBe("2026-08-21")
    expect(iso("两年前")).toBe("2024-09-21")
    expect(iso("10天前")).toBe("2026-09-11")
  })

  it("resolves period-relative expressions", () => {
    expect(iso("上周开始用的")).toBe("2026-09-14")
    expect(iso("上个月")).toBe("2026-08-21")
    expect(iso("去年")).toBe("2025-09-21")
    expect(iso("今年")).toBe("2026-09-21")
    expect(iso("前年")).toBe("2024-09-21")
  })

  it("resolves explicit calendar dates", () => {
    expect(iso("2025年3月开始")).toBe("2025-03-01")
    expect(iso("2024年12月25日")).toBe("2024-12-25")
    expect(iso("2023年")).toBe("2023-01-01")
  })

  it("marks vague expressions as vague so ranking can discount them", () => {
    const parsed = parseRelativeTime("最近开始研究", REF)
    expect(parsed?.precision).toBe("vague")
    expect(parsed?.matched).toBe("最近")
  })

  it("prefers a specific expression over a vague one", () => {
    // "最近" appears first textually but "三天前" is the real signal.
    const parsed = parseRelativeTime("最近，准确说是三天前", REF)
    expect(parsed?.matched).toBe("三天前")
    expect(parsed?.precision).toBe("day")
  })
})

describe("parseRelativeTime — English", () => {
  it("resolves the common forms", () => {
    expect(iso("I started today")).toBe("2026-09-21")
    expect(iso("yesterday I switched")).toBe("2026-09-20")
    expect(iso("3 days ago")).toBe("2026-09-18")
    expect(iso("2 weeks ago")).toBe("2026-09-07")
    expect(iso("last month")).toBe("2026-08-21")
    expect(iso("last year")).toBe("2025-09-21")
  })
})

describe("parseRelativeTime — no false positives", () => {
  it("returns null when there is no temporal reference", () => {
    expect(parseRelativeTime("用户正在学习 Effect-TS", REF)).toBeNull()
    expect(hasTemporalExpression("用户正在学习 Effect-TS")).toBe(false)
  })

  it("does not treat a bare year inside a version number as a date", () => {
    // This is a real hazard: "ES2023" must not become the year 2023.
    expect(parseRelativeTime("用户使用 ES2023 语法", REF)).toBeNull()
  })
})

describe("month arithmetic does not overflow", () => {
  it("clamps Jan 31 minus one month to Feb 28/29 rather than Mar 2", () => {
    // Without day-clamping this becomes 2025-03-03, a classic off-by-days bug.
    const parsed = parseRelativeTime("一个月前", new Date("2026-03-31T12:00:00Z"))
    expect(parsed?.iso.slice(0, 10)).toBe("2026-02-28")
  })
})

describe("temporalDirection", () => {
  it("classifies past, present and future", () => {
    const past = parseRelativeTime("三天前", REF)
    const present = parseRelativeTime("今天", REF)
    const future = parseRelativeTime("明天", REF)
    expect(past && temporalDirection(past, REF)).toBe("past")
    expect(present && temporalDirection(present, REF)).toBe("present")
    expect(future && temporalDirection(future, REF)).toBe("future")
  })
})
