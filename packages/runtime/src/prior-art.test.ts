import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PriorArtEntry, PriorArtInput, PriorArtStore } from "@memory-palace/core"
import { beforeEach, describe, expect, it } from "vitest"
import {
  defaultRepoRoot,
  PriorArtService,
  resetDatasetIndex,
  resolveEvidenceList,
} from "./prior-art.js"

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
  writeFileSync(join(root, "packages", "core", "pipeline.ts"), "line1\nline2\nline3\n")
  writeFileSync(
    join(root, "evals", "datasets", "recall.ts"),
    'export const recallCases = [\n  { id: "rec-017" },\n  { id: "rec-020" },\n]\n',
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
    service = new PriorArtService(store, root)
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
    ).rejects.toThrow(/no prior-art entry/)
  })
})
