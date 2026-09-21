# ADR-0007: The reranker's judgement is binding, when the reranker can be trusted

**Status:** accepted · **Date:** 2026-09-21

## Context

ADR-0006 gave the smart path a way to add candidates the semantic floor rejected.
Measuring that mechanism on the real stack (bge-m3 + `deepseek-reasoner`) exposed
the opposite failure, and a worse one. For three recall cases, the raw scores and
the model's own relevance verdict were:

```
                                        semantic   rerank   blended   outcome
rec-013  relevant paraphrase              0.523     0.950    0.873    recalled
rec-008  "where do I work?" vs a pref.    0.502     0.050    0.563    recalled  <- wrong
rec-014  the mnemonic technique           0.553     0.050    0.558    recalled  <- wrong
```

The model was right both times it said "not useful here", and it was ignored.

The reason is structural, not a tuning error. On the smart weights the blended
score is `0.45·RRF + 0.35·rerank + 0.08·importance + 0.07·recency`. RRF is
normalised by the best candidate *for that query*, so a query with a single
semantic hit gives it `RRF = 1.0` no matter how weak it is — 0.45 of the score,
which no plausible relevance term can outweigh. That is also why
`MP_RECALL_MIN_SCORE` was already measured to be a useless lever (the score is
mostly rank, importance and recency, which every memory collects).

Result on the recall suite: negative accuracy **60%**, and `auto` inherited it,
because the fast path's escalation rule (`blended score < 0.42`) cannot fire for a
candidate scoring 0.78 for structural reasons.

## Decision

**On the smart path, an explicit low-relevance verdict vetoes the candidate, and
`auto` escalates answers nothing corroborates — but only when the configured model
is competent enough for its verdict to mean anything.**

1. **Veto.** `MP_RECALL_MIN_RERANK_RELEVANCE` (default 0.3, the rerank rubric's
   own "not useful here" band) — below it, the candidate is dropped regardless of
   its blended score. The veto applies **only if the reranker answered**: an
   outage is not a judgement, and treating it as one would be worse than the noise
   the veto removes.
2. **Escalation on thin evidence.** `auto` already escalated on a weak score. It
   now also escalates when the fast path's best answer has no lexical or entity
   match *and* its cosine is below `MP_RECALL_ESCALATE_BELOW_SEMANTIC` (default
   0.6). "Only cosine, and not much of it" is the one signal available to the fast
   path that says the answer is unresolved rather than merely early.
3. **Per-provider trust.** Both thresholds default to **0** under
   `MP_LLM_PROVIDER=mock` and to 0.3 / 0.6 under the real providers. This is the
   same reasoning as the per-provider semantic floor: the value is a property of
   the model. The built-in stand-in scores relevance from token overlap, so a
   Chinese memory sharing one distinctive term with the query scores ~0.09 where a
   real reranker gives ~0.95. Trusting it deleted legitimate recall — measured,
   mock smart fell from 0.714/0.786 to 0.500/0.500 — so it gets no authority.

The earlier stated invariant, "`smart` never recalls strictly less than `fast`",
holds for the rescue but is **deliberately not extended to the veto**. A memory
that a lexical or entity route matched has evidence the fast path can see, and
neither mechanism touches it. A semantic-only candidate is the case where the fast
path has no information at all beyond a cosine that the measurement shows cannot
separate relevant from irrelevant — so there, the model's judgement is the extra
information, and honouring it is the point of the smart path.

## Consequences

Measured on the 14-case recall suite, same model and embedder:

```
smart:                      P@5     R@5     negative accuracy   forbidden hits
veto off                    0.714   0.929   60.0%               7.1%
veto on                     0.893   0.929   100.0%              0.0%

auto:                       P@5     R@5     negative accuracy   model calls
escalation on evidence off  0.750   1.000   60.0%               5
escalation on evidence on   0.893   1.000   100.0%             15
```

- The veto cost **no recall** on this suite: everything it removed was wrong.
- `auto` reaches the smart path's precision for **15 model calls instead of 27**,
  because corroborated answers never leave the fast path.
- The veto makes `smart` recall less than `fast` whenever the model is wrong. That
  is the gamble, and it is why the thresholds are configurable and default to 0
  under a stand-in. `MP_RECALL_MIN_RERANK_RELEVANCE=0` restores add-only behaviour.
- The `fast` path is unaffected and remains precision-first through its floor
  (see the floor sweep in the README): raising that floor for bge-m3 to 0.65 was
  measured to be free for `smart` and `auto`, which no longer depend on it.

## Alternatives rejected

- **Re-weight the smart score to make relevance dominate.** The problem is not the
  weight but the range: RRF is normalised per query, so its contribution is
  "1.0 if you were alone", which says nothing about relevance. Re-weighting would
  also change the ordering of every result, not just the admission decision — a
  larger change for a smaller effect.
- **Raise `MP_RECALL_MIN_SCORE`.** Already measured to be ineffective, for the
  reason above; it starts cutting genuine results before it separates noise.
- **Trust the reranker unconditionally.** Measured against the mock reranker: it
  deleted legitimate recall (0.714/0.786 → 0.500/0.500), which is exactly what a
  user with a cheap model would get. Trust is a per-provider property.
- **Escalate every semantic-only answer regardless of similarity.** A semantic-only
  hit at 0.85 cosine is strong evidence on its own; escalating it spends two model
  calls to learn nothing. Hence the threshold, not a boolean.
- **Make `smart` the default and drop the fast path.** It would erase the latency
  property the fast path exists for (p95 < 150 ms) to fix a precision problem that
  escalation already fixes for 15 calls instead of 27.
