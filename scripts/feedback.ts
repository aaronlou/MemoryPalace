/**
 * Recall feedback CLI — the other half of the loop.
 *
 *   pnpm feedback review                 print unresolved judgements as candidate cases
 *   pnpm feedback promote <fb> <case>    record that `fb` became golden-set case `case`
 *
 * `review` deliberately does NOT append to the golden dataset. Promotion is a
 * judgement about what belongs in the benchmark, and a script that edits the
 * benchmark would also silently change what every future comparison means — the
 * dataset fingerprint exists precisely to catch that. So this prints a
 * TypeScript block for a human to paste, rename and trim, and `promote` records
 * the link once it has been accepted.
 *
 * Everything here needs a database; nothing here needs a model.
 */
import { createRuntime } from "@memory-palace/runtime"

const USAGE = `Usage:
  pnpm feedback review
  pnpm feedback promote <feedback-id> <case-id>
`

/** Escape for a double-quoted TypeScript string. */
function tsString(value: string): string {
  return JSON.stringify(value)
}

function indent(lines: string[], pad: string): string {
  return lines.map((line) => `${pad}${line}`).join("\n")
}

async function review(): Promise<number> {
  const runtime = createRuntime({ config: { logLevel: "error" } })

  try {
    const userId = runtime.config.userId
    const pending = await runtime.palace.listRecallFeedback(userId, { unresolvedOnly: true })

    if (pending.length === 0) {
      console.log(`No unresolved judgements for ${userId}.`)
      console.log(
        "\nNothing here means nothing has been judged wrong lately — or that nobody has run\n" +
          "a recall from the web UI since the last review.",
      )
      return 0
    }

    console.log(`${pending.length} judgement(s) waiting to become test cases.\n`)
    console.log("Candidate cases — paste into evals/datasets/recall.ts, then `promote`:\n")

    for (const [index, entry] of pending.entries()) {
      const suggestedId = `rec-fb-${String(index + 1).padStart(3, "0")}`

      const ids = [...entry.returnedIds]
      if (entry.expectedMemoryId && !ids.includes(entry.expectedMemoryId)) {
        ids.push(entry.expectedMemoryId)
      }
      const known = await runtime.storage.store.getMemories(userId, ids)
      const byId = new Map(known.map((m) => [m.id, m]))
      const returned = entry.returnedIds.map((id) => byId.get(id)).filter((m) => m !== undefined)
      const expected = entry.expectedMemoryId ? byId.get(entry.expectedMemoryId) : undefined

      const memoryLines = (expected ? [...returned, expected] : returned).map(
        (m) => `{ type: ${tsString(m.type)}, content: ${tsString(m.content)} },`,
      )
      // The three verdicts map onto different shapes, because they test
      // different things:
      //   helpful        → everything returned was right: a positive guard.
      //   missed         → something specific should have come back.
      //   not_relevant   → what came back was wrong; forbid it. The conservative
      //                    reading includes every returned memory, so whoever
      //                    adopts the case trims it down to the offending ones.
      const lines: string[] = []
      lines.push("{")
      lines.push(`  id: ${tsString(suggestedId)}, // rename before committing`)
      lines.push(
        `  note: ${tsString(
          `Reported from ${entry.source} on ${entry.createdAt.slice(0, 10)} (${entry.verdict}, ${entry.recallMode}). ${entry.note ?? ""}`.trim(),
        )},`,
      )
      if (memoryLines.length === 0) {
        // An empty recall leaving nothing to seed is normal — the case then says
        // "this question must find something", with the memory added by hand.
        lines.push("  memories: [], // TODO: seed whatever the store should have held")
      } else {
        lines.push("  memories: [")
        lines.push(indent(memoryLines, "    "))
        lines.push("  ],")
      }
      lines.push(`  query: ${tsString(entry.query)},`)

      if (entry.verdict === "helpful") {
        lines.push(`  expected: [${returned.map((m) => tsString(m.content)).join(", ")}],`)
      } else if (entry.verdict === "missed") {
        const expectedText = entry.expectedText ?? expected?.content
        lines.push(`  expected: [${expectedText ? tsString(expectedText) : "/* TODO */"}],`)
      } else {
        lines.push("  expected: [],")
        if (returned.length > 0) {
          lines.push(
            `  forbidden: [${returned.map((m) => tsString(m.content)).join(", ")}], // trim to what was actually irrelevant`,
          )
        }
      }

      lines.push("},")

      console.log(lines.join("\n"))
      console.log(
        `//   feedback ${entry.id}  promote with: pnpm feedback promote ${entry.id} <case-id>\n`,
      )
    }

    console.log("Nothing has been written. These are proposals until you adopt one.")
    return 0
  } finally {
    await runtime.close()
  }
}

async function promote(feedbackId: string, caseId: string): Promise<number> {
  const runtime = createRuntime({ config: { logLevel: "error" } })

  try {
    const userId = runtime.config.userId
    await runtime.storage.store.markFeedbackPromoted(userId, feedbackId, caseId)
    console.log(`${feedbackId} → ${caseId}. It leaves the review queue.`)
    return 0
  } finally {
    await runtime.close()
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === "help" || command === "--help") {
    console.log(USAGE)
    return command ? 0 : 1
  }
  if (command === "review") return review()
  if (command === "promote") {
    if (rest.length !== 2) {
      console.error("promote takes a feedback id and a case id")
      console.error(USAGE)
      return 1
    }
    return promote(rest[0] as string, rest[1] as string)
  }

  console.error(`unknown command: ${command}`)
  console.error(USAGE)
  return 1
}

process.exitCode = await main()
