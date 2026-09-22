import { z } from "zod"

/**
 * The structured output of a prior-art evaluation, and the instructions that shape
 * it.
 *
 * This lives in `core` for the same reason the extraction and adjudication
 * schemas do: it is a contract with a model, and it must not be reachable only
 * from whichever package happens to do the calling. The IO — fetching the
 * repository, resolving the references it cites — lives in `packages/runtime`.
 *
 * The task is deliberately framed as *assessment for a human to accept*, not as a
 * decision. The model is good at reading a repository and saying what it claims
 * and where the overlap is; it has no standing to decide that this project adopts
 * something. So `suggestedStatus` is a suggestion, the draft is stored separately
 * from the assessment, and nothing is written to the entry until someone agrees.
 */

/** One reference the model believes backs a claim, before it is verified. */
export const SuggestedEvidence = z.object({
  kind: z
    .enum(["path", "case", "commit"])
    .describe(
      "path: a repository-relative file. case: a golden-dataset id. commit: a sha from the provided index.",
    ),
  ref: z.string().describe("The reference itself, copied exactly from the index you were given"),
  note: z.string().nullable().describe("Why this artifact embodies the idea, or null"),
})

export const PriorArtEvaluationOutput = z.object({
  title: z
    .string()
    .describe("A short human title for the project, at most 12 words. Use the project's own name."),
  claim: z
    .string()
    .describe(
      "What the project claims, in one or two sentences, in the language of the request. Describe its thesis, not its feature list.",
    ),
  rationale: z
    .string()
    .describe(
      "How combinable it is with this project and why. Name the specific mechanism that overlaps, or say plainly that nothing does.",
    ),
  suggestedStatus: z
    .enum(["adopted", "partial", "rejected", "watched"])
    .describe(
      [
        "adopted: this project already implements the idea, and the evidence proves it.",
        "partial: it does something comparable, with a different mechanism or a narrower scope.",
        "rejected: considered and not taken. The reason is the value here.",
        "watched: interesting, not yet decided — then a killCriterion is required.",
      ].join(" "),
    ),
  notTaken: z
    .string()
    .nullable()
    .describe("What this project deliberately does not take from it, or null if nothing applies"),
  killCriterion: z
    .string()
    .nullable()
    .describe(
      "For watched: the result that would make this project build it. Null otherwise, and never a restatement of the idea.",
    ),
  evidence: z
    .array(SuggestedEvidence)
    .describe(
      "References from the provided index that back an adopted or partial claim. Anything not in the index will be rejected, so cite only what you were shown. Empty for rejected.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How confident you are in this assessment. Be low when the README is thin, the project is unrelated, or the overlap is speculative.",
    ),
})

export type PriorArtEvaluationOutput = z.infer<typeof PriorArtEvaluationOutput>

export const PRIOR_ART_EVAL_PROMPT_VERSION = "prior-art-eval-v1"

export const PRIOR_ART_EVAL_INSTRUCTIONS = `You assess whether another open-source project is worth borrowing from, for the maintainers of one specific project.

You are given two things:
  1. FACTS about the candidate repository: its description, topics and README.
  2. AN INDEX of the target project: its architecture decision records, source paths and evaluation case ids.

Your job is a *hypothesis for a human to accept or discard*, not a verdict. Write what the candidate claims, then where it overlaps the target and where it does not.

Rules that matter more than thoroughness:

- **Cite only what is in the index.** Every reference is checked against the target repository before it is stored, and anything that does not resolve is thrown away and listed as rejected. Copy refs exactly as they appear in the index; do not invent paths, guess at file names, or cite a URL.
- **An empty evidence list is a good answer.** If nothing in the target implements the candidate's idea, say so and cite nothing. Do not reach for a loosely related file to look thorough.
- **"rejected" is a valuable answer.** A candidate whose idea was considered and declined is worth recording, and the reason is the useful part. Do not upgrade it to "partial" to seem positive.
- **Prefer "watched" when you are unsure**, and then give a killCriterion: the concrete result that would justify building it. "Not useful" is not a kill criterion; "a case it would catch that our probe band cannot" is.
- **Judge the mechanism, not the topic.** Two projects about "memory" do not overlap. Two projects that both refuse to let a reranker delete recall do.
- **Do not judge by popularity.** Stars are given to you for context only. A small project with one idea you lack is more useful than a large one you already match.
- **Say what is not taken.** For any overlap you find, ask what the target deliberately does differently, and record it. That is usually the most useful field in the entry.

Write in the same language as the README and index you are given; do not translate them.`
