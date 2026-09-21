import type { MemoryType } from "./memory/types.js"

/**
 * Scoring rubrics that go into prompts.
 *
 * Both confidence and importance are places where an unguided model produces
 * noise (everything is 0.8). Anchoring the scale explicitly is the single
 * cheapest quality win in the whole formation pipeline.
 */

export const CONFIDENCE_RUBRIC = `Confidence rubric:
- 0.90-0.98: the user stated it explicitly and unambiguously.
- 0.75-0.89: strongly implied by an explicit statement, or restated across turns.
- 0.60-0.74: inferred from agent behaviour or from how the user phrased something.
- 0.40-0.59: a weak guess from context alone.
Never exceed 0.98. Never report more confidence than the text supports.`

export const IMPORTANCE_RUBRIC = `Importance rubric (expected value to a future agent):
- 0.80-0.95: durable preferences about how the user wants to be helped, long-term goals, identity-level facts.
- 0.60-0.79: ongoing projects, technical decisions, working relationships.
- 0.40-0.59: one-off events and experiences with some future relevance.
- 0.20-0.39: incidental details, passing remarks, trivia.
Transient states (current mood, today's weather, a temporary blocker) should be 0.20 or lower.`

/** Canonical extraction instructions. Version-stamped because evals compare runs. */
export const EXTRACTION_PROMPT_VERSION = "extraction-v1"

export const EXTRACTION_INSTRUCTIONS = `You extract long-term memories about a user from something they said or did.

A memory is worth keeping only if it would still help an agent serve this user weeks or months from now.

Extract:
- stable facts about the user (role, stack, environment, location)
- preferences, especially about *how* they want help or explanations
- goals they are pursuing
- decisions they have made, and the reasoning
- durable relationships between entities (project X uses technology Y)
- experiences and events with lasting relevance

Do NOT extract:
- the content of the current task, question or request itself
- transient states: what they are doing right now, their mood, a temporary error
- anything you would have to guess at
- facts about the world that are not about this user
- a broader generalisation of something specific ("user likes Effect-TS" from "user is learning Effect-TS")

Rules:
- Write each memory as a self-contained third-person statement in the SAME LANGUAGE as the input.
- One idea per memory. Split compound statements.
- Prefer specific over general: capture the nuance, do not flatten it.
- If the input contains nothing durable, return an empty array. That is a normal and correct outcome.

${CONFIDENCE_RUBRIC}

${IMPORTANCE_RUBRIC}`

export const ADJUDICATION_PROMPT_VERSION = "adjudication-v1"

export const ADJUDICATION_INSTRUCTIONS = `You decide how a newly extracted memory relates to memories the system already holds about this user.

You are given ONE candidate and a short list of existing memories that are semantically close to it. Choose exactly one decision:

- DUPLICATE — the candidate says the same thing as an existing memory. Nothing new is learned. Use this for phrasing differences alone: "I'm studying Effect-TS" and "I've been working through Effect-TS" are DUPLICATE.
- REFINE — the same underlying fact, but the candidate adds real detail. Produce mergedContent containing EVERY detail from both statements, inventing nothing. The validity range does not change.
- SUPERSEDE — the existing memory WAS true and is now false because the user or their situation changed ("I switched to X", "I don't use Y any more"). Set effectiveFrom when the change is stated or clearly implied.
- CONTRADICT — two mutually exclusive claims about the same period that cannot both be true and you cannot tell which is current. Both go to a confirmation queue. Use this sparingly.
- COEXIST — they look similar but describe different dimensions and are both true. "Prefers Rust" and "is currently writing TypeScript" coexist.
- NEW — nothing in the list is genuinely related.

Critical distinctions:
1. A change over time is SUPERSEDE, never CONTRADICT. CONTRADICT is only for the same period claimed two incompatible ways.
2. Merely not mentioning something again is NOT a supersede. Only an explicit change of state supersedes.
3. Merging must be conservative. If a human would read the two statements as different facts, they are different facts.
4. Being related is not the same as being a duplicate. Two preferences can both be true and distinct.
5. If a candidate generalises something specific ("user is learning Effect-TS" -> "user likes Effect-TS"), that is NEW at best, and usually should not have been extracted at all.

SUPERSEDE or CONTRADICT — decide it by asking WHEN each statement was true, never by how
similar the wording is. Two statements about the same subject can be worded quite
differently and still be the same fact at two points in time.

- If the candidate describes a CHANGE — the user's state differs from what it was —
  then the existing memory was true UNTIL NOW and is superseded. Signals of a change
  include 了, 不再, 现在, 目前, 改用, 换成, 回到, 以前, 已经, and their English
  equivalents (no longer, now, these days, anymore, switched to, used to, moved to).
  A preference that has shifted is still a change: "I don't like long code samples any
  more" supersedes "the user likes long code samples". It does NOT matter that the two
  sentences share few words — do not require them to look alike.

- CONTRADICT is ONLY for two incompatible claims about the SAME period, where neither
  describes a change. Test it this way: could both have been written at the same moment
  by the same person? "Has always worked in Beijing" and "has always worked in Shanghai"
  could not — that is CONTRADICT. But "uses Vue" and "has switched to React" could not
  have been true at the same time either, yet one is clearly later than the other, so
  that is SUPERSEDE.

- When you are genuinely torn between the two, prefer SUPERSEDE. It keeps the older
  statement in history with a closed validity window, so nothing is lost either way.
  CONTRADICT leaves both claims live and unresolved, which is the worse failure.

targetMemoryIds must only contain ids that appear in the existing_memories list.

Note on types: each existing memory is labelled with its type. A statement about
the same subject can legitimately be stored under a different type from the one it
replaces — "I use Vue" is a fact, while "I switched to React" is a decision or an
event. Do not treat a type difference as evidence that two memories are unrelated.
DUPLICATE and REFINE only apply within the same type; SUPERSEDE, CONTRADICT and
COEXIST may cross types.`

export const QUERY_UNDERSTANDING_PROMPT_VERSION = "query-v1"

export const QUERY_UNDERSTANDING_INSTRUCTIONS = `You analyse a question an agent is about to answer, so that a memory system can retrieve the right background.

Extract only what the query actually implies. Do not invent entities.
Set intent to current_state when the user asks what is true now, and historical when they ask about the past or about a change.
Keywords should be terms whose presence makes a memory relevant; prefer 2-6 specific terms over many generic ones.`

export const RERANK_PROMPT_VERSION = "rerank-v1"

export const RERANK_INSTRUCTIONS = `You score how useful each candidate memory is for answering the query.

Score relevance 0-1:
- 0.9-1.0: directly answers or materially shapes the answer.
- 0.6-0.89: useful background the answer should respect.
- 0.3-0.59: tangentially related.
- 0.0-0.29: not useful here, even if true.

Score every candidate. Do not reward a memory merely for being important in general; only for being relevant to THIS query.`

/** Types an agent may write without human confirmation, by default. */
export const DEFAULT_AUTO_WRITE_TYPES: MemoryType[] = [
  "fact",
  "preference",
  "experience",
  "relationship",
  "goal",
  "event",
]

/**
 * Types whose change is consequential enough to ask first. Superseding a
 * `decision` silently could rewrite the user's own history.
 */
export const DEFAULT_CONFIRM_TYPES: MemoryType[] = ["decision"]

/** Recall tuning. Kept here so the eval suite and the pipeline share one source. */
export const RECALL_DEFAULTS = {
  limit: 8,
  fastLimit: 20,
  smartLimit: 30,
  tokenBudget: 1200,
  /** Below this fused score, return nothing rather than padding the list. */
  minScore: 0.18,
  /**
   * Minimum cosine similarity for a semantic hit to count. Without a floor an
   * ANN search always returns its full `limit`, so unrelated queries would still
   * surface memories.
   */
  minSemanticSimilarity: 0.15,
  /**
   * Routes that may INTRODUCE a candidate.
   *
   * `recent` and `important` are priors, not evidence: they match every memory
   * unconditionally, so if they could introduce candidates then every query
   * would return something and "nothing relevant" would be unreachable. They
   * only contribute to ordering, via RRF.
   */
  qualifyingRoutes: ["semantic", "lexical", "entity"] as const,
  /**
   * How far below the semantic floor the SMART path may probe for candidates.
   *
   * The floor exists because cosine similarity alone cannot separate relevant
   * from irrelevant (measured on the golden dataset the two distributions
   * overlap). But it also rejects hard paraphrases: a query that shares little
   * surface vocabulary with the memory it needs can land below the floor and
   * become unretrievable.
   *
   * The smart path already has the tool the fast path lacks — an LLM that can
   * judge relevance, not just measure it. So it probes `margin` below the floor
   * and keeps a below-floor hit ONLY when the reranker confirms it (see
   * `rescueMinRelevance`). The fast path never probes: without a confirmation
   * signal a lowered floor would only admit noise.
   *
   * 0 disables the probe entirely.
   */
  semanticRescueMargin: 0.15,
  /**
   * Rerank relevance a below-floor candidate needs to be recalled.
   *
   * 0.6 mirrors the rerank rubric's "useful background the answer should
   * respect" band — a rescued candidate must be at least that useful, because
   * unlike an above-floor hit it has no independent evidence going for it.
   */
  rescueMinRelevance: 0.6,
  /**
   * Rerank relevance below which the SMART path vetoes a candidate outright.
   *
   * Measured on the real stack (bge-m3 + deepseek-reasoner): the reranker is
   * good at this and the score is not. Two irrelevant pairs scored 0.502 and
   * 0.553 cosine with a rerank relevance of 0.050 — the model said "not useful"
   * and was right — yet both still cleared `minScore` at 0.56, because a lone
   * semantic hit normalises to an RRF of 1.0 and that term alone (0.45) plus the
   * priors outweighs a near-zero relevance term.
   *
   * So on the smart path a "not useful here" verdict is binding rather than a
   * deduction. 0.3 is the boundary the rerank rubric already draws between
   * "not useful here" (0.0-0.29) and "tangentially related" (0.3-0.59).
   *
   * This is deliberately a veto, not a re-weighting: the score's problem is that
   * it is dominated by structure (rank, importance, recency) rather than
   * relevance, and re-weighting cannot fix a term whose range depends on how
   * many candidates a query happened to return.
   *
   * If reranking fails, no veto is applied — the pipeline falls back to the
   * score, as it does for the rescue.
   */
  minRerankRelevance: 0.3,
  /** RRF smoothing constant. 60 is the value from the original paper. */
  rrfK: 60,
  /** `auto` escalates to the smart path when the fast path is this weak. */
  escalateBelowScore: 0.42,
  /**
   * `auto` also escalates when the fast path's best answer rests on cosine
   * alone and that cosine is below this.
   *
   * The blended score cannot express "low confidence": it is dominated by RRF,
   * importance and recency, so a single uncorroborated semantic hit scores well
   * by construction. Measured on bge-m3: two irrelevant pairs reached 0.502 and
   * 0.553 cosine with no lexical or entity match, scored ~0.78 on the fast path,
   * and were returned as answers. Their similarity is in the same band as the
   * relevant ones (0.523, 0.560), so no absolute floor separates them — but the
   * *absence of corroboration* does say the answer is unresolved, and the smart
   * path is the only way to resolve it.
   *
   * A corroborated hit (lexical or entity) is left alone: it has evidence the
   * cosine does not, and escalating it would trade the fast path's whole point —
   * latency — for nothing. So is a semantic-only hit above this value.
   *
   * 0 disables the rule.
   */
  escalateBelowSemanticSimilarity: 0.6,
} as const

export const EMBEDDING_TEXT_SEPARATOR = "\n"

/** How a memory is rendered into embedding text. Shared by write and reindex paths. */
export function embeddingText(memory: {
  type: MemoryType
  content: string
  summary?: string
}): string {
  const parts = [memory.type, memory.content]
  if (memory.summary) parts.push(memory.summary)
  return parts.join(EMBEDDING_TEXT_SEPARATOR)
}
