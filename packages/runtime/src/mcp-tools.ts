import type { MemoryPalace, RecallQuery } from "@memory-palace/core"
import { isAppError, truncate } from "@memory-palace/shared"
import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

/**
 * MCP tool surface.
 *
 * Two principles shape this file:
 *
 *  1. TOOL DESCRIPTIONS ARE PROMPTS. They are the only thing the model sees when
 *     deciding whether to call a tool. "Search memories" produces nothing;
 *     "call this when the user refers to their own preferences, past decisions
 *     or long-term goals" produces the right behaviour. This is the single most
 *     common reason an MCP integration is technically working but never used.
 *
 *  2. FEW TOOLS. Every extra tool dilutes selection accuracy. Nine tools that
 *     overlap is worse than five that do not.
 */

/** Wrapper so a thrown domain error becomes a readable tool error, never a crash. */
async function guard<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    const message = isAppError(error)
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error)
    return { ok: false, message }
  }
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] }
}

function errorText(value: string) {
  // isError marks the result as a failure so the model can react to it, rather
  // than treating an error string as a successful answer.
  return { content: [{ type: "text" as const, text: value }], isError: true }
}

export const SERVER_INSTRUCTIONS = `Memory Palace stores durable facts about this user across sessions: stable preferences, long-term goals, past decisions, ongoing projects and relationships.

Use it in two situations:
- BEFORE answering a question where knowing the user's own context, preferences or history would change your answer, call memory_recall.
- WHENEVER the user states something durable about themselves — a preference, a goal, a decision, a correction — call memory_remember so it is available next time.

Do not call memory_remember for the current question, for one-off tasks, or for anything you would have to guess at. It is normal and correct for recall to return nothing.

When recall returns a memory containing a validity range, respect it: a memory marked 已失效 is no longer true and must not be presented as the current state.`

export function registerTools(
  server: McpServer,
  palace: MemoryPalace,
  defaultUserId: string,
): void {
  // -------------------------------------------------------------------------
  // memory_recall — the primary read path
  // -------------------------------------------------------------------------
  server.registerTool(
    "memory_recall",
    {
      title: "Recall memories",
      description:
        "Retrieve what is known about this user that is relevant to the current task. " +
        "Call this before answering when the user's personal context, stated preferences, " +
        "past decisions, ongoing projects or long-term goals could change your answer — " +
        "for example when they say 'for me', 'as usual', 'my project', or ask you to " +
        "continue earlier work. Returns a short briefing already formatted for you, plus " +
        "structured data. Returns nothing when no memory is relevant, which is a normal " +
        "result and not an error.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("What you are about to do or answer, in natural language. Not just keywords."),
        mode: z
          .enum(["auto", "fast", "smart"])
          .default("auto")
          .describe(
            "auto (default) is fast unless the result is weak. Use smart when the question is " +
              "about the user's history or preferences and you want the best recall.",
          ),
        task_type: z
          .string()
          .optional()
          .describe("Optional task label such as 'architecture', 'debugging', 'tutorial'."),
        entities: z
          .array(z.string())
          .optional()
          .describe("Entity names the query is about, e.g. ['Effect-TS', 'Memory Palace']."),
        as_of: z
          .string()
          .optional()
          .describe("ISO-8601 date. Ask what was true at that time instead of now."),
        include_history: z
          .boolean()
          .default(false)
          .describe("Also return memories that are no longer true, marked as such."),
        format: z.enum(["text", "json"]).default("text"),
        limit: z.number().int().min(1).max(50).optional(),
        token_budget: z.number().int().min(100).max(8000).optional(),
      }),
    },
    async (args) => {
      const result = await guard(() =>
        palace.recall({
          userId: defaultUserId,
          query: args.query,
          mode: args.mode,
          taskType: args.task_type,
          entities: args.entities,
          asOf: args.as_of,
          includeHistory: args.include_history,
          format: args.format,
          limit: args.limit,
          tokenBudget: args.token_budget,
        } satisfies RecallQuery),
      )

      if (!result.ok) return errorText(`recall failed — ${result.message}`)

      const recall = result.value
      if (recall.memories.length === 0) {
        return text(
          "No relevant memories. This is a normal result — proceed without personal context.",
        )
      }

      const payload = recall.context
      const footer =
        `\n\n(${recall.memories.length} memories, ${recall.mode} path, ` +
        `${recall.diagnostics.latencyMs}ms` +
        (recall.escalated ? ", escalated for quality" : "") +
        `)`

      return {
        content: [{ type: "text" as const, text: payload + footer }],
        structuredContent: {
          memories: recall.memories.map((m) => ({
            id: m.memory.id,
            type: m.memory.type,
            content: m.memory.content,
            confidence: m.memory.confidence,
            importance: m.memory.importance,
            validFrom: m.memory.validFrom,
            validUntil: m.memory.validUntil,
            status: m.memory.status,
            score: m.score,
            why: m.why,
          })),
          diagnostics: recall.diagnostics,
        },
      }
    },
  )

  // -------------------------------------------------------------------------
  // memory_remember — the primary write path
  // -------------------------------------------------------------------------
  server.registerTool(
    "memory_remember",
    {
      title: "Remember something durable",
      description:
        "Record something the user has said about themselves so it is available in future " +
        "sessions. Call this when the user expresses a lasting preference, a goal, a decision, " +
        "a correction to something you believed, or a durable fact about their work or setup. " +
        "Pass their own words — do NOT summarise, and do NOT extract memories yourself; the " +
        "system decides what is worth keeping. Do not call this for the current task, for " +
        "one-off requests, or for transient states.",
      inputSchema: z.object({
        content: z
          .string()
          .describe("What the user said or did, verbatim or lightly cleaned. Their own words."),
        source_kind: z
          .enum(["user", "agent", "chat", "document", "event", "import"])
          .default("agent")
          .describe(
            "Where this came from. Use 'agent' when you are recording your own observation.",
          ),
        agent_id: z
          .string()
          .optional()
          .describe("Identifier for the calling agent, so writes can be attributed and audited."),
        occurred_at: z
          .string()
          .optional()
          .describe("ISO-8601 timestamp of when this actually happened, if not now."),
      }),
    },
    async (args) => {
      const result = await guard(() =>
        palace.remember({
          userId: defaultUserId,
          content: args.content,
          sourceKind: args.source_kind,
          agentId: args.agent_id,
          occurredAt: args.occurred_at,
        }),
      )

      if (!result.ok) return errorText(`remember failed — ${result.message}`)

      const outcome = result.value
      if (outcome.deferred) {
        // The observation is safely stored; the pipeline will retry. Say so
        // plainly rather than reporting success or failure.
        return text(
          `Stored, but memory extraction did not complete (${outcome.error ?? "provider error"}). ` +
            `Nothing was lost — the raw note is saved and can be reprocessed.`,
        )
      }

      if (outcome.memories.length === 0) {
        return text(
          `Reviewed and found nothing worth keeping long-term (${outcome.candidateCount} candidate(s) considered). This is a normal outcome.`,
        )
      }

      const lines = outcome.memories.map(
        (m) =>
          `- [${m.type}] ${truncate(m.content, 160)}${m.status === "pending" ? "  (needs confirmation)" : ""}`,
      )
      const pending = outcome.memories.filter((m) => m.status === "pending").length
      const summary =
        `Remembered ${outcome.memories.length} item(s):\n${lines.join("\n")}` +
        (pending > 0
          ? `\n\n${pending} item(s) are pending confirmation — call memory_confirm to review.`
          : "")
      return text(summary)
    },
  )

  // -------------------------------------------------------------------------
  // memory_search — direct lookup, no model call
  // -------------------------------------------------------------------------
  server.registerTool(
    "memory_search",
    {
      title: "Search memories directly",
      description:
        "Look up stored memories by keyword, entity or type. This is a deterministic lookup " +
        "rather than context-aware recall — use it when you or the user want to see exactly " +
        "what is stored, or to check whether a specific fact is known. Prefer memory_recall " +
        "when you are trying to answer a question well.",
      inputSchema: z.object({
        query: z.string().optional().describe("Keyword or phrase to match."),
        types: z
          .array(
            z.enum([
              "fact",
              "preference",
              "experience",
              "decision",
              "relationship",
              "goal",
              "event",
            ]),
          )
          .optional(),
        statuses: z
          .array(z.enum(["active", "pending", "superseded", "archived"]))
          .optional()
          .describe("Defaults to active memories only."),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    },
    async (args) => {
      const result = await guard(() =>
        args.query
          ? palace.searchMemories(defaultUserId, {
              query: args.query,
              filter: { types: args.types, statuses: args.statuses },
              limit: args.limit,
            })
          : palace.listMemories(
              defaultUserId,
              { types: args.types, statuses: args.statuses ?? ["active"] },
              { limit: args.limit },
            ),
      )

      if (!result.ok) return errorText(`search failed — ${result.message}`)

      const memories = result.value
      if (memories.length === 0) return text("No memories matched.")

      const lines = memories.map(
        (m) =>
          `${m.id}  [${m.type}/${m.status}]  ${truncate(m.content, 200)}` +
          (m.validFrom
            ? `\n    valid ${m.validFrom.slice(0, 10)} → ${m.validUntil?.slice(0, 10) ?? "now"}`
            : ""),
      )
      return text(`${memories.length} memory(ies):\n\n${lines.join("\n")}`)
    },
  )

  // -------------------------------------------------------------------------
  // memory_update — human correction
  // -------------------------------------------------------------------------
  server.registerTool(
    "memory_update",
    {
      title: "Correct a memory",
      description:
        "Rewrite a stored memory when it is wrong or imprecise. This is for corrections, not " +
        "for recording new information — use memory_remember for that. The previous version is " +
        "kept in history, never overwritten.",
      inputSchema: z.object({
        memory_id: z.string().describe("Id of the memory to correct."),
        content: z.string().describe("The corrected statement."),
        summary: z.string().optional(),
        importance: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    },
    async (args) => {
      const result = await guard(() =>
        palace.updateMemory(defaultUserId, args.memory_id, {
          content: args.content,
          summary: args.summary,
          importance: args.importance,
          confidence: args.confidence,
        }),
      )
      if (!result.ok) return errorText(`update failed — ${result.message}`)
      return text(`Updated. New version ${result.value.id}:\n${result.value.content}`)
    },
  )

  // -------------------------------------------------------------------------
  // memory_forget
  // -------------------------------------------------------------------------
  server.registerTool(
    "memory_forget",
    {
      title: "Forget a memory",
      description:
        "Retire memories the user no longer wants remembered. Archives by default, which is " +
        "reversible and keeps the history; pass hard=true for permanent deletion when the user " +
        "explicitly asks for data to be erased.",
      inputSchema: z.object({
        memory_ids: z.array(z.string()).min(1),
        hard: z
          .boolean()
          .default(false)
          .describe("true = permanently delete. Only when the user asks for erasure."),
      }),
    },
    async (args) => {
      const result = await guard(() =>
        palace.forgetMemories(defaultUserId, args.memory_ids, { hard: args.hard }),
      )
      if (!result.ok) return errorText(`forget failed — ${result.message}`)
      const { archived, deleted } = result.value
      return text(
        deleted > 0
          ? `Permanently deleted ${deleted} memory(ies).`
          : `Archived ${archived} memory(ies). They are still in history and can be restored.`,
      )
    },
  )

  // -------------------------------------------------------------------------
  // memory_confirm — the conflict / policy queue
  // -------------------------------------------------------------------------
  server.registerTool(
    "memory_confirm",
    {
      title: "Review memories awaiting confirmation",
      description:
        "List memories that were not activated automatically — because they conflict with " +
        "something already known, or because the writing agent is not trusted for that kind of " +
        "memory. Call with no id to list them; call with an id and decision to resolve one. " +
        "Ask the user before confirming anything you are unsure about.",
      inputSchema: z.object({
        memory_id: z.string().optional().describe("Omit to list the queue."),
        decision: z
          .enum(["confirm", "reject"])
          .optional()
          .describe("Required when memory_id is given."),
        reason: z.string().optional(),
      }),
    },
    async (args) => {
      if (!args.memory_id) {
        const result = await guard(() => palace.listPending(defaultUserId, 50))
        if (!result.ok) return errorText(`listing pending failed — ${result.message}`)
        const pending = result.value
        if (pending.length === 0) return text("Nothing awaiting confirmation.")
        const lines = pending.map((m) => `${m.id}  [${m.type}]  ${truncate(m.content, 200)}`)
        return text(
          `${pending.length} memory(ies) awaiting confirmation:\n\n${lines.join("\n")}\n\n` +
            `Call memory_confirm with a memory_id and decision to resolve one.`,
        )
      }

      if (!args.decision) {
        return errorText("decision is required when memory_id is provided")
      }

      const result = await guard(() =>
        args.decision === "confirm"
          ? palace.confirmMemory(defaultUserId, args.memory_id!)
          : palace.rejectMemory(defaultUserId, args.memory_id!, args.reason),
      )
      if (!result.ok) return errorText(`confirmation failed — ${result.message}`)
      return text(
        args.decision === "confirm"
          ? `Confirmed and activated: ${result.value.content}`
          : `Rejected and archived: ${result.value.content}`,
      )
    },
  )

  // -------------------------------------------------------------------------
  // memory_stats
  // -------------------------------------------------------------------------
  server.registerTool(
    "memory_stats",
    {
      title: "Memory statistics",
      description:
        "How much this system currently knows: counts by status, plus the active models. " +
        "Useful to check whether memory is empty before telling the user nothing is known.",
      inputSchema: z.object({}),
    },
    async () => {
      const result = await guard(() => palace.stats(defaultUserId))
      if (!result.ok) return errorText(`stats failed — ${result.message}`)
      const s = result.value
      return text(
        [
          `active:     ${s.active}`,
          `pending:    ${s.pending}`,
          `superseded: ${s.superseded}`,
          `archived:   ${s.archived}`,
          `observations: ${s.observations}`,
          `entities:   ${s.entities}`,
          `models:     ${s.llm} / ${s.embedding} (${s.embeddingDim}d)`,
        ].join("\n"),
      )
    },
  )
}
