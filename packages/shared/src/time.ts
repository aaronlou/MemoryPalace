/**
 * Time is the hardest part of this system, so it gets its own module.
 *
 * Two rules that everything else depends on:
 *  1. Domain types use ISO-8601 strings, never `Date`. LLM schemas must be
 *     JSON-friendly (Zod's `z.toJSONSchema()` throws on `z.date()`), and a
 *     string round-trips through JSON, Postgres and MCP without ambiguity.
 *  2. "Now" is always injected, never read from the ambient clock, so that
 *     temporal behaviour is deterministic under test.
 */

export type IsoDateTime = string

export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

/** A clock frozen at a fixed instant, or advanced manually. Useful in tests. */
export class FixedClock implements Clock {
  private current: Date

  constructor(at: Date | string) {
    this.current = typeof at === "string" ? new Date(at) : new Date(at.getTime())
  }

  now(): Date {
    return new Date(this.current.getTime())
  }

  set(at: Date | string): void {
    this.current = typeof at === "string" ? new Date(at) : new Date(at.getTime())
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
}

export function toIso(d: Date | string): IsoDateTime {
  return (typeof d === "string" ? new Date(d) : d).toISOString()
}

export function nowIso(clock: Clock = systemClock): IsoDateTime {
  return clock.now().toISOString()
}

/** True when `a` is strictly before `b`. */
export function isBefore(a: IsoDateTime, b: IsoDateTime): boolean {
  return new Date(a).getTime() < new Date(b).getTime()
}

/** Number of days between two instants (b - a). */
export function daysBetween(a: IsoDateTime, b: IsoDateTime): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000
}

/** Clamp an ISO string to a parsable value, returning undefined on garbage. */
export function tryIso(value: unknown): IsoDateTime | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/**
 * A date the model *stated*, coerced to a real instant.
 *
 * The extraction schema asks for "ISO-8601 date", and a model that reads
 * "2026年6月" will write `2026-06` — a perfectly valid ISO-8601 year-month, and a
 * perfectly invalid `timestamptz` literal, so the insert fails and the user's
 * sentence is lost. `tryIso` cannot be used alone here, because it delegates to
 * `new Date()`, which reads any *non*-ISO form in the machine's local timezone:
 *
 *     new Date("June 2026")  →  2026-05-31T16:00:00Z   (in UTC+8)
 *
 * That would make a stored date depend on where the process runs, which is the
 * one thing this module exists to prevent. So: recognise the shapes explicitly
 * and build every one of them in UTC. A partial date resolves to the *start* of
 * the period it names — `2026-06` becomes June 1st, not an arbitrary day.
 *
 * Anything not recognised is dropped rather than guessed. The caller falls back
 * to "when we learned it", which is honest; a timezone-shifted invention is not.
 */
export function normaliseStatedDate(value: unknown): IsoDateTime | undefined {
  if (typeof value !== "string") return undefined
  const raw = value.trim()
  if (raw === "") return undefined

  // Year-only, year-month, or full date — in ISO, slash or CJK notation. Kept as
  // three anchored patterns rather than one clever one: the trailing 月/日 are
  // optional in Chinese and "2026年6月" ends without a day, which a single
  // optional-group pattern silently fails to match.
  const yearOnly = /^(\d{4})\s*年?$/.exec(raw)
  if (yearOnly) return utcFromParts(yearOnly[1])

  const yearMonth = /^(\d{4})\s*[-/年]\s*(\d{1,2})\s*月?$/.exec(raw)
  if (yearMonth) return utcFromParts(yearMonth[1], yearMonth[2])

  const fullDate = /^(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?$/.exec(raw)
  if (fullDate) return utcFromParts(fullDate[1], fullDate[2], fullDate[3])

  // A time component. Honour an explicit offset; otherwise read as UTC rather
  // than silently inheriting the machine's, which `new Date()` would do.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) {
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
    return tryIso(hasZone ? raw : `${raw.replace(" ", "T")}Z`)
  }

  return undefined
}

/** Build a UTC instant from date parts, rejecting impossible calendar dates. */
function utcFromParts(
  year: string | undefined,
  month?: string,
  day?: string,
): IsoDateTime | undefined {
  if (year === undefined) return undefined
  const y = Number(year)
  const m = month === undefined ? 1 : Number(month)
  const d = day === undefined ? 1 : Number(day)
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const ms = Date.UTC(y, m - 1, d)
  const date = new Date(ms)
  // Round-trip check: Date.UTC happily rolls 2026-02-31 over into March.
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined
  return date.toISOString()
}

/**
 * Exponential recency decay in [0, 1], with a half-life in days.
 * Used as one signal in recall ranking; deliberately simple and explainable.
 */
export function recencyScore(at: IsoDateTime, reference: IsoDateTime, halfLifeDays = 180): number {
  const age = Math.max(0, daysBetween(at, reference))
  return 0.5 ** (age / halfLifeDays)
}
