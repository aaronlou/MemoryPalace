import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type {
  LlmPort,
  PriorArtDraft,
  PriorArtEvaluationOutput,
  PriorArtEvidence,
} from "@memory-palace/core"
import {
  PriorArtEvaluationOutput as OutputSchema,
  PRIOR_ART_EVAL_INSTRUCTIONS,
  PRIOR_ART_EVAL_PROMPT_VERSION,
} from "@memory-palace/core"
import type { RepoFacts } from "./github-repo.js"
import { resolveEvidenceList } from "./prior-art.js"

/**
 * Assessing a candidate repository against this one.
 *
 * Two things make this trustworthy rather than plausible-sounding:
 *
 *  1. The model is given an INDEX of what this project actually contains — its
 *     ADRs, its evaluation cases, its source paths — and told to cite only from it.
 *     It cannot invent a file name and have it stick.
 *  2. Every reference it cites is then resolved against the checkout, and the ones
 *     that do not resolve are dropped and listed. The model's citations are a
 *     hypothesis; the filesystem decides.
 *
 * The output is a DRAFT. Nothing here writes to an entry: a human accepts it. That
 * division is the whole reason the model is allowed to be wrong.
 */

export interface EvaluationResult {
  draft: PriorArtDraft
  revision?: string
  repoDescription?: string
}

/** How much of the index to send. Enough to choose from, not enough to bury the task. */
const INDEX_LIMIT = 4000

/**
 * What this project contains, in the form the model has to cite from.
 *
 * Built from the repository rather than hand-maintained: a curated list would go
 * stale, and a stale list is exactly what produces citations that do not resolve.
 */
export function capabilityIndex(repoRoot: string): string {
  const parts: string[] = []

  const adrDir = join(repoRoot, "docs", "adr")
  if (existsSync(adrDir)) {
    const rows = readdirSync(adrDir)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort()
      .map((name) => {
        const text = readFileSync(join(adrDir, name), "utf8")
        const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? ""
        return `- docs/adr/${name}${title ? ` — ${title}` : ""}`
      })
    if (rows.length > 0) parts.push(`## Architecture decisions\n${rows.join("\n")}`)
  }

  const datasetDir = join(repoRoot, "evals", "datasets")
  if (existsSync(datasetDir)) {
    const rows: string[] = []
    for (const name of readdirSync(datasetDir).sort()) {
      if (!name.endsWith(".ts")) continue
      const text = readFileSync(join(datasetDir, name), "utf8")
      // Case id plus its note: the note is what lets the model match a candidate's
      // idea to the case that already covers it.
      for (const m of text.matchAll(/id:\s*"([a-z]+-\d+)",[\s\S]{0,600}?note:\s*"([^"]+)"/g)) {
        rows.push(`- ${m[1]} — ${m[2]}`)
      }
    }
    if (rows.length > 0) {
      parts.push(`## Evaluation cases (cite as \`case:<id>\`)\n${rows.join("\n")}`)
    }
  }

  const sourceRows: string[] = []
  for (const pkg of existsSync(join(repoRoot, "packages"))
    ? readdirSync(join(repoRoot, "packages")).sort()
    : []) {
    const src = join(repoRoot, "packages", pkg, "src")
    if (!existsSync(src)) continue
    for (const file of readdirSync(src).sort()) {
      if (file.endsWith(".test.ts")) continue
      if (file.endsWith(".ts")) sourceRows.push(`- packages/${pkg}/src/${file}`)
    }
  }
  if (sourceRows.length > 0) parts.push(`## Source paths\n${sourceRows.join("\n")}`)

  const index = parts.join("\n\n")
  return index.length > INDEX_LIMIT ? `${index.slice(0, INDEX_LIMIT)}\n… (truncated)` : index
}

/** The candidate, as the model sees it. */
export function candidateBrief(facts: RepoFacts): string {
  const lines = [
    `Repository: ${facts.repo}`,
    `URL: ${facts.url}`,
    facts.description ? `Description: ${facts.description}` : "Description: (none given)",
    facts.topics.length > 0 ? `Topics: ${facts.topics.join(", ")}` : "Topics: (none)",
    facts.language ? `Primary language: ${facts.language}` : "",
    facts.stars !== undefined ? `Stars: ${facts.stars}` : "",
    facts.defaultBranch ? `Default branch: ${facts.defaultBranch}` : "",
    facts.revision ? `Revision: ${facts.revision}` : "",
    "",
    facts.readme
      ? `README${facts.readmeTruncated ? " (truncated)" : ""}:\n${facts.readme}`
      : "README: (none — assess from the description and topics alone, and lower your confidence)",
  ]
  return lines.filter((line) => line !== "").join("\n")
}

export class PriorArtEvaluator {
  private readonly llm: LlmPort
  private readonly repoRoot: string
  private index: string | undefined

  constructor(llm: LlmPort, repoRoot: string) {
    this.llm = llm
    this.repoRoot = repoRoot
  }

  /** Built once and kept: reading the tree per call would be wasteful and silent. */
  private projectIndex(): string {
    this.index ??= capabilityIndex(this.repoRoot)
    return this.index
  }

  async evaluate(facts: RepoFacts): Promise<EvaluationResult> {
    const result = await this.llm.generateObject({
      schema: OutputSchema,
      schemaName: "PriorArtEvaluation",
      instructions: PRIOR_ART_EVAL_INSTRUCTIONS,
      prompt: [
        `## CANDIDATE REPOSITORY\n\n${candidateBrief(facts)}`,
        `## TARGET PROJECT INDEX\n\n${this.projectIndex()}`,
      ].join("\n\n"),
      temperature: 0,
      // Keyed on the revision, so re-running an unchanged repository is free and a
      // moved repository is genuinely re-read.
      cacheKey: `prior-art:${PRIOR_ART_EVAL_PROMPT_VERSION}:${facts.repo}:${facts.revision ?? "unknown"}`,
    })

    return {
      draft: this.ground(result.value),
      revision: facts.revision,
      repoDescription: facts.description,
    }
  }

  /**
   * Keep only the citations that resolve.
   *
   * The model is told to cite from the index and to omit what it cannot ground, but
   * instructions are not a guarantee — so this is where "cited" becomes "true".
   * Dropped references are kept and shown to the reviewer rather than hidden: a
   * draft whose citations all failed is a draft to distrust.
   */
  private ground(value: PriorArtEvaluationOutput): PriorArtDraft {
    const suggested: PriorArtEvidence[] = value.evidence.map((item) => ({
      kind: item.kind,
      ref: item.ref,
      note: item.note ?? undefined,
    }))

    const resolved = resolveEvidenceList(this.repoRoot, suggested)
    const evidence = resolved
      .filter((item) => item.resolved)
      .map(({ kind, ref, note }) => ({ kind, ref, note }))
    const rejectedEvidence = resolved
      .filter((item) => !item.resolved)
      .map((item) => ({ ref: item.ref, problem: item.problem ?? "did not resolve" }))

    return {
      title: value.title.trim(),
      claim: value.claim.trim(),
      rationale: value.rationale.trim(),
      suggestedStatus: value.suggestedStatus,
      notTaken: value.notTaken?.trim() || undefined,
      killCriterion: value.killCriterion?.trim() || undefined,
      evidence,
      rejectedEvidence,
      confidence: value.confidence,
    }
  }
}
