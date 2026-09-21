/**
 * `pnpm eval [--provider mock|oracle|null|real] [--filter ext-00] [--out file]`
 *
 * Prints a report and writes it to evals/runs/<timestamp>-<provider>.json so two
 * runs can be compared after a prompt change.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EvalReport, ProviderKind } from "./harness.js"
import { runEval } from "./harness.js"
import { formatPercent, formatRatio } from "./metrics.js"

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return process.argv[i + 1] ?? fallback
}

const provider = (arg("provider", "mock") ?? "mock") as ProviderKind
const filter = arg("filter")
const recallMode = (arg("recall-mode", "fast") ?? "fast") as "fast" | "smart"
const embedding = arg("embedding") as "mock" | "real" | undefined
const repeat = Math.max(1, Number.parseInt(arg("repeat", "1") ?? "1", 10))

function printReport(report: EvalReport): void {
  console.log(`\n${"═".repeat(78)}`)
  console.log(`  Memory Palace — evaluation report`)
  console.log(`  provider: ${report.provider}   label: ${report.label}   ${report.durationMs}ms`)
  console.log(`${"═".repeat(78)}\n`)

  console.log("EXTRACTION")
  console.log(
    `  precision ${formatRatio(report.extraction.precision)}   ` +
      `recall ${formatRatio(report.extraction.recall)}   ` +
      `F1 ${formatRatio(report.extraction.f1)}`,
  )
  console.log(`  over-extraction violations: ${report.extraction.totalViolations}`)
  for (const c of report.extraction.cases) {
    const flag = c.f1 === 1 ? "ok  " : c.f1 === 0 ? "MISS" : "part"
    console.log(
      `    ${flag} ${c.id}  P=${formatRatio(c.precision)} R=${formatRatio(c.recall)} F1=${formatRatio(c.f1)}` +
        `${c.violations > 0 ? `  violations=${c.violations}` : ""}`,
    )
    if (c.missed.length > 0) {
      console.log(`         missed: ${c.missed.map((m) => m.contentContains.join("+")).join(", ")}`)
    }
  }

  console.log("\nEVOLUTION")
  console.log(`  decision accuracy ${formatPercent(report.evolution.accuracy)}`)
  for (const c of report.evolution.cases) {
    const flag = c.correct ? "ok  " : "WRONG"
    console.log(`    ${flag} ${c.id}  expected=${c.expected} actual=${c.actual}`)
  }
  console.log("  confusion (expected -> actual):")
  for (const [expected, row] of Object.entries(report.evolution.confusion)) {
    const cells = Object.entries(row)
      .map(([actual, n]) => `${actual}×${n}`)
      .join("  ")
    console.log(`    ${expected.padEnd(11)} ${cells}`)
  }

  console.log("\nRECALL")
  console.log(
    `  P@5 ${formatRatio(report.recall.precisionAtK)}   ` +
      `R@5 ${formatRatio(report.recall.recallAtK)}   ` +
      `negative accuracy ${formatPercent(report.recall.negativeAccuracy)}   ` +
      `forbidden-hit rate ${formatPercent(report.recall.forbiddenViolationRate)}`,
  )
  for (const c of report.recall.cases) {
    const flag = c.negativeCorrect && c.forbiddenViolations.length === 0 ? "ok  " : "BAD "
    const detail =
      c.expectedCount === 0
        ? `returned=${c.returnedCount} (expected empty)`
        : `P@5=${formatRatio(c.precisionAtK)} R@5=${formatRatio(c.recallAtK)}`
    console.log(`    ${flag} ${c.id}  ${detail}`)
    if (c.forbiddenViolations.length > 0) {
      console.log(`         FORBIDDEN: ${c.forbiddenViolations.join(" | ")}`)
    }
  }

  console.log("\nUSAGE")
  console.log(
    `  llm calls ${report.usage.llmCalls}   tokens ${report.usage.inputTokens} in / ${report.usage.outputTokens} out   ` +
      `cost $${report.usage.costUsd.toFixed(4)}`,
  )
  console.log()
}

/**
 * Repeat runs, because a hosted model is not deterministic even at temperature 0.
 *
 * Measured on this project: DeepSeek's adjudication accuracy ranged 40%-90%
 * across identical runs. Reporting a single number from that distribution would
 * be misleading — and comparing two single runs after a prompt change would
 * show a difference that is mostly noise.
 */
const reports = []
for (let i = 0; i < repeat; i++) {
  const r = await runEval({ provider, filter, recallMode, embedding, label: provider })
  reports.push(r)
  if (repeat > 1) process.stdout.write(`  run ${i + 1}/${repeat} done\n`)
}

const report = reports[reports.length - 1]!
printReport(report)

const range = (values: number[]) => ({
  mean: values.reduce((a, b) => a + b, 0) / values.length,
  min: Math.min(...values),
  max: Math.max(...values),
  runs: values.length,
})

// Persist the spread alongside the last run, so a later `eval:compare` can tell
// a real change from noise.
if (repeat > 1) {
  report.variability = {
    extractionF1: range(reports.map((r) => r.extraction.f1)),
    evolutionAccuracy: range(reports.map((r) => r.evolution.accuracy)),
    recallPrecisionAt5: range(reports.map((r) => r.recall.precisionAtK)),
    recallRecallAt5: range(reports.map((r) => r.recall.recallAtK)),
    negativeAccuracy: range(reports.map((r) => r.recall.negativeAccuracy)),
  }
}

if (repeat > 1) {
  const stat = (values: number[]) => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    return { mean, min: Math.min(...values), max: Math.max(...values) }
  }
  const f1 = stat(reports.map((r) => r.extraction.f1))
  const dec = stat(reports.map((r) => r.evolution.accuracy))
  const p5 = stat(reports.map((r) => r.recall.precisionAtK))
  const r5 = stat(reports.map((r) => r.recall.recallAtK))
  const neg = stat(reports.map((r) => r.recall.negativeAccuracy))
  const fmt = (s: { mean: number; min: number; max: number }) =>
    `${s.mean.toFixed(3)}  (min ${s.min.toFixed(3)}  max ${s.max.toFixed(3)})`

  console.log(`\n${"═".repeat(78)}`)
  console.log(`  ACROSS ${repeat} RUNS — a hosted model is not deterministic`)
  console.log(`${"═".repeat(78)}`)
  console.log(`  extraction F1        ${fmt(f1)}`)
  console.log(`  evolution accuracy   ${fmt(dec)}`)
  console.log(`  recall P@5           ${fmt(p5)}`)
  console.log(`  recall R@5           ${fmt(r5)}`)
  console.log(`  negative accuracy    ${fmt(neg)}`)
  console.log(
    `  total cost           $${reports.reduce((a, r) => a + r.usage.costUsd, 0).toFixed(4)}`,
  )
  console.log()
}

const dir = join(process.cwd(), "evals", "runs")
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const path = arg("out") ?? join(dir, `${stamp}-${provider}.json`)
writeFileSync(path, JSON.stringify(report, null, 2), "utf8")
console.log(`report written to ${path}\n`)
