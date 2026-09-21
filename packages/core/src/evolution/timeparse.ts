/**
 * Relative time expression resolution.
 *
 * This is deliberately a separate, deterministic module rather than something
 * folded into the extraction prompt. Temporal accuracy is one of the system's
 * headline metrics, and a regex table can be unit-tested exhaustively; an LLM
 * asked to do date arithmetic cannot.
 *
 * Chinese expressions come first because that is the primary input language
 * here, and CJK has no word boundaries, so patterns must not rely on `\b`.
 */

export type TimePrecision = "day" | "week" | "month" | "year" | "vague"

export interface ParsedTime {
  /** ISO-8601 instant the expression resolves to. */
  iso: string
  precision: TimePrecision
  /** The substring that matched, for debugging and for eval explanations. */
  matched: string
}

interface Rule {
  re: RegExp
  precision: TimePrecision
  resolve: (m: RegExpMatchArray, ref: Date) => Date
}

/**
 * All arithmetic is done in UTC, never local time.
 *
 * This matters more than it looks: computing "three days ago" from a local-time
 * midnight and then serialising with `toISOString()` silently shifts the date by
 * the machine's UTC offset, so the same input resolves differently on a laptop
 * in UTC+8 than on a CI runner in UTC. A memory system whose dates depend on
 * where it runs is worse than one with no dates at all.
 */

function startOfDay(d: Date): Date {
  const out = new Date(d.getTime())
  out.setUTCHours(0, 0, 0, 0)
  return out
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  // Set the day to 1 before moving the month, so 31 Jan - 1 month clamps to the
  // last day of February instead of overflowing into March.
  const day = out.getUTCDate()
  out.setUTCDate(1)
  out.setUTCMonth(out.getUTCMonth() + n)
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
  out.setUTCDate(Math.min(day, lastDay))
  return out
}

function addYears(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setUTCFullYear(out.getUTCFullYear() + n)
  return out
}

/** Convert a full-width or Chinese numeral to a number. Handles 1-99. */
export function parseCnNumber(raw: string): number | null {
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  }
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10)

  if (raw === "十") return 10
  const tenIdx = raw.indexOf("十")
  if (tenIdx === -1) {
    const d = digits[raw]
    return d === undefined ? null : d
  }
  const tensPart = raw.slice(0, tenIdx)
  const onesPart = raw.slice(tenIdx + 1)
  const tens = tensPart === "" ? 1 : digits[tensPart]
  const ones = onesPart === "" ? 0 : digits[onesPart]
  if (tens === undefined || ones === undefined) return null
  return tens * 10 + ones
}

const NUM = "(\\d+|[零一二两三四五六七八九十]+)"

const RULES: Rule[] = [
  // --- exact day offsets ---------------------------------------------------
  { re: /前天/, precision: "day", resolve: (_m, ref) => addDays(startOfDay(ref), -2) },
  { re: /昨天|昨日/, precision: "day", resolve: (_m, ref) => addDays(startOfDay(ref), -1) },
  { re: /今天|今日|本日/, precision: "day", resolve: (_m, ref) => startOfDay(ref) },
  { re: /明天|明日/, precision: "day", resolve: (_m, ref) => addDays(startOfDay(ref), 1) },
  { re: /后天/, precision: "day", resolve: (_m, ref) => addDays(startOfDay(ref), 2) },

  // --- counted offsets -----------------------------------------------------
  {
    re: new RegExp(`${NUM}\\s*(?:天|日)(?:前|之前|以前)`),
    precision: "day",
    resolve: (m, ref) => addDays(startOfDay(ref), -(parseCnNumber(m[1]!) ?? 0)),
  },
  {
    re: new RegExp(`${NUM}\\s*(?:个?星期|周|礼拜)(?:前|之前|以前)`),
    precision: "week",
    resolve: (m, ref) => addDays(startOfDay(ref), -7 * (parseCnNumber(m[1]!) ?? 0)),
  },
  {
    re: new RegExp(`${NUM}\\s*个?月(?:前|之前|以前)`),
    precision: "month",
    resolve: (m, ref) => addMonths(startOfDay(ref), -(parseCnNumber(m[1]!) ?? 0)),
  },
  {
    re: new RegExp(`${NUM}\\s*年(?:前|之前|以前)`),
    precision: "year",
    resolve: (m, ref) => addYears(startOfDay(ref), -(parseCnNumber(m[1]!) ?? 0)),
  },

  // --- period-relative -----------------------------------------------------
  {
    re: /上周|上星期|上个?星期/,
    precision: "week",
    resolve: (_m, ref) => addDays(startOfDay(ref), -7),
  },
  {
    re: /这周|本周|这星期|这个?星期/,
    precision: "week",
    resolve: (_m, ref) => addDays(startOfDay(ref), -0),
  },
  { re: /上个?月|上月/, precision: "month", resolve: (_m, ref) => addMonths(startOfDay(ref), -1) },
  { re: /这个?月|本月/, precision: "month", resolve: (_m, ref) => addMonths(startOfDay(ref), 0) },
  { re: /前年/, precision: "year", resolve: (_m, ref) => addYears(startOfDay(ref), -2) },
  { re: /去年|上一年/, precision: "year", resolve: (_m, ref) => addYears(startOfDay(ref), -1) },
  { re: /今年|本年/, precision: "year", resolve: (_m, ref) => addYears(startOfDay(ref), 0) },

  // --- explicit calendar dates --------------------------------------------
  {
    re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/,
    precision: "day",
    resolve: (m, _ref) => new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))),
  },
  {
    re: /(\d{4})\s*年\s*(\d{1,2})\s*月/,
    precision: "month",
    resolve: (m, _ref) => new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  },
  {
    re: /(\d{4})\s*年/,
    precision: "year",
    resolve: (m, _ref) => new Date(Date.UTC(Number(m[1]), 0, 1)),
  },

  // --- English ------------------------------------------------------------
  { re: /\byesterday\b/i, precision: "day", resolve: (_m, ref) => addDays(startOfDay(ref), -1) },
  { re: /\btoday\b/i, precision: "day", resolve: (_m, ref) => startOfDay(ref) },
  { re: /\btomorrow\b/i, precision: "day", resolve: (_m, ref) => addDays(startOfDay(ref), 1) },
  {
    re: /\b(\d+)\s+days?\s+ago\b/i,
    precision: "day",
    resolve: (m, ref) => addDays(startOfDay(ref), -Number(m[1])),
  },
  {
    re: /\b(\d+)\s+weeks?\s+ago\b/i,
    precision: "week",
    resolve: (m, ref) => addDays(startOfDay(ref), -7 * Number(m[1])),
  },
  {
    re: /\b(\d+)\s+months?\s+ago\b/i,
    precision: "month",
    resolve: (m, ref) => addMonths(startOfDay(ref), -Number(m[1])),
  },
  {
    re: /\b(\d+)\s+years?\s+ago\b/i,
    precision: "year",
    resolve: (m, ref) => addYears(startOfDay(ref), -Number(m[1])),
  },
  { re: /\blast\s+week\b/i, precision: "week", resolve: (_m, ref) => addDays(startOfDay(ref), -7) },
  {
    re: /\blast\s+month\b/i,
    precision: "month",
    resolve: (_m, ref) => addMonths(startOfDay(ref), -1),
  },
  {
    re: /\blast\s+year\b/i,
    precision: "year",
    resolve: (_m, ref) => addYears(startOfDay(ref), -1),
  },

  // --- vague, deliberately last (these must not shadow the specific rules) --
  // "recently" is a real signal but not a date. We anchor it coarsely and mark
  // the precision as vague so ranking can discount it.
  { re: /最近|近来|近期/, precision: "vague", resolve: (_m, ref) => addDays(startOfDay(ref), -14) },
  {
    re: /以前|之前|过去/,
    precision: "vague",
    resolve: (_m, ref) => addMonths(startOfDay(ref), -6),
  },
  {
    re: /\brecently\b|\blately\b/i,
    precision: "vague",
    resolve: (_m, ref) => addDays(startOfDay(ref), -14),
  },
]

/**
 * Resolve the first relative time expression in `text`.
 * Returns null when the text contains no recognisable temporal reference —
 * callers must then fall back to the observation time rather than guessing.
 */
export function parseRelativeTime(text: string, reference: Date): ParsedTime | null {
  for (const rule of RULES) {
    const m = text.match(rule.re)
    if (!m) continue
    const date = rule.resolve(m, reference)
    if (Number.isNaN(date.getTime())) continue
    return { iso: date.toISOString(), precision: rule.precision, matched: m[0] }
  }
  return null
}

/** True when the text contains any temporal expression at all. */
export function hasTemporalExpression(text: string): boolean {
  return RULES.some((r) => r.re.test(text))
}

/**
 * Does this expression describe the past, the present, or the future?
 *
 * Compares UTC calendar days rather than elapsed hours: "tomorrow" is a future
 * date even when it is only 12 hours away, and an hours-based threshold would
 * misclassify it as the present for most of the day.
 */
export function temporalDirection(
  parsed: ParsedTime,
  reference: Date,
): "past" | "present" | "future" {
  const target = new Date(parsed.iso)
  if (Number.isNaN(target.getTime())) return "present"
  const dayOf = (d: Date) =>
    Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000)
  const delta = dayOf(target) - dayOf(reference)
  if (delta === 0) return "present"
  return delta < 0 ? "past" : "future"
}
