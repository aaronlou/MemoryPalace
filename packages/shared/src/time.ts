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
 * Exponential recency decay in [0, 1], with a half-life in days.
 * Used as one signal in recall ranking; deliberately simple and explainable.
 */
export function recencyScore(at: IsoDateTime, reference: IsoDateTime, halfLifeDays = 180): number {
  const age = Math.max(0, daysBetween(at, reference))
  return 0.5 ** (age / halfLifeDays)
}
