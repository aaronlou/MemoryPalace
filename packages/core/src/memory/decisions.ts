import { z } from "zod"
import { MEMORY_TYPES } from "../memory/types.js"

/**
 * Zod schemas for every LLM structured output.
 *
 * Two rules learned the hard way:
 *  1. Every field is `nullable()` rather than `optional()`. Provider strict-schema
 *     modes require all properties to be present, and `z.toJSONSchema()` emits
 *     optional fields as non-required, which they reject.
 *  2. Numeric bounds (`min`/`max`) are kept for *local* validation only. OpenAI's
 *     strict mode does not enforce `minimum`/`pattern`/`minLength`, so the value
 *     still has to be `safeParse`d after the call. See `packages/llm`.
 */

// ---------------------------------------------------------------------------
// 1. Candidate extraction + classification (one call, not two)
// ---------------------------------------------------------------------------

export const ExtractedEntity = z.object({
  name: z.string().describe("Canonical name, e.g. 'Effect-TS', 'React', 'Memory Palace'"),
  kind: z
    .string()
    .describe("One of: technology, project, person, organization, topic, place, other"),
})

export const ExtractedCandidate = z.object({
  type: z.enum(MEMORY_TYPES),
  content: z
    .string()
    .describe(
      "A self-contained third-person statement about the user, in the same language as the input. Must stand alone without the surrounding conversation.",
    ),
  summary: z.string().nullable().describe("Short label, at most 12 words, or null"),
  entities: z.array(ExtractedEntity),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How sure we are this is true. Explicit user statement ~0.95, agent inference ~0.65"),
  importance: z
    .number()
    .min(0)
    .max(1)
    .describe("Expected long-term value to a future agent. Durable preference ~0.8, trivia ~0.2"),
  validFrom: z
    .string()
    .nullable()
    .describe("ISO-8601 date if the input states when this started, else null. Never guess."),
  reasoning: z.string().describe("One sentence explaining why this is worth remembering"),
})

export const ExtractionOutput = z.object({
  candidates: z
    .array(ExtractedCandidate)
    .describe(
      "Memories worth keeping long-term. Return an empty array if the input contains nothing durable. Do not invent facts.",
    ),
})

export type ExtractedCandidate = z.infer<typeof ExtractedCandidate>
export type ExtractionOutput = z.infer<typeof ExtractionOutput>

// ---------------------------------------------------------------------------
// 2. Adjudication — dedup AND conflict in one call
// ---------------------------------------------------------------------------

export const ADJUDICATION_DECISIONS = [
  "DUPLICATE",
  "REFINE",
  "SUPERSEDE",
  "CONTRADICT",
  "COEXIST",
  "NEW",
] as const
export type AdjudicationDecisionKind = (typeof ADJUDICATION_DECISIONS)[number]

/**
 * One call decides everything about how a candidate relates to what we already
 * know.
 *
 * Why not separate dedup and conflict calls? Both need the same neighbour set,
 * so splitting them doubles cost and latency for no extra information — and it
 * lets the two calls disagree (dedup says DUPLICATE while conflict says
 * SUPERSEDE), which then needs a reconciliation rule. A single decision space
 * cannot contradict itself.
 */
export const AdjudicationOutput = z.object({
  decision: z
    .enum(ADJUDICATION_DECISIONS)
    .describe(
      [
        "DUPLICATE: same fact, already known. Nothing new.",
        "REFINE: same fact, but this wording adds real detail worth merging. Validity range is unchanged.",
        "SUPERSEDE: the existing fact stopped being true; this states the new truth.",
        "CONTRADICT: mutually exclusive claims about the same period that cannot be reconciled.",
        "COEXIST: looks similar but describes a different dimension; both are true.",
        "NEW: genuinely distinct, nothing related exists.",
      ].join(" "),
    ),
  targetMemoryIds: z
    .array(z.string())
    .describe(
      "Existing memories this decision acts on. Empty for NEW. Multiple ids only when several are all replaced by one new statement.",
    ),
  mergedContent: z
    .string()
    .nullable()
    .describe(
      "For REFINE: the combined statement preserving every detail from both, inventing nothing. For DUPLICATE: the existing content. Otherwise null.",
    ),
  effectiveFrom: z
    .string()
    .nullable()
    .describe(
      "For SUPERSEDE: ISO-8601 date the new state began, if stated or clearly implied, else null. Ignored otherwise.",
    ),
  confidenceDelta: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "For DUPLICATE/REFINE: how much to raise the existing confidence. 0 if not warranted.",
    ),
  reason: z.string().describe("Why, referencing what the user actually said"),
})

export type AdjudicationOutput = z.infer<typeof AdjudicationOutput>

// ---------------------------------------------------------------------------
// 3. Query understanding (smart recall path only)
// ---------------------------------------------------------------------------

export const QueryUnderstandingOutput = z.object({
  entities: z.array(z.string()).describe("Entity names mentioned or strongly implied by the query"),
  taskType: z
    .string()
    .nullable()
    .describe("Short task label such as 'architecture', 'debugging', 'tutorial', 'planning'"),
  keywords: z.array(z.string()).describe("Terms that must appear for a memory to be relevant"),
  intent: z
    .enum(["current_state", "historical", "preference", "general"])
    .describe(
      "current_state: 'what do I use now'. historical: 'what did I use before'. preference: how the user likes things. general: anything else.",
    ),
  timeRangeFrom: z
    .string()
    .nullable()
    .describe("ISO-8601 lower bound if the query implies one, else null"),
  timeRangeTo: z
    .string()
    .nullable()
    .describe("ISO-8601 upper bound if the query implies one, else null"),
})

export type QueryUnderstandingOutput = z.infer<typeof QueryUnderstandingOutput>

// ---------------------------------------------------------------------------
// 5. Reranking (smart recall path only)
// ---------------------------------------------------------------------------

export const RerankOutput = z.object({
  rankings: z.array(
    z.object({
      memoryId: z.string(),
      relevance: z.number().min(0).max(1),
      reason: z.string(),
    }),
  ),
})

export type RerankOutput = z.infer<typeof RerankOutput>
