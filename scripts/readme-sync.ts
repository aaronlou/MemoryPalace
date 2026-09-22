/**
 * Structural parity check for the two READMEs.
 *
 * The repository documents itself in English and Chinese, and the two are only
 * useful if they stay in step — a translated README that silently misses a
 * section is worse than no translation, because it reads as complete. Prose
 * cannot be compared mechanically across languages, so this compares the parts
 * that are language-independent:
 *
 *   - the sequence of heading LEVELS (a section added to one file shows up here)
 *   - the sequence of fenced code blocks and their info strings
 *   - the sequence of tables and their column counts
 *   - the set of links
 *   - the set of inline code spans — identifiers, commands and paths, which are
 *     deliberately untranslated, so any drift means a concrete claim moved
 *
 * What it cannot check is whether the prose says the same thing. It is a
 * tripwire for the mechanical half, and passing it is not evidence of a good
 * translation — only of a structurally complete one.
 *
 * Run: `pnpm docs:check`
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const EN = join(ROOT, "README.md")
const ZH = join(ROOT, "README.zh-CN.md")

/**
 * The two READMEs link to each other, so those links are expected to differ.
 * Everything else must match.
 */
const SELF_LINKS = new Set(["./README.md", "./README.zh-CN.md"])

interface Skeleton {
  headings: number[]
  fences: string[]
  tables: number[]
  links: string[]
  inlineCode: string[]
  /**
   * Lines whose backticks do not balance, meaning an inline code span runs across
   * a line break. The per-line scanner above then reads the two halves as two
   * separate spans, so this would otherwise hide drift in the inline-code set —
   * and it renders badly besides.
   */
  raggedLines: number[]
}

/** Strip any run of blockquote markers so quoted blocks parse like plain ones. */
function stripQuote(line: string): string {
  let out = line
  for (;;) {
    const m = /^\s*>\s?/.exec(out)
    if (!m) return out
    out = out.slice(m[0].length)
  }
}

function extract(source: string): Skeleton {
  const headings: number[] = []
  const fences: string[] = []
  const tables: number[] = []
  const links = new Set<string>()
  const inlineCode = new Set<string>()
  const raggedLines: number[] = []

  let inFence = false
  let lineNumber = 0
  for (const raw of source.split("\n")) {
    lineNumber++
    const line = stripQuote(raw)

    const fence = /^(`{3,}|~{3,})\s*(.*)$/.exec(line)
    if (fence) {
      // Fences alternate open/close; only the opening line carries an info string.
      if (inFence) inFence = false
      else {
        inFence = true
        fences.push((fence[2] ?? "").trim())
      }
      continue
    }
    // Everything inside a fence is content, not structure: the curl examples
    // contain `#` comments that would otherwise read as headings.
    if (inFence) continue

    const heading = /^(#{1,6})\s+\S/.exec(line)
    if (heading) headings.push(heading[1]!.length)

    // A table's shape is fixed by its separator row, which is far more reliable
    // than counting pipes in a body row (`fast\|smart\|auto` is one cell).
    if (/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/.test(line) && line.includes("|")) {
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|")
      tables.push(cells.length)
    }

    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) links.add(m[1]!)
    for (const m of line.matchAll(/<(https?:\/\/[^>\s]+)>/g)) links.add(m[1]!)
    for (const m of line.matchAll(/`([^`]+)`/g)) inlineCode.add(m[1]!.trim())

    if ((line.match(/`/g)?.length ?? 0) % 2 !== 0) raggedLines.push(lineNumber)
  }

  return {
    headings,
    fences,
    tables,
    links: [...links].filter((l) => !SELF_LINKS.has(l)).sort(),
    inlineCode: [...inlineCode].sort(),
    raggedLines,
  }
}

/** Describe the first place two sequences diverge, in terms the reader can act on. */
function compareSequence(name: string, a: unknown[], b: unknown[], problems: string[]): void {
  if (a.length !== b.length) {
    problems.push(`${name}: ${a.length} in README.md vs ${b.length} in README.zh-CN.md`)
    return
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      problems.push(
        `${name}: entry ${i + 1} differs — ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`,
      )
      return
    }
  }
}

function compareSet(name: string, a: string[], b: string[], problems: string[]): void {
  const inA = new Set(a)
  const inB = new Set(b)
  const onlyEn = a.filter((v) => !inB.has(v))
  const onlyZh = b.filter((v) => !inA.has(v))
  if (onlyEn.length === 0 && onlyZh.length === 0) return
  if (onlyEn.length > 0)
    problems.push(`${name}: only in README.md — ${onlyEn.map((v) => JSON.stringify(v)).join(", ")}`)
  if (onlyZh.length > 0)
    problems.push(
      `${name}: only in README.zh-CN.md — ${onlyZh.map((v) => JSON.stringify(v)).join(", ")}`,
    )
}

function main(): void {
  const en = extract(readFileSync(EN, "utf8"))
  const zh = extract(readFileSync(ZH, "utf8"))

  const problems: string[] = []
  compareSequence("heading levels", en.headings, zh.headings, problems)
  compareSequence("code fences", en.fences, zh.fences, problems)
  compareSequence("table shapes", en.tables, zh.tables, problems)
  compareSet("links", en.links, zh.links, problems)
  compareSet("inline code", en.inlineCode, zh.inlineCode, problems)

  for (const [name, skeleton] of [
    ["README.md", en],
    ["README.zh-CN.md", zh],
  ] as const) {
    if (skeleton.raggedLines.length > 0) {
      problems.push(
        `${name}: unbalanced backticks on line(s) ${skeleton.raggedLines.join(", ")} — ` +
          `an inline code span is wrapped across lines; keep it on one line`,
      )
    }
  }

  if (problems.length === 0) {
    const summary = [
      `${en.headings.length} headings`,
      `${en.fences.length} code blocks`,
      `${en.tables.length} tables`,
      `${en.links.length} links`,
      `${en.inlineCode.length} inline-code spans`,
    ].join(", ")
    process.stdout.write(`readme-sync: README.md and README.zh-CN.md agree (${summary}).\n`)
    return
  }

  process.stderr.write(
    `\nreadme-sync: the two READMEs have drifted apart.\n\n` +
      problems.map((p) => `  - ${p}\n`).join("") +
      `\n  Both files document the same product and must be changed together, in the\n` +
      `  same commit. Fix whichever one is missing the change.\n\n`,
  )
  process.exit(1)
}

main()
