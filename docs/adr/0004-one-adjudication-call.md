# ADR-0004: Deduplication and conflict detection are one model call

**Status:** accepted · **Date:** 2026-09-21

## Context

The design doc separates dedup (§7.3) and conflict resolution (§8) into two
pipeline stages. Both need the same thing: the candidate plus the existing
memories that are semantically close to it.

## Decision

One adjudication call decides across a single six-value space:

`DUPLICATE · REFINE · SUPERSEDE · CONTRADICT · COEXIST · NEW`

## Rationale

- **Half the cost and latency** for identical information. Both stages would
  retrieve the same neighbours and send them in the same prompt.
- **The two calls could contradict each other.** Dedup could answer DUPLICATE
  while conflict answers SUPERSEDE, which then needs a reconciliation rule that
  nobody will maintain. One decision space cannot disagree with itself.
- **`REFINE` is the decision that makes this necessary.** It is neither "already
  known" nor "conflicting" — it is "same fact, better wording", and it only exists
  if one call sees both questions at once.
- ~~Conflict detection is scoped to neighbours of the **same memory type**.~~
  **This was wrong and has been reverted — see the correction below.**

## Consequences

- The prompt must explain six decisions instead of three and three. That is the
  main cost, and it is why `ADJUDICATION_INSTRUCTIONS` is the longest prompt in
  the codebase.
- `COEXIST` is observationally identical to `NEW` (nothing is replaced, a new
  memory is created), so the evolution eval suite does not distinguish them and
  says so rather than pretending to test it.
- Only the same-type top-k neighbours are examined, so adjudication is O(n) model
  calls per candidate, not O(n²).

## Correction (2026-09-21, after running against a real model)

The same-type restriction was justified above with "a `goal` never supersedes a
`preference`". **The live system disproved it**, and the failure was severe enough
to be worth recording in full.

What happened: the user wrote *"我一直在用 Vue"*, which extraction stored as a
`fact`. They later wrote *"我现在不用 Vue 了，改用 React"*, which extraction
classified as a `decision`. Neighbour lookup filtered on `type = 'decision'`, so
it never saw the `fact` about Vue. Adjudication was therefore **never called** and
the candidate was inserted unconditionally. The store ended up holding both
statements as active — asserting at once that the user uses Vue and that they do
not.

Type is a property of how a statement was phrased, not of what it is about. The
restriction is now removed: neighbours are any active memory, the model is shown
each neighbour's type, and the prompt states that `DUPLICATE`/`REFINE` apply
within a type while `SUPERSEDE`/`CONTRADICT`/`COEXIST` may cross types.

Measured effect on the evaluation suite: adjudication accuracy 0.767 → 0.833
(mean of three runs), with the best run rising from 0.80 to 0.90.

The general lesson, which also applies to the "precision" argument that motivated
the restriction: narrowing retrieval to make a model's job easier only works if
the narrowing matches how the data is actually shaped. It did not here, and the
cost was silence rather than an error — the pipeline simply skipped a stage.

## Alternatives rejected

- **Two calls (the original plan).** Doubles cost and creates a contradiction
  path that needs its own rule.
- **Embedding-similarity thresholds instead of a model.** A threshold cannot tell
  "same fact" from "related but different", and it cannot recognise a change of
  state at all — which is the single most important judgement in the system.
