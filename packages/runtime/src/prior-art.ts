import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  PriorArtEntry,
  PriorArtEvidence,
  PriorArtInput,
  PriorArtStore,
} from "@memory-palace/core"
import { validatePriorArtInput } from "@memory-palace/core"
import { ValidationError } from "@memory-palace/shared"

/**
 * Prior art, with every reference resolved against the working tree.
 *
 * The feature's whole value is that "this idea is embodied here" points at
 * something that exists. A page of prose about one's influences is unfalsifiable
 * and rots silently; a page whose claims resolve to a file, a case id or a commit
 * fails visibly when the artifact moves. So resolution happens twice on purpose:
 *
 *  - on write, where an unresolvable reference is a 400 — you cannot record a
 *    claim that nothing backs;
 *  - on read, where a reference that USED to resolve is reported as broken rather
 *    than hidden. That is the drift signal.
 *
 * Deliberately not LLM-judged anywhere. The model may draft a summary (a later
 * slice), but "embodied" is a filesystem fact, not an opinion.
 */

export interface ResolvedEvidence extends PriorArtEvidence {
  resolved: boolean
  /** Where it resolved to, for display: `packages/core/src/recall/pipeline.ts:317`. */
  detail?: string
  /** Why it did not resolve. Shown in the UI next to the claim it was backing. */
  problem?: string
}

export interface ResolvedPriorArtEntry extends Omit<PriorArtEntry, "evidence"> {
  evidence: ResolvedEvidence[]
  /** Convenience for the UI: an adopted/partial entry with no resolved evidence. */
  unbacked: boolean
}

/**
 * The checkout the references are resolved against.
 *
 * Computed from this module's own location rather than the working directory, so
 * the API server and the CLI agree regardless of where they were started — and
 * so a server started from `/` does not resolve everything as missing. Both
 * `src/` and `dist/` sit three levels under the repo root.
 */
export function defaultRepoRoot(): string {
  const override = process.env.MP_REPO_ROOT
  if (override) return resolve(override)
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
}

const LINE_ANCHOR = /^(.*?)(?:#L?(\d+)|:(\d+))$/

/** Ids in the golden datasets, read once and reused for the process's lifetime. */
let datasetIndex: Map<string, string> | undefined

function datasetCases(repoRoot: string): Map<string, string> {
  if (datasetIndex) return datasetIndex
  const found = new Map<string, string>()
  const dir = join(repoRoot, "evals", "datasets")
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue
      const text = readFileSync(join(dir, name), "utf8")
      for (const m of text.matchAll(/\bid:\s*"([a-z]+-\d+)"/g))
        found.set(m[1]!, `evals/datasets/${name}`)
    }
  }
  datasetIndex = found
  return found
}

/** Reset the memoised dataset index. Tests use this when they stub the tree. */
export function resetDatasetIndex(): void {
  datasetIndex = undefined
}

/**
 * Resolve a batch of references without a database.
 *
 * Exported for `pnpm prior-art check`, which CI runs over the seed content: a
 * renamed file should break the build rather than silently invalidate a page.
 */
export function resolveEvidenceList(
  repoRoot: string,
  items: PriorArtEvidence[],
): ResolvedEvidence[] {
  return items.map((item) => resolveEvidence(repoRoot, item))
}

function resolveEvidence(repoRoot: string, item: PriorArtEvidence): ResolvedEvidence {
  const ref = item.ref.trim()

  if (item.kind === "case") {
    const where = datasetCases(repoRoot).get(ref)
    return where
      ? { ...item, resolved: true, detail: `${where} — ${ref}` }
      : { ...item, resolved: false, problem: `no dataset case with id "${ref}"` }
  }

  if (item.kind === "commit") {
    // Validated before it reaches the shell argument. execFile does not go through
    // a shell, but a sha that is not a sha has no business being looked up either.
    if (!/^[0-9a-f]{7,40}$/.test(ref)) {
      return { ...item, resolved: false, problem: `"${ref}" is not a commit sha` }
    }
    try {
      const sha = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      return { ...item, resolved: true, detail: sha.slice(0, 7) }
    } catch {
      return { ...item, resolved: false, problem: `no commit ${ref} in this checkout` }
    }
  }

  const anchor = LINE_ANCHOR.exec(ref)
  const rel = (anchor?.[1] ?? ref).trim()
  const line = anchor?.[2] ?? anchor?.[3]

  // A reference is data the user typed, so it is confined to the checkout. Without
  // this, `../../etc/passwd` would be reported as existing.
  const full = resolve(repoRoot, rel)
  if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) {
    return { ...item, resolved: false, problem: `"${ref}" must be a path inside this repository` }
  }
  if (!full.startsWith(repoRoot + sep)) {
    return { ...item, resolved: false, problem: `"${ref}" escapes the repository` }
  }
  if (!existsSync(full)) return { ...item, resolved: false, problem: `no such file: ${rel}` }
  if (!statSync(full).isFile())
    return { ...item, resolved: false, problem: `${rel} is a directory` }

  const detail = line ? `${rel}:${line}` : rel
  if (line) {
    const lines = readFileSync(full, "utf8").split("\n").length
    if (Number(line) > lines) {
      // The file survived but the anchor did not — usually a refactor. Worth
      // surfacing: the claim is now pointing at nothing in particular.
      return { ...item, resolved: false, detail, problem: `${rel} has only ${lines} lines` }
    }
  }
  return { ...item, resolved: true, detail }
}

export class PriorArtService {
  private readonly store: PriorArtStore
  private readonly repoRoot: string

  constructor(store: PriorArtStore, repoRoot: string = defaultRepoRoot()) {
    this.store = store
    this.repoRoot = repoRoot
  }

  /** Every entry, with each reference re-resolved now — not as it was when saved. */
  async list(userId: string): Promise<ResolvedPriorArtEntry[]> {
    const entries = await this.store.list(userId)
    return entries.map((e) => this.decorate(e))
  }

  async add(userId: string, input: PriorArtInput): Promise<ResolvedPriorArtEntry> {
    this.assertValid(input)
    return this.decorate(await this.store.upsert(userId, input))
  }

  async update(userId: string, id: string, input: PriorArtInput): Promise<ResolvedPriorArtEntry> {
    const existing = await this.store.get(userId, id)
    if (!existing) throw new ValidationError(`no prior-art entry ${id}`, { id })
    this.assertValid(input)
    // Passed through so an edit keeps its id: the URL for an entry should not
    // change because the assessment was corrected.
    return this.decorate(await this.store.upsert(userId, input, id))
  }

  async remove(userId: string, id: string): Promise<boolean> {
    return this.store.remove(userId, id)
  }

  /**
   * Both the model's rules and the filesystem's. Collecting every problem before
   * throwing means one round trip fixes the whole form rather than revealing the
   * faults one at a time.
   */
  private assertValid(input: PriorArtInput): void {
    const problems = validatePriorArtInput(input)
    const resolved = (input.evidence ?? []).map((e) => resolveEvidence(this.repoRoot, e))
    for (const item of resolved) {
      if (!item.resolved) problems.push(`evidence "${item.ref}": ${item.problem}`)
    }
    if (problems.length > 0) {
      throw new ValidationError(`prior-art entry is not valid: ${problems.join("; ")}`, {
        problems,
      })
    }
  }

  private decorate(entry: PriorArtEntry): ResolvedPriorArtEntry {
    const evidence = entry.evidence.map((e) => resolveEvidence(this.repoRoot, e))
    return {
      ...entry,
      evidence,
      unbacked:
        (entry.status === "adopted" || entry.status === "partial") &&
        !evidence.some((e) => e.resolved),
    }
  }
}
