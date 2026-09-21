import type { MemoryStatus, MemoryType } from "@memory-palace/core"

/**
 * Golden dataset shapes.
 *
 * The datasets are TypeScript modules rather than YAML/JSON. That is a deliberate
 * deviation from the original plan: a type-checked dataset cannot silently drift
 * out of sync with the schema, typos in a memory type are compile errors, and the
 * whole thing still reads like a data file.
 */

/** A memory is "matched" when its type agrees and its content contains every fragment. */
export interface ExpectMemory {
  /** Exactly one accepted type. Prefer `types` where the choice is debatable. */
  type?: MemoryType
  /**
   * Any of these types is acceptable.
   *
   * Memory typing is genuinely ambiguous for some statements — "I started
   * learning X" is defensible as either a goal or an experience, and asserting
   * one as correct measures the dataset author's opinion rather than the
   * system. Where a real disagreement is possible, list the acceptable answers.
   */
  types?: MemoryType[]
  /** All of these fragments must appear in the memory content (normalised). */
  contentContains: string[]
  /** When false the expectation contributes to precision but not recall. */
  mustHave?: boolean
}

/**
 * Normalise text before fragment matching.
 *
 * The model is free to write "Effect TS" where the dataset says "Effect-TS",
 * and failing it for that measures formatting rather than meaning. Separators
 * and case are collapsed so punctuation differences do not register as errors.
 */
export function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export interface ExtractionCase {
  id: string
  /** Why this case exists, in one line. Shown in the report. */
  note: string
  observation: string
  occurredAt?: string
  expect: ExpectMemory[]
  /**
   * Statements that must NOT be stored. These are the over-extraction traps:
   * generalisations, transient states, and the current task itself.
   */
  mustNotExtract?: ExpectMemory[]
}

export type DecisionKind = "DUPLICATE" | "REFINE" | "SUPERSEDE" | "CONTRADICT" | "COEXIST" | "NEW"

export interface EvolutionCase {
  id: string
  note: string
  existing: Array<{ type: MemoryType; content: string; validFrom?: string }>
  observation: string
  /**
   * The memory the extractor is expected to produce from `observation`.
   *
   * Stated explicitly so this suite tests the *decision*, not extraction
   * quality: otherwise a failure here would be ambiguous between "the extractor
   * found nothing" and "the adjudicator chose wrongly".
   */
  candidate: { type: MemoryType; content: string }
  expectDecision: DecisionKind
  /**
   * Other decisions that also satisfy this case's intent.
   *
   * Some of the six decisions genuinely overlap: a restatement that adds a word
   * is defensibly DUPLICATE or REFINE, and "nothing worth storing" satisfies a
   * case whose real purpose is to prove that a mention does not supersede.
   * Listing the acceptable answers keeps the suite measuring the system instead
   * of the author's taste — and leaves cases with a single answer (like a true
   * change of state) strict.
   */
  acceptDecisions?: DecisionKind[]
  /** Content that must end up as a superseded/refined-away version. */
  expectSupersededContentContains?: string
  /** Content that must be active after the observation is processed. */
  expectActiveContentContains?: string
}

export interface RecallCase {
  id: string
  note: string
  /**
   * Memories seeded before the query.
   *
   * `status`/`validUntil` are explicit because a case like "the old framework"
   * needs a real superseded predecessor, and deriving that from an ordering
   * convention would make the dataset harder to read than the behaviour it tests.
   */
  memories: Array<{
    type: MemoryType
    content: string
    occurredAt?: string
    validUntil?: string
    status?: MemoryStatus
  }>
  query: string
  asOf?: string
  includeHistory?: boolean
  /** Contents that must be recalled. */
  expected: string[]
  /** Contents that must NOT be recalled. */
  forbidden?: string[]
  /** True when the only correct answer is an empty result (design doc Case 4). */
  expectEmpty?: boolean
}

export interface Dataset {
  extraction: ExtractionCase[]
  evolution: EvolutionCase[]
  recall: RecallCase[]
}
