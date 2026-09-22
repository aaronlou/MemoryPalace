import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  LlmPort,
  PriorArtEntry,
  PriorArtEvaluationOutput,
  PriorArtInput,
  PriorArtStore,
} from "@memory-palace/core"
import { beforeEach, describe, expect, it } from "vitest"
import type { RepoFacts, RepoFetcher } from "./github-repo.js"
import {
  defaultRepoRoot,
  PriorArtService,
  resetDatasetIndex,
  resolveEvidenceList,
} from "./prior-art.js"
import { capabilityIndex, PriorArtEvaluator } from "./prior-art-evaluate.js"

/**
 * Resolution is the mechanism the Prior art page rests on: "this idea is embodied
 * here" has to point at something that exists, or the page is an essay. These
 * tests use a throwaway tree so nothing depends on the real checkout's contents,
 * except where a case explicitly wants the real one.
 */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "prior-art-"))
  mkdirSync(join(root, "packages", "core"), { recursive: true })
  mkdirSync(join(root, "evals", "datasets"), { recursive: true })
  mkdirSync(join(root, "docs", "adr"), { recursive: true })
  writeFileSync(join(root, "packages", "core", "pipeline.ts"), "line1\nline2\nline3\n")
  writeFileSync(
    join(root, "docs", "adr", "0006-confirmed-rescue.md"),
    "# Confirmed rescue below the floor\n\nBody.\n",
  )
  writeFileSync(
    join(root, "evals", "datasets", "recall.ts"),
    "export const recallCases = [\n" +
      '  { id: "rec-017", note: "must be recalled, judged not measured" },\n' +
      '  { id: "rec-020", note: "the negative half of the pair" },\n]\n',
  )
  return root
}

describe("evidence resolution", () => {
  let root: string

  beforeEach(() => {
    root = makeTree()
    resetDatasetIndex()
  })

  it("resolves a path that exists, with its line anchor", () => {
    const [ok, anchored] = resolveEvidenceList(root, [
      { kind: "path", ref: "packages/core/pipeline.ts" },
      { kind: "path", ref: "packages/core/pipeline.ts:3" },
    ])
    expect(ok).toMatchObject({ resolved: true, detail: "packages/core/pipeline.ts" })
    expect(anchored).toMatchObject({ resolved: true, detail: "packages/core/pipeline.ts:3" })
  })

  it("accepts the #L form of a line anchor", () => {
    const [item] = resolveEvidenceList(root, [
      { kind: "path", ref: "packages/core/pipeline.ts#L2" },
    ])
    expect(item).toMatchObject({ resolved: true, detail: "packages/core/pipeline.ts:2" })
  })

  /**
   * The drift signal. A claim whose file still exists but whose anchor no longer
   * does has been invalidated by a refactor, and saying so is more useful than
   * silently pointing at the wrong line.
   */
  it("reports a line anchor past the end of the file", () => {
    const [item] = resolveEvidenceList(root, [
      { kind: "path", ref: "packages/core/pipeline.ts:99" },
    ])
    expect(item?.resolved).toBe(false)
    expect(item?.problem).toMatch(/only 4 lines/)
  })

  it("reports a missing file rather than throwing", () => {
    const [item] = resolveEvidenceList(root, [{ kind: "path", ref: "packages/core/gone.ts" }])
    expect(item?.resolved).toBe(false)
    expect(item?.problem).toMatch(/no such file/)
  })

  it("resolves a dataset case to the file that defines it", () => {
    const [ok, missing] = resolveEvidenceList(root, [
      { kind: "case", ref: "rec-017" },
      { kind: "case", ref: "rec-999" },
    ])
    expect(ok).toMatchObject({ resolved: true, detail: "evals/datasets/recall.ts — rec-017" })
    expect(missing?.resolved).toBe(false)
    expect(missing?.problem).toMatch(/no dataset case/)
  })

  /**
   * A reference is text the user typed, so it is confined to the checkout. Without
   * this, `../../etc/passwd` would be reported as an existing file.
   */
  it("refuses a reference that escapes the repository", () => {
    const [up, absolute] = resolveEvidenceList(root, [
      { kind: "path", ref: "../../etc/passwd" },
      { kind: "path", ref: "/etc/passwd" },
    ])
    expect(up?.resolved).toBe(false)
    expect(absolute?.resolved).toBe(false)
    expect(absolute?.problem).toMatch(/inside this repository/)
  })

  it("resolves the commit that actually implemented an idea, against the real checkout", () => {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: defaultRepoRoot(),
      encoding: "utf8",
    }).trim()
    const [item] = resolveEvidenceList(defaultRepoRoot(), [{ kind: "commit", ref: sha }])
    expect(item?.resolved).toBe(true)
    expect(item?.detail).toBe(sha.slice(0, 7))
  })

  it("rejects anything that is not a sha before asking git", () => {
    const [item] = resolveEvidenceList(root, [{ kind: "commit", ref: "HEAD; rm -rf /" }])
    expect(item?.resolved).toBe(false)
    expect(item?.problem).toMatch(/not a commit sha/)
  })
})

/** Minimal in-memory store, so the service's rules are testable without Postgres. */
function fakeStore(): PriorArtStore & { rows: PriorArtEntry[] } {
  const rows: PriorArtEntry[] = []
  return {
    rows,
    async list() {
      return rows
    },
    async get(_userId, id) {
      return rows.find((r) => r.id === id)
    },
    async getByRepo(_userId, repo) {
      return rows.find((r) => r.repo === repo)
    },
    async upsert(_userId, input: PriorArtInput, id) {
      // Mirrors the Postgres `ON CONFLICT (user_id, repo) DO UPDATE`: the unique
      // key is the repo, and the existing id survives. A fake that just appends
      // would make the "an edit keeps its id" test pass for the wrong reason.
      const existing = rows.find((r) => r.repo === input.repo)
      const entry: PriorArtEntry = {
        ...input,
        id: existing?.id ?? id ?? `pa_${rows.length + 1}`,
        userId: "u",
        url: input.url ?? `https://github.com/${input.repo}`,
        evidence: input.evidence ?? [],
        addedAt: existing?.addedAt ?? "2026-01-01T00:00:00.000Z",
        reviewedAt: "2026-01-01T00:00:00.000Z",
      }
      if (existing) rows[rows.indexOf(existing)] = entry
      else rows.push(entry)
      return entry
    },
    async remove(_userId, id) {
      const i = rows.findIndex((r) => r.id === id)
      if (i < 0) return false
      rows.splice(i, 1)
      return true
    },
    async setEvaluation(_userId, id, evaluation) {
      const row = rows.find((r) => r.id === id)
      if (!row) return undefined
      row.evaluation = evaluation
      return row
    },
    async withEvaluationState(states) {
      return rows.filter((r) => states.includes(r.evaluation?.state ?? "none"))
    },
  }
}

describe("PriorArtService rules", () => {
  let root: string
  let store: ReturnType<typeof fakeStore>
  let service: PriorArtService

  const base = {
    repo: "owner/name",
    title: "t",
    claim: "c",
    rationale: "r",
  }

  beforeEach(() => {
    root = makeTree()
    resetDatasetIndex()
    store = fakeStore()
    service = new PriorArtService({ store, repoRoot: root })
  })

  it("refuses an adopted entry with nothing behind it", async () => {
    await expect(service.add("u", { ...base, status: "adopted" })).rejects.toThrow(
      /needs at least one evidence reference/,
    )
  })

  it("refuses a watched entry with no exit condition", async () => {
    await expect(service.add("u", { ...base, status: "watched" })).rejects.toThrow(
      /needs a killCriterion/,
    )
  })

  it("refuses evidence that does not resolve, naming the reference", async () => {
    await expect(
      service.add("u", {
        ...base,
        status: "adopted",
        evidence: [{ kind: "path", ref: "packages/core/gone.ts" }],
      }),
    ).rejects.toThrow(/evidence "packages\/core\/gone.ts": no such file/)
  })

  it("accepts an adopted entry whose evidence resolves, and reports it back resolved", async () => {
    const entry = await service.add("u", {
      ...base,
      status: "adopted",
      evidence: [{ kind: "case", ref: "rec-017" }],
    })
    expect(entry.unbacked).toBe(false)
    expect(entry.evidence[0]).toMatchObject({ resolved: true })
  })

  it("marks an entry unbacked once its evidence stops resolving", async () => {
    const entry = await service.add("u", {
      ...base,
      status: "adopted",
      evidence: [{ kind: "path", ref: "packages/core/pipeline.ts" }],
    })
    expect(entry.unbacked).toBe(false)

    // The refactor that invalidates the claim, without touching the database.
    rmSync(join(root, "packages", "core", "pipeline.ts"))
    const [after] = await service.list("u")
    expect(after?.unbacked).toBe(true)
    expect(after?.evidence[0]?.problem).toMatch(/no such file/)
  })

  it("keeps the id when an entry is updated, so its URL does not move", async () => {
    const first = await service.add("u", { ...base, status: "rejected" })
    const updated = await service.update("u", first.id, {
      ...base,
      status: "watched",
      killCriterion: "a case it would catch and we would not",
    })
    expect(updated.id).toBe(first.id)
    expect(store.rows).toHaveLength(1)
  })

  it("404s an update to an entry that does not exist", async () => {
    await expect(
      service.update("u", "pa_missing", { ...base, status: "rejected" }),
    ).rejects.toThrow(/prior-art entry not found/)
  })
})

/** A model that returns exactly what the test tells it to. */
function stubLlm(output: Partial<PriorArtEvaluationOutput>): LlmPort {
  return {
    defaultModelId: "stub",
    async generateObject() {
      return {
        value: {
          title: "T-Mem",
          claim: "Recall is reachability-bounded.",
          rationale: "Overlaps the probe band.",
          suggestedStatus: "partial" as const,
          notTaken: null,
          killCriterion: null,
          evidence: [],
          confidence: 0.7,
          ...output,
        },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, llmCalls: 1 },
        modelId: "stub",
        promptHash: "stub",
        cached: false,
      }
    },
  } as unknown as LlmPort
}

const stubFetcher = (facts: Partial<RepoFacts> = {}): RepoFetcher => ({
  async fetch(repo: string) {
    return { repo, url: `https://github.com/${repo}`, topics: [], readme: "README body", ...facts }
  },
})

/** Poll, because the job is deliberately fire-and-forget. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("timed out waiting for the evaluation")
}

describe("the evaluator's index of this project", () => {
  it("offers real paths and case ids for the model to cite", () => {
    const root = makeTree()
    resetDatasetIndex()
    const index = capabilityIndex(root)
    expect(index).toContain("docs/adr/0006-confirmed-rescue.md — Confirmed rescue below the floor")
    expect(index).toContain("rec-017 — must be recalled, judged not measured")
    expect(index).toContain("case:")
  })
})

describe("evaluating a repository", () => {
  let root: string
  let store: ReturnType<typeof fakeStore>

  const serviceWith = (llm: LlmPort, facts: Partial<RepoFacts> = {}) =>
    new PriorArtService({
      store,
      repoRoot: root,
      evaluator: new PriorArtEvaluator(llm, root),
      fetcher: stubFetcher(facts),
    })

  beforeEach(() => {
    root = makeTree()
    resetDatasetIndex()
    store = fakeStore()
  })

  it("takes a repository and nothing else, then assesses it in the background", async () => {
    const service = serviceWith(stubLlm({ suggestedStatus: "partial" }))
    const created = await service.requestEvaluation("u", "Sherlockwz/T-Mem")

    // The response is immediate and the entry asserts nothing yet.
    expect(created.status).toBe("unevaluated")
    expect(created.evaluation?.state === "pending" || created.evaluation?.state === "running").toBe(
      true,
    )

    const ready = await waitFor(
      () => service.list("u"),
      (entries) => entries[0]?.evaluation?.state === "ready",
    )
    expect(ready[0]!.status).toBe("unevaluated")
    expect(ready[0]!.evaluation?.draft?.claim).toBe("Recall is reachability-bounded.")
    // The revision read travels with the assessment.
    expect(ready[0]!.evaluation?.revision).toBeUndefined()
  })

  /**
   * The rule that makes the whole feature trustworthy: the model proposes
   * citations, the checkout decides. Anything that does not resolve is dropped and
   * reported, never quietly kept.
   */
  it("keeps only the citations that resolve, and reports the ones that do not", async () => {
    const service = serviceWith(
      stubLlm({
        evidence: [
          { kind: "path", ref: "packages/core/pipeline.ts", note: "exists" },
          { kind: "path", ref: "packages/core/invented.ts", note: "does not" },
          { kind: "case", ref: "rec-017", note: "exists" },
          { kind: "case", ref: "rec-999", note: "does not" },
        ],
      }),
    )
    await service.requestEvaluation("u", "owner/name")
    const ready = await waitFor(
      () => service.list("u"),
      (entries) => entries[0]?.evaluation?.state === "ready",
    )

    const draft = ready[0]!.evaluation!.draft!
    expect(draft.evidence.map((e) => e.ref)).toEqual(["packages/core/pipeline.ts", "rec-017"])
    expect(draft.rejectedEvidence.map((e) => e.ref)).toEqual([
      "packages/core/invented.ts",
      "rec-999",
    ])
    expect(draft.rejectedEvidence[0]!.problem).toMatch(/no such file/)
  })

  it("records a failure on the row instead of throwing into the void", async () => {
    const failing: LlmPort = {
      defaultModelId: "stub",
      async generateObject() {
        throw new Error("model exploded")
      },
    } as unknown as LlmPort
    const service = serviceWith(failing)
    await service.requestEvaluation("u", "owner/name")

    const failed = await waitFor(
      () => service.list("u"),
      (entries) => entries[0]?.evaluation?.state === "failed",
    )
    expect(failed[0]!.evaluation?.error).toMatch(/model exploded/)
  })

  it("refuses to assess anything without a model configured", async () => {
    const service = new PriorArtService({ store, repoRoot: root })
    await expect(service.requestEvaluation("u", "owner/name")).rejects.toThrow(
      /evaluation is not available/,
    )
  })

  /**
   * The load-bearing rule survives the new path: accepting an `adopted` draft whose
   * citations were all dropped is refused, exactly as a hand-written one would be.
   */
  it("refuses to accept a claim whose citations did not survive", async () => {
    const service = serviceWith(
      stubLlm({
        suggestedStatus: "adopted",
        evidence: [{ kind: "path", ref: "packages/core/invented.ts", note: null }],
      }),
    )
    await service.requestEvaluation("u", "owner/name")
    const ready = await waitFor(
      () => service.list("u"),
      (entries) => entries[0]?.evaluation?.state === "ready",
    )
    const draft = ready[0]!.evaluation!.draft!

    await expect(
      service.adopt("u", ready[0]!.id, {
        repo: ready[0]!.repo,
        title: draft.title,
        claim: draft.claim,
        status: "adopted",
        rationale: draft.rationale,
        evidence: draft.evidence,
      }),
    ).rejects.toThrow(/needs at least one evidence reference/)
  })

  it("accepts an edited draft, marking the evaluation as accepted", async () => {
    const service = serviceWith(
      stubLlm({ evidence: [{ kind: "case", ref: "rec-017", note: null }] }),
    )
    await service.requestEvaluation("u", "owner/name")
    const ready = await waitFor(
      () => service.list("u"),
      (entries) => entries[0]?.evaluation?.state === "ready",
    )
    const draft = ready[0]!.evaluation!.draft!

    const adopted = await service.adopt("u", ready[0]!.id, {
      repo: ready[0]!.repo,
      title: draft.title,
      claim: draft.claim,
      status: "partial",
      rationale: draft.rationale,
      notTaken: draft.notTaken,
      evidence: draft.evidence,
    })
    expect(adopted.status).toBe("partial")
    expect(adopted.evaluation?.state).toBe("accepted")
    expect(adopted.unbacked).toBe(false)
  })

  it("dismisses by removing the entry, because it only ever held a URL", async () => {
    const service = serviceWith(stubLlm({}))
    const created = await service.requestEvaluation("u", "owner/name")
    expect(await service.dismiss("u", created.id)).toBe(true)
    expect(await service.list("u")).toEqual([])
  })

  /**
   * A job can only advance while the process is alive, so anything left in flight
   * at startup belongs to a run that died. Failing it offers the retry button;
   * leaving it would spin forever.
   */
  it("fails evaluations a restart interrupted", async () => {
    const service = serviceWith(stubLlm({}))
    const created = await service.requestEvaluation("u", "owner/name")
    await waitFor(
      () => service.list("u"),
      (entries) => entries[0]?.evaluation?.state === "ready",
    )
    // Simulate a job that was mid-flight when the process stopped.
    await store.setEvaluation("u", created.id, {
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    })

    expect(await service.recoverInterrupted()).toBe(1)
    const after = await service.list("u")
    expect(after[0]!.evaluation?.state).toBe("failed")
    expect(after[0]!.evaluation?.error).toMatch(/interrupted by a restart/)
    // A finished entry is left alone.
    expect(await service.recoverInterrupted()).toBe(0)
  })
})
