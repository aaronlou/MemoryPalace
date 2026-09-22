/**
 * Prior art CLI.
 *
 *   pnpm prior-art check   resolve every reference in the seed against this checkout
 *   pnpm prior-art seed    insert the seed into the database (idempotent)
 *   pnpm prior-art list    print what the database holds, with broken references flagged
 *
 * `check` needs no database on purpose, which is why CI can run it: a file rename
 * that invalidates a claim of the form "this idea is embodied here" should fail
 * the build, not sit on a page looking authoritative until someone notices.
 */
import { createRuntime, defaultRepoRoot, resolveEvidenceList } from "@memory-palace/runtime"
import { PRIOR_ART_SEED } from "./prior-art-seed.js"

const command = process.argv[2] ?? "check"

async function check(): Promise<number> {
  const repoRoot = defaultRepoRoot()
  let broken = 0

  for (const entry of PRIOR_ART_SEED) {
    const resolved = resolveEvidenceList(repoRoot, entry.evidence ?? [])
    const bad = resolved.filter((e) => !e.resolved)
    const mark = bad.length === 0 ? "ok  " : "FAIL"
    console.log(`${mark} ${entry.repo}  (${entry.evidence?.length ?? 0} references)`)
    for (const item of resolved) {
      console.log(
        `       ${item.resolved ? "→" : "✗"} ${item.detail ?? item.ref}${item.problem ? ` — ${item.problem}` : ""}`,
      )
    }
    broken += bad.length
  }

  if (broken > 0) {
    console.error(
      `\n${broken} reference(s) do not resolve. An entry claims this repository embodies an\n` +
        `idea, so a path that no longer exists means that claim is no longer true. Update\n` +
        `scripts/prior-art-seed.ts and, if the assessment changed, write it down.\n`,
    )
    return 1
  }
  console.log(`\nAll references resolve against ${repoRoot}.`)
  return 0
}

async function seed(): Promise<number> {
  const runtime = createRuntime({ config: { logLevel: "error" } })
  try {
    for (const entry of PRIOR_ART_SEED) {
      const stored = await runtime.priorArt.add(runtime.config.userId, entry)
      console.log(`seeded ${stored.repo} (${stored.status}, ${stored.evidence.length} references)`)
    }
    console.log(`\n${PRIOR_ART_SEED.length} entry(ies) seeded for ${runtime.config.userId}.`)
    return 0
  } finally {
    await runtime.close()
  }
}

async function list(): Promise<number> {
  const runtime = createRuntime({ config: { logLevel: "error" } })
  try {
    const entries = await runtime.priorArt.list(runtime.config.userId)
    if (entries.length === 0) {
      console.log("No prior-art entries. Run: pnpm prior-art seed")
      return 0
    }
    let broken = 0
    for (const entry of entries) {
      const bad = entry.evidence.filter((e) => !e.resolved)
      broken += bad.length
      console.log(`${entry.status.padEnd(9)} ${entry.repo}  — ${entry.title}`)
      for (const item of entry.evidence) {
        console.log(
          `    ${item.resolved ? "→" : "✗"} ${item.detail ?? item.ref}${item.problem ? ` — ${item.problem}` : ""}`,
        )
      }
      if (entry.unbacked) console.log("    ! marked " + entry.status + " but nothing resolves")
    }
    console.log(`\n${entries.length} entry(ies), ${broken} broken reference(s).`)
    return broken > 0 ? 1 : 0
  } finally {
    await runtime.close()
  }
}

const run = command === "seed" ? seed : command === "list" ? list : check
if (!["check", "seed", "list"].includes(command)) {
  console.error(`unknown command "${command}". Use: check | seed | list`)
  process.exit(2)
}
process.exit(await run())
