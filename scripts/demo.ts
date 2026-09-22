/**
 * End-to-end demo of the design doc's §21 case study.
 *
 * Run with `pnpm demo`. Uses the mock providers by default so it needs no API
 * key; set MP_LLM_PROVIDER/DEEPSEEK_API_KEY to see it run against a real model.
 *
 * Pass --reset to clear this demo user's data first.
 */
import { createRuntime } from "@memory-palace/runtime"
import { loadConfig } from "@memory-palace/shared"
import { wipeUser } from "@memory-palace/storage-pg"

const USER = "demo-user"
const reset = process.argv.includes("--reset")

// `loadConfig` is still exercised so a bad environment fails loudly here rather
// than deep inside the runtime.
loadConfig({ userId: USER, logLevel: "warn" })
const rt = createRuntime({ config: { userId: USER, logLevel: "warn" } })

function heading(text: string): void {
  console.log(`\n${"─".repeat(72)}\n${text}\n${"─".repeat(72)}`)
}

/**
 * The walkthrough makes claims ("empty = correct", "should stay 1"). Printing
 * them without checking them let a real defect hide in plain sight for as long as
 * nobody read the output: step 6 printed `0 (should stay 1)` and looked like part
 * of the demo. A claim printed is documentation; a claim checked is a smoke test,
 * and this is the one command every new user runs first.
 */
const failures: string[] = []
let checks = 0

function check(label: string, ok: boolean): void {
  checks += 1
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`)
  if (!ok) failures.push(label)
}

async function main(): Promise<void> {
  if (reset) {
    await wipeUser(rt.storage.db, USER)
    console.log(`(reset: cleared all data for ${USER})`)
  }

  console.log(rt.llm.describe())

  // ---- 1. the design doc's example input ---------------------------------
  heading("1. User writes, in their own words")

  const input1 =
    "我最近开始系统学习 Effect-TS。以后你给我讲 TypeScript 的时候，先从整体结构和设计思想讲，再深入 API。"
  console.log(`  "${input1}"`)

  const out1 = await rt.palace.remember({ userId: USER, content: input1, sourceKind: "user" })
  console.log(
    `\n  -> ${out1.candidateCount} candidate(s) extracted, ${out1.memories.length} stored:`,
  )
  for (const m of out1.memories) {
    console.log(`     [${m.type}] ${m.content}`)
    console.log(
      `       confidence ${m.confidence.toFixed(2)}  importance ${m.importance.toFixed(2)}`,
    )
  }

  heading("2. Agent recalls while answering a question")

  const question = "Effect-TS 的 Context.Service 怎么理解？"
  console.log(`  Agent is asked: "${question}"`)

  const recall = await rt.palace.recall({
    userId: USER,
    query: question,
    mode: "fast",
  })
  console.log(
    `\n  ${recall.memories.length} memorie(s) recalled via [${recall.diagnostics.routesUsed.join(" + ")}]`,
  )
  console.log(
    `  mode=${recall.mode} latency=${recall.diagnostics.latencyMs}ms tokens≈${recall.diagnostics.estimatedTokens}`,
  )
  console.log("\n  ---- context handed to the model ----")
  for (const line of recall.context.split("\n")) console.log(`  ${line}`)

  check(
    "the agent is given what the user said about Effect-TS",
    recall.memories.some((m) => m.memory.content.includes("Effect-TS")),
  )

  // ---- 3. a change of state, which must supersede rather than overwrite ----
  heading("3. The user's situation changes")

  const before = "我一直在用 Vue。"
  // A year ago: without a distinct occurredAt the two statements would land in
  // the same instant, producing a zero-length validity interval and no history
  // worth showing.
  const aYearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString()
  console.log(`  First (stated as of ${aYearAgo.slice(0, 10)}):  "${before}"`)
  await rt.palace.remember({
    userId: USER,
    content: before,
    sourceKind: "user",
    occurredAt: aYearAgo,
  })

  const after = "我现在不用 Vue 了，改用 React。"
  console.log(`  Later:  "${after}"`)
  const out3 = await rt.palace.remember({ userId: USER, content: after, sourceKind: "user" })

  console.log(`\n  relations written: ${out3.relations.length}`)
  for (const r of out3.relations) {
    console.log(`     ${r.kind} — ${r.reason}`)
  }

  // Asserted on the resulting STATE rather than on this call's relations: re-running
  // the demo without --reset re-states the same change, which is correctly judged
  // "already known" and writes no new relation. The supersede either happened now
  // or happened last time, and in both cases this is what the store looks like.
  //
  // Matched on the entity, not on the sentence. A real extractor rewrites
  // "我一直在用 Vue" as "用户一直在使用 Vue", so asserting the *input's* exact
  // phrasing reported a false failure on the real stack while the supersede had
  // in fact worked. A smoke test that fails when the system is right teaches you
  // to ignore it.
  const aboutFramework = await rt.palace.listMemories(USER, {}, { limit: 100 })
  check(
    "the change superseded the earlier state rather than overwriting it",
    aboutFramework.some((m) => m.content.includes("Vue") && m.status === "superseded") &&
      aboutFramework.some((m) => m.content.includes("React") && m.status === "active"),
  )

  // ---- 4. both temporal questions the design doc asks ---------------------
  heading("4. Both temporal questions stay answerable")

  // NOTE: with the mock provider the embedder is a hashing stand-in that only
  // captures lexical overlap, so these questions deliberately reuse the stored
  // wording. A real embedding model handles paraphrase; the eval suite exists to
  // measure exactly that difference.
  const now = await rt.palace.recall({
    userId: USER,
    query: "用户现在用 Vue 还是 React？",
    mode: "fast",
  })
  console.log("  Q: 你现在用 Vue 还是 React？")
  for (const m of now.memories) console.log(`     -> ${m.memory.content}`)
  check(
    "the current question returns the current state",
    now.memories.some((m) => m.memory.content.includes("React")) &&
      now.memories.every((m) => m.memory.status === "active"),
  )

  // Ask what was true six months ago — a different question from "now", and the
  // one a single-timeline store cannot answer.
  const sixMonthsAgo = new Date(Date.now() - 182 * 86_400_000).toISOString()
  const past = await rt.palace.recall({
    userId: USER,
    query: "用户用 Vue 吗？",
    mode: "fast",
    asOf: sixMonthsAgo,
    includeHistory: true,
  })
  console.log(`\n  Q: 六个月前（${sixMonthsAgo.slice(0, 10)}）你用什么技术？`)
  for (const m of past.memories) {
    console.log(
      `     -> ${m.memory.content}  [${m.memory.status}] valid ${m.memory.validFrom?.slice(0, 10)} → ${m.memory.validUntil?.slice(0, 10) ?? "now"}`,
    )
  }
  check(
    "the same store answers what was true then",
    past.memories.some((m) => m.memory.content.includes("Vue")),
  )

  // ---- 5. the history of the change itself -------------------------------
  heading("5. 'Why did it change?' — the evolution chain")

  const all = await rt.palace.listMemories(USER, {}, { limit: 100 })
  const current = all.find(
    (m) => m.status === "active" && m.content.toLowerCase().includes("react"),
  )
  const historyRows = current ? await rt.palace.getHistory(USER, current.id) : []
  for (const m of historyRows) {
    console.log(
      `  ${m.status.padEnd(10)} ${m.content}   valid ${m.validFrom?.slice(0, 10)} → ${m.validUntil?.slice(0, 10) ?? "now"}`,
    )
  }
  check(
    "the chain shows what is true now and what it replaced",
    historyRows.some((m) => m.status === "active") &&
      historyRows.some((m) => m.status === "superseded"),
  )

  // ---- 6. deduplication ---------------------------------------------------
  heading("6. Repeating yourself does not create a second memory")

  const repeat = "我最近在系统学习 Effect-TS。"
  console.log(`  "${repeat}"`)

  // Count CURRENT versions of the fact, whatever type the extractor happens to
  // give it. An earlier version of this check filtered on `goal` and printed
  // `0 (should stay 1)`: it was reading the type, not the fact, and hiding a real
  // defect — the re-wording re-typed the memory, so the user's goal quietly became
  // a fact. The check has to be about what the user would recognise.
  const currentVersionsOfTheFact = async (): Promise<number> =>
    (await rt.palace.listMemories(USER, { statuses: ["active"] }, { limit: 100 })).filter((m) =>
      m.content.includes("Effect-TS"),
    ).length

  const versionsBefore = await currentVersionsOfTheFact()
  const out6 = await rt.palace.remember({ userId: USER, content: repeat, sourceKind: "user" })
  const versionsAfter = await currentVersionsOfTheFact()

  console.log(`  -> ${out6.candidateCount} candidate(s), ${out6.memories.length} new version(s)`)
  for (const r of out6.relations) console.log(`     ${r.kind} — ${r.reason}`)
  console.log(`  -> current versions of that fact: ${versionsBefore} -> ${versionsAfter}`)
  check(
    "repeating yourself does not leave two current versions",
    versionsAfter === versionsBefore && versionsAfter === 1,
  )

  // ---- 7. negative case ---------------------------------------------------
  heading("7. An unrelated question returns nothing, on purpose")

  const unrelated = await rt.palace.recall({
    userId: USER,
    query: "今天东京的天气怎么样？",
    mode: "fast",
  })
  console.log(`  -> returned ${unrelated.memories.length} memories (empty = correct)`)
  check("an unrelated question returns nothing", unrelated.memories.length === 0)

  heading("8. Stats")
  const stats = await rt.palace.stats(USER)
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(14)} ${v}`)

  heading("Result")
  if (failures.length === 0) {
    console.log(`  all ${checks} checks passed`)
  } else {
    console.log(`  ${failures.length} of ${checks} checks FAILED:`)
    for (const f of failures) console.log(`    - ${f}`)
    process.exitCode = 1
  }
}

main()
  .then(() => rt.close())
  .catch(async (error) => {
    console.error(error)
    await rt.close()
    process.exit(1)
  })
