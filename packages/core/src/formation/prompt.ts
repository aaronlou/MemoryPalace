import type { IsoDateTime } from "@memory-palace/shared"
import type { QueryUnderstandingOutput } from "../memory/decisions.js"
import type { Memory, MemoryType } from "../memory/types.js"
import {
  ADJUDICATION_INSTRUCTIONS,
  QUERY_UNDERSTANDING_INSTRUCTIONS,
  RERANK_INSTRUCTIONS,
} from "../policies.js"

/**
 * Prompt construction.
 *
 * Kept separate from the pipelines so that prompt changes are reviewable in
 * isolation and so the eval suite can hash a prompt without running anything.
 */

export function extractionPrompt(input: {
  content: string
  occurredAt: IsoDateTime
  knownEntities: string[]
  sourceKind: string
}): string {
  const lines = [
    `<observation source="${input.sourceKind}" occurred_at="${input.occurredAt}">`,
    input.content,
    "</observation>",
  ]
  if (input.knownEntities.length > 0) {
    lines.push(
      "",
      "Entities already known (reuse these exact spellings when they refer to the same thing):",
      input.knownEntities.map((e) => `- ${e}`).join("\n"),
    )
  }
  lines.push("", "Extract the durable memories from this observation.")
  return lines.join("\n")
}

/** Compact rendering of an existing memory inside an adjudication prompt. */
function renderExisting(memory: Memory, index: number): string {
  const parts = [
    `[${index}] id=${memory.id}`,
    `type=${memory.type}`,
    `confidence=${memory.confidence.toFixed(2)}`,
  ]
  if (memory.validFrom) parts.push(`valid_from=${memory.validFrom.slice(0, 10)}`)
  if (memory.validUntil) parts.push(`valid_until=${memory.validUntil.slice(0, 10)}`)
  return `${parts.join(" ")}\n    ${memory.content}`
}

/**
 * The single adjudication prompt: given a candidate and the memories that might
 * already cover or conflict with it, decide what to do.
 */
export function adjudicationPrompt(input: {
  candidate: { type: MemoryType; content: string; validFrom?: IsoDateTime; confidence: number }
  existing: Memory[]
  today: IsoDateTime
}): string {
  return [
    `Today's date is ${input.today.slice(0, 10)}.`,
    "",
    "<candidate>",
    `type: ${input.candidate.type}`,
    `content: ${input.candidate.content}`,
    `confidence: ${input.candidate.confidence.toFixed(2)}`,
    input.candidate.validFrom
      ? `stated_start: ${input.candidate.validFrom.slice(0, 10)}`
      : "stated_start: (none stated)",
    "</candidate>",
    "",
    "<existing_memories>",
    input.existing.map((m, i) => renderExisting(m, i)).join("\n"),
    "</existing_memories>",
    "",
    "Decide how the candidate relates to these existing memories.",
  ].join("\n")
}

export function queryUnderstandingPrompt(query: string, taskType?: string): string {
  const lines = ["<query>", query, "</query>"]
  if (taskType) lines.push("", `The calling agent reports task_type: ${taskType}`)
  lines.push("", "Analyse this query for memory retrieval.")
  return lines.join("\n")
}

export function rerankPrompt(
  query: string,
  candidates: Array<{ memory: Memory; heuristicScore: number }>,
): string {
  return [
    "<query>",
    query,
    "</query>",
    "",
    "<candidates>",
    candidates
      .map(
        (c, i) =>
          `[${i}] id=${c.memory.id} type=${c.memory.type} heuristic=${c.heuristicScore.toFixed(3)}\n    ${c.memory.content}`,
      )
      .join("\n"),
    "</candidates>",
    "",
    "Score each candidate for how useful it is when answering this query.",
  ].join("\n")
}

export function instructionsFor(kind: "adjudication" | "query" | "rerank"): string {
  switch (kind) {
    case "adjudication":
      return ADJUDICATION_INSTRUCTIONS
    case "query":
      return QUERY_UNDERSTANDING_INSTRUCTIONS
    case "rerank":
      return RERANK_INSTRUCTIONS
  }
}

/** Narrow a parsed adjudication result to ids that actually existed in the prompt. */
export function keepKnownIds(ids: string[], existing: Memory[]): string[] {
  const known = new Set(existing.map((m) => m.id))
  return ids.filter((id) => known.has(id))
}

export type { QueryUnderstandingOutput }
