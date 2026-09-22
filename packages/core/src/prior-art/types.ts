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

export const PRIOR_ART_STATUSES = ["adopted", "partial", "rejected", "watched"] as const
export type PriorArtStatus = (typeof PRIOR_ART_STATUSES)[number]

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
  addedAt: IsoDateTime
  reviewedAt: IsoDateTime
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
  if (!input.claim?.trim()) problems.push("claim is required")
  if (!input.rationale?.trim()) problems.push("rationale is required")

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
  // claim this feature exists to make checkable.
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
