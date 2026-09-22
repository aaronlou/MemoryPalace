import type { IsoDateTime } from "@memory-palace/shared"

/**
 * Prior art — the reference list behind the algorithm.
 *
 * Why this is its own context rather than rows in `memories`: the memory store
 * answers "what should an agent know about *the user*", and it is adjudicated,
 * bi-temporal and recalled by relevance. This is project documentation with a
 * completely different lifecycle — curated, reviewed, and versioned alongside
 * the code. Filing it as memory would let a question about the user's
 * preferences surface "T-Mem uses trigger-augmented retrieval", which is a
 * category error inside the product.
 *
 * The point of the feature is that a claim of the form "this idea is embodied
 * here" is only worth reading if it points at something that exists. So
 * `adopted` and `partial` REQUIRE evidence, and the runtime resolves every
 * reference against the working tree — see `packages/runtime/src/prior-art.ts`.
 * Without that rule this page is an essay, and essays about one's own influences
 * rot silently.
 */

export const PRIOR_ART_STATUSES = [
  "unevaluated",
  "adopted",
  "partial",
  "rejected",
  "watched",
] as const
export type PriorArtStatus = (typeof PRIOR_ART_STATUSES)[number]

/**
 * Where an entry is in the assess-then-decide flow.
 *
 * `none` is a hand-written entry that was never sent for evaluation — the CLI seed
 * path. Everything else is the lifecycle of one evaluation run: queued, in flight,
 * a draft waiting for a human, failed, or accepted. Nothing advances to a status
 * on its own; `ready` means a draft exists, not that anything was decided.
 */
export const EVALUATION_STATES = [
  "none",
  "pending",
  "running",
  "ready",
  "failed",
  "accepted",
] as const
export type EvaluationState = (typeof EVALUATION_STATES)[number]

/**
 * What the model produced, before a human agreed to it.
 *
 * `rejectedEvidence` is the honest half: the model is asked to cite this
 * repository, and anything it cites that does not resolve is dropped and listed
 * here rather than quietly kept. A suggested reference is a hypothesis; the
 * filesystem decides.
 */
export interface PriorArtDraft {
  title: string
  claim: string
  rationale: string
  suggestedStatus: PriorArtStatus
  notTaken?: string
  killCriterion?: string
  evidence: PriorArtEvidence[]
  rejectedEvidence: Array<{ ref: string; problem: string }>
  /** The model's own confidence in the assessment, 0-1. Shown to the reviewer. */
  confidence: number
}

export interface PriorArtEvaluation {
  state: EvaluationState
  startedAt?: IsoDateTime
  finishedAt?: IsoDateTime
  /** Why it failed, in the words the user needs to act on. */
  error?: string
  /** What the model read, so an assessment can be attributed to a revision. */
  revision?: string
  /** The repo as fetched, for the record. */
  repoDescription?: string
  draft?: PriorArtDraft
}

/**
 * What an evidence reference points at.
 *
 * Deliberately a small closed set: each kind is mechanically checkable, which is
 * the whole reason to have kinds at all.
 */
export const EVIDENCE_KINDS = ["path", "case", "commit"] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export interface PriorArtEvidence {
  kind: EvidenceKind
  /**
   * `path`: a repo-relative file, optionally with a `#L12` or `:12` line anchor.
   * `case`: a golden-dataset id such as `rec-017`.
   * `commit`: a sha that implemented the adopted idea.
   */
  ref: string
  /** Why this artifact embodies the idea. Optional; the reference is the claim. */
  note?: string
}

export interface PriorArtEntry {
  id: string
  userId: string
  /** `owner/name`. Identity for de-duplication, so re-adding updates rather than doubles. */
  repo: string
  url: string
  title: string
  /** What the project claims, in one or two sentences. */
  claim: string
  status: PriorArtStatus
  /** The assessment: why it is or is not combinable with this product. */
  rationale: string
  /** What we deliberately did not take. The most useful field, and the easiest to omit. */
  notTaken?: string
  /**
   * What result would make us change our mind. Required for `watched`, because a
   * "we're watching this" entry with no exit condition is how a list rots.
   */
  killCriterion?: string
  /** The revision a drafted summary was read from, when one was drafted by a model. */
  sourceRevision?: string
  evidence: PriorArtEvidence[]
  /** Absent on rows written before evaluation existed; read as `none`. */
  evaluation?: PriorArtEvaluation
  addedAt: IsoDateTime
  reviewedAt: IsoDateTime
}

/**
 * The minimum a client has to supply.
 *
 * Everything else is either fetched or drafted. Users are not expected to judge
 * whether a project is worth borrowing from — that is what the evaluation is for —
 * so the interface asks for a repository and nothing else.
 */
export interface PriorArtRequest {
  repo: string
}

/** What a client may supply. The id and timestamps are the store's business. */
export interface PriorArtInput {
  repo: string
  url?: string
  title: string
  claim: string
  status: PriorArtStatus
  rationale: string
  notTaken?: string
  killCriterion?: string
  /** The revision a drafted summary was read from. Set when a model drafted it. */
  sourceRevision?: string
  evidence?: PriorArtEvidence[]
  evaluation?: PriorArtEvaluation
}

const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/** `owner/name` → the canonical GitHub URL. */
export function repoUrl(repo: string): string {
  return `https://github.com/${repo}`
}

/**
 * The rules an entry must satisfy, as a list of human-readable problems.
 *
 * Pure, so the API and the tests share one definition and a failure message is
 * the same in both. Resolution of the references themselves needs the
 * filesystem, so it lives in the runtime and is applied on top of this.
 */
export function validatePriorArtInput(input: PriorArtInput): string[] {
  const problems: string[] = []
  const repo = input.repo?.trim() ?? ""

  if (!REPO_SHAPE.test(repo)) {
    problems.push(`repo must look like "owner/name", got ${JSON.stringify(input.repo)}`)
  }
  if (!input.title?.trim()) problems.push("title is required")

  // An entry created from a URL alone has nothing to say yet: the claim and the
  // assessment are exactly what the evaluation is for. Requiring them here would
  // put the eight-field form back, which is the thing this flow exists to remove.
  if (input.status !== "unevaluated") {
    if (!input.claim?.trim()) problems.push("claim is required")
    if (!input.rationale?.trim()) problems.push("rationale is required")
  }

  if (!(PRIOR_ART_STATUSES as readonly string[]).includes(input.status)) {
    problems.push(`status must be one of ${PRIOR_ART_STATUSES.join(", ")}`)
  }

  const evidence = input.evidence ?? []
  for (const [i, item] of evidence.entries()) {
    if (!(EVIDENCE_KINDS as readonly string[]).includes(item.kind)) {
      problems.push(`evidence[${i}].kind must be one of ${EVIDENCE_KINDS.join(", ")}`)
    }
    if (!item.ref?.trim()) problems.push(`evidence[${i}].ref is empty`)
  }

  // The load-bearing rule. "We took this idea" with nothing to point at is the
  // claim this feature exists to make checkable. `unevaluated` asserts nothing yet,
  // so it is exempt along with `rejected`.
  if ((input.status === "adopted" || input.status === "partial") && evidence.length === 0) {
    problems.push(
      `status "${input.status}" needs at least one evidence reference to this repository`,
    )
  }
  if (input.status === "watched" && !input.killCriterion?.trim()) {
    problems.push('status "watched" needs a killCriterion: what result would make us build it')
  }

  return problems
}
