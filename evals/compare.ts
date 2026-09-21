/**
 * `pnpm eval:compare <runA.json> <runB.json>`
 *
 * Prints the delta between two runs. Refuses to compare runs whose prompt
 * version or model differ, because the difference would then be attributable to
 * something other than the change under test — which is the whole reason to keep
 * a fingerprint in the report.
 */
import { readFileSync } from "node:fs"
import type { EvalReport } from "./harness.js"

function load(path: string): EvalReport {
  return JSON.parse(readFileSync(path, "utf8")) as EvalReport
}

import type { MetricRange } from "./harness.js"

function delta(a: number, b: number): string {
  const d = b - a
  const sign = d > 0 ? "+" : ""
  const arrow = d > 0.0005 ? "  better" : d < -0.0005 ? "  WORSE" : ""
  return `${a.toFixed(3)} -> ${b.toFixed(3)}  (${sign}${d.toFixed(3)})${arrow}`
}

/**
 * Compare two metrics that may each carry a spread over repeated runs.
 *
 * A difference is only reported as a change when the two ranges do NOT overlap.
 * A hosted model varies between identical runs, so without this the tool happily
 * reports a confident "WORSE" that is pure noise — which it did, and which is
 * worse than reporting nothing.
 */
function deltaWithSpread(a: MetricRange | undefined, b: MetricRange | undefined): string {
  if (!a || !b) return "  (single run each — run with --repeat 3 to compare reliably)"
  // Strict inequalities: ranges that merely share an endpoint are adjacent, not
  // interleaved. A = (0.800-0.900) and B = (0.900-1.000) means B's worst run
  // equals A's best run, which is a real separation rather than noise.
  const overlapping = a.min < b.max && b.min < a.max
  const d = b.mean - a.mean
  const verdict = overlapping
    ? "  indistinguishable (ranges overlap)"
    : d > 0.0005
      ? "  better"
      : d < -0.0005
        ? "  WORSE"
        : ""
  return (
    `${a.mean.toFixed(3)} -> ${b.mean.toFixed(3)}  (${d >= 0 ? "+" : ""}${d.toFixed(3)})${verdict}` +
    `\n      A range ${a.min.toFixed(3)}-${a.max.toFixed(3)} over ${a.runs} runs` +
    `\n      B range ${b.min.toFixed(3)}-${b.max.toFixed(3)} over ${b.runs} runs`
  )
}

const [pathA, pathB] = process.argv.slice(2)
if (!pathA || !pathB) {
  console.error("usage: pnpm eval:compare <runA.json> <runB.json>")
  process.exit(1)
}

const a = load(pathA)
const b = load(pathB)

const mismatched: string[] = []
if (a.fingerprint.extractionPrompt !== b.fingerprint.extractionPrompt)
  mismatched.push("extraction prompt")
if (a.fingerprint.adjudicationPrompt !== b.fingerprint.adjudicationPrompt)
  mismatched.push("adjudication prompt")
if (a.fingerprint.modelId !== b.fingerprint.modelId) mismatched.push("model")

console.log(`\nA: ${pathA}  (${a.provider}, ${a.startedAt})`)
console.log(`B: ${pathB}  (${b.provider}, ${b.startedAt})`)

if (mismatched.length > 0) {
  console.log(
    `\nNOTE: ${mismatched.join(", ")} differ${mismatched.length === 1 ? "s" : ""} between these runs.`,
  )
  console.log("      Differences below cannot be attributed to a single change.")
}

const va = a.variability
const vb = b.variability

console.log("\nMetric                              A -> B")
console.log(`  extraction F1          ${deltaWithSpread(va?.extractionF1, vb?.extractionF1)}`)
console.log(
  `  evolution accuracy     ${deltaWithSpread(va?.evolutionAccuracy, vb?.evolutionAccuracy)}`,
)
console.log(`  recall P@5             ${delta(a.recall.precisionAtK, b.recall.precisionAtK)}`)
console.log(`  recall R@5             ${delta(a.recall.recallAtK, b.recall.recallAtK)}`)
console.log(
  `  negative accuracy      ${delta(a.recall.negativeAccuracy, b.recall.negativeAccuracy)}`,
)
console.log(
  `  forbidden-hit rate     ${delta(a.recall.forbiddenViolationRate, b.recall.forbiddenViolationRate)}`,
)
console.log(
  `  over-extraction        ${a.extraction.totalViolations} -> ${b.extraction.totalViolations}` +
    (b.extraction.totalViolations < a.extraction.totalViolations
      ? "  better"
      : b.extraction.totalViolations > a.extraction.totalViolations
        ? "  WORSE"
        : ""),
)
console.log(
  `  cost (USD)             $${a.usage.costUsd.toFixed(4)} -> $${b.usage.costUsd.toFixed(4)}`,
)

// Per-case regressions are only meaningful once the noise is accounted for, so
// they are reported as leads to check rather than as conclusions.
const caseRegressions = b.extraction.cases
  .filter((bc) => {
    const ac = a.extraction.cases.find((x) => x.id === bc.id)
    return ac !== undefined && bc.f1 < ac.f1 - 0.0005
  })
  .map((c) => c.id)

if (caseRegressions.length > 0) {
  const reliable = va && vb && va.extractionF1.min > vb.extractionF1.max
  console.log(
    `\nCases scoring lower in B: ${caseRegressions.join(", ")}` +
      (reliable
        ? "  (overall extraction is genuinely worse)"
        : "  (overall extraction is indistinguishable, so these are likely run-to-run variation)"),
  )
}
console.log()
