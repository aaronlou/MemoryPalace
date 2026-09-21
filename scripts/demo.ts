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

  // ---- 5. the history of the change itself -------------------------------
  heading("5. 'Why did it change?' — the evolution chain")

  const all = await rt.palace.listMemories(USER, {}, { limit: 100 })
  const superseded = all.find((m) => m.status === "superseded" && m.content.includes("Vue"))
  if (superseded) {
    const chain = await rt.palace.getHistory(USER, superseded.id)
    const current = all.find(
      (m) => m.status === "active" && m.content.toLowerCase().includes("react"),
    )
    if (current) {
      const full = await rt.palace.getHistory(USER, current.id)
      for (const m of full) {
        console.log(
          `  ${m.status.padEnd(10)} ${m.content}   valid ${m.validFrom?.slice(0, 10)} → ${m.validUntil?.slice(0, 10) ?? "now"}`,
        )
      }
    } else {
      console.log(`  (chain from superseded row: ${chain.length} entries)`)
    }
  }

  // ---- 6. deduplication ---------------------------------------------------
  heading("6. Repeating yourself does not create a second memory")

  const repeat = "我最近在系统学习 Effect-TS。"
  console.log(`  "${repeat}"`)
  const out6 = await rt.palace.remember({ userId: USER, content: repeat, sourceKind: "user" })
  console.log(`  -> ${out6.candidateCount} candidate(s), ${out6.memories.length} new memory(ies)`)
  const goalCount = (
    await rt.palace.listMemories(USER, { types: ["goal"], statuses: ["active"] }, { limit: 50 })
  ).filter((m) => m.content.includes("Effect-TS")).length
  console.log(`  -> active Effect-TS goal memories: ${goalCount} (should stay 1)`)

  // ---- 7. negative case ---------------------------------------------------
  heading("7. An unrelated question returns nothing, on purpose")

  const unrelated = await rt.palace.recall({
    userId: USER,
    query: "今天东京的天气怎么样？",
    mode: "fast",
  })
  console.log(`  -> returned ${unrelated.memories.length} memories (empty = correct)`)

  heading("8. Stats")
  const stats = await rt.palace.stats(USER)
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(14)} ${v}`)
}

main()
  .then(() => rt.close())
  .catch(async (error) => {
    console.error(error)
    await rt.close()
    process.exit(1)
  })
