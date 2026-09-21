import type { ExpectMemory } from "./datasets/index.js"
import { normaliseForMatch } from "./datasets/types.js"

/**
 * Metric primitives.
 *
 * Kept pure and separate from the harness so the harness's own correctness can
 * be tested: an oracle implementation must score 1.0 and an empty one 0.0. If
 * those two checks do not hold, a number like "F1 = 0.63" means nothing.
 */

export interface ProducedMemory {
  type: string
  content: string
}

export function matchesExpectation(memory: ProducedMemory, expectation: ExpectMemory): boolean {
  if (expectation.type && memory.type !== expectation.type) return false
  if (expectation.types && !expectation.types.includes(memory.type as never)) return false
  const haystack = normaliseForMatch(memory.content)
  return expectation.contentContains.every((fragment) =>
    haystack.includes(normaliseForMatch(fragment)),
  )
}

export function precisionRecallF1(
  tp: number,
  fp: number,
  fn: number,
): {
  precision: number
  recall: number
  f1: number
} {
  // Nothing expected and nothing produced is a correct answer, not a failure.
  // Returning 0 here would make every negative case look like a miss and hide
  // the real signal behind a permanently depressed average.
  if (tp === 0 && fp === 0 && fn === 0) return { precision: 1, recall: 1, f1: 1 }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  // Nothing was expected, so nothing was missed: recall is vacuously 1 even
  // when the system produced spurious output. Precision is what suffers there,
  // and conflating the two would hide which failure mode occurred.
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1 }
}

/** Mean of a list, treating an empty list as 0 so an all-failure run cannot look perfect. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * Greedy one-to-one matching between produced memories and expectations.
 *
 * One-to-one matters: without it, a single memory containing both fragments
 * would satisfy two expectations and inflate recall.
 */
export function matchSets(
  produced: ProducedMemory[],
  expected: ExpectMemory[],
): { tp: number; fp: number; fn: number; matchedExpected: number[]; matchedProduced: number[] } {
  const usedProduced = new Set<number>()
  const matchedExpected: number[] = []
  const matchedProduced: number[] = []

  for (const [ei, expectation] of expected.entries()) {
    const pi = produced.findIndex(
      (m, i) => !usedProduced.has(i) && matchesExpectation(m, expectation),
    )
    if (pi === -1) continue
    usedProduced.add(pi)
    matchedExpected.push(ei)
    matchedProduced.push(pi)
  }

  const tp = matchedExpected.length
  return {
    tp,
    fp: produced.length - tp,
    fn: expected.length - tp,
    matchedExpected,
    matchedProduced,
  }
}

export function countViolations(produced: ProducedMemory[], forbidden: ExpectMemory[]): number {
  let count = 0
  for (const rule of forbidden) {
    if (produced.some((m) => matchesExpectation(m, rule))) count += 1
  }
  return count
}

/** Precision@k and recall@k over an ordered result list. */
export function precisionAtK(returned: string[], expected: string[], k: number): number {
  const top = returned.slice(0, k)
  if (top.length === 0) return expected.length === 0 ? 1 : 0
  const hits = top.filter((content) =>
    expected.some((e) => normaliseForMatch(content).includes(normaliseForMatch(e))),
  ).length
  return hits / top.length
}

export function recallAtK(returned: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 1
  const top = returned.slice(0, k)
  const hits = expected.filter((e) =>
    top.some((content) => normaliseForMatch(content).includes(normaliseForMatch(e))),
  ).length
  return hits / expected.length
}

export function formatRatio(value: number): string {
  return value.toFixed(3)
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
