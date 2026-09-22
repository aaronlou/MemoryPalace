import type { PriorArtInput } from "@memory-palace/core"

/**
 * The reference list, as versioned content.
 *
 * This is data, not code: it is what `pnpm prior-art seed` inserts so a fresh
 * install has the list the project actually keeps. Editing it here and
 * re-seeding is the reviewable path; the Prior art page is the convenient one.
 *
 * Every reference is resolved against the checkout by `pnpm prior-art check`,
 * which CI runs. A file that gets renamed therefore breaks a claim that it
 * embodies an idea, and that failure is the point: without it, this list would
 * quietly become a set of assertions about a codebase that no longer exists.
 *
 * Typechecked by `tsconfig.tools.json`, so a typo in a status or an evidence kind
 * fails the build rather than the page.
 */
export const PRIOR_ART_SEED: PriorArtInput[] = [
  {
    repo: "Sherlockwz/T-Mem",
    title: "T-Mem: trigger-augmented graph memory",
    status: "partial",
    claim:
      "Recall is reachability-bounded by the similarity between a query and stored content. It splits recall into descriptive (shared surface form) and associative (tied only by a latent arc), and argues that prevailing systems fail the second half.",
    rationale:
      "The problem it names is the one our probe band exists to fix, and the split maps onto our qualifying routes plus the reranker's binding judgement. What we did not need was its machinery: widening our own probe band reached the same cases without a second index, and the measured gain came from a threshold rather than from write-time generation.",
    notTaken:
      "Write-time trigger generation. Our probe band reached the associative cases without a second index, so triggers would have to earn their cost elsewhere. Also not taken: its graph projection, and its treatment of contradiction, which is a prompt instruction ('prioritize the most recent memory') where we have a data model — two time axes, supersession, and conflict parking.",
    killCriterion:
      "If a margin sweep to the point where negative accuracy breaks still leaves a case unreachable that a write-time cue would plausibly catch, build the triggers. Until such a case exists, the probe band is the cheaper mechanism and the ADR-0006 rescue already covers the same ground.",
    sourceRevision: "dd9e152 (2026-09-09)",
    evidence: [
      {
        kind: "path",
        ref: "packages/core/src/recall/pipeline.ts:317",
        note: "semanticProbeFloor — how far below the floor the smart path may reach, which is the mechanism that answers its premise",
      },
      {
        kind: "path",
        ref: "docs/adr/0006-confirmed-rescue-below-the-semantic-floor.md",
        note: "why a below-floor candidate is kept only when the reranker confirms it",
      },
      {
        kind: "path",
        ref: "docs/adr/0005-qualifying-routes-and-similarity-floors.md",
        note: "which routes may introduce a candidate at all",
      },
      {
        kind: "path",
        ref: "docs/adr/0007-the-rerankers-judgement-is-binding.md",
        note: "its descriptive/associative split is decided here by judgement, not by distance",
      },
      {
        kind: "case",
        ref: "rec-017",
        note: "associative positive: must be recalled, and a threshold cannot do it — see rec-020 at the identical cosine",
      },
      {
        kind: "case",
        ref: "rec-020",
        note: "the negative half of that pair; passes only because relevance is judged rather than measured",
      },
      {
        kind: "commit",
        ref: "b82f4bd",
        note: "adopted in part: the probe band widened from 0.15 to 0.25, P@5 0.667 to 0.958 with negative accuracy held at 100%",
      },
    ],
  },
]
