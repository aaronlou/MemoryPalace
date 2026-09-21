# ADR-0005: Recall requires retrieval evidence, and nothing is padded

**Status:** accepted · **Date:** 2026-09-21

## Context

The design doc makes "irrelevant memories are filtered out" an explicit
acceptance criterion (§26, Case 4). Early implementation failed it badly: every
query returned results.

Two causes:

1. An approximate-nearest-neighbour search **always** returns `limit` rows,
   however dissimilar. There is no point at which it decides "none of these are
   relevant".
2. `recent` and `important` are not query-conditional — they match every memory
   unconditionally. Once fused, they guaranteed that every query surfaced
   something.

## Decision

**A memory may only be recalled if a query-conditional route matched it.**

- Qualifying routes: `semantic`, `lexical`, `entity`.
- `recent` and `important` contribute to *ordering* through RRF but may not
  introduce a candidate.
- Each qualifying route has its own similarity floor: cosine for semantic,
  shared-term for lexical. Scores from different routes are not comparable, so one
  threshold cannot serve both.
- Below the fused-score threshold, recall returns an empty list. That is a
  correct answer and the tool result says so in words.

The lexical route gates on **shared discriminative terms** rather than trigram
similarity alone. `用户` is a stopword here for a non-obvious reason: every memory
is written as a third-person statement about the user, so it appears in nearly all
of them and has zero discriminative power. Gating on it made every query match
everything.

## Consequences

- Negative accuracy on the eval suite went from 50% to 100%.
- Recall got *worse* on paraphrase cases under the mock embedder, and that is
  correct: the mock only captures lexical overlap. With a real embedding model the
  semantic route carries those cases. Recording the honest lower bound is more
  useful than tuning thresholds until the mock looks good.
- `recent` and `important` still do real work — they break ties among genuinely
  relevant memories, which is what a prior should do.

## Alternatives rejected

- **Tune the score threshold until irrelevant results stopped appearing.** The
  scores were dominated by importance and recency priors that every memory
  receives, so no threshold could separate the cases. The structure was wrong, not
  the number.
- **Drop `recent` and `important`.** Loses the tie-breaking that makes a
  currently-relevant memory beat a stale one.

## A note on calibrating the measurement

The eval harness is validated by two reference providers: an `oracle` that returns
the expected answer must score 1.000 on extraction and 100% on adjudication, and a
`null` provider that stores nothing must score 0.000. If either endpoint is wrong,
a real score like "F1 = 0.63" is measuring the harness rather than the system.
The oracle replaces the *language model*, not the embedding model, so recall is
asserted on the negative cases rather than on paraphrase recall.
