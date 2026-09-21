# ADR-0006: A below-floor candidate is recalled only if the reranker confirms it

**Status:** accepted · **Date:** 2026-09-21

## Context

ADR-0005 gave every qualifying route a similarity floor, and the semantic floor is
the effective knob for precision: swept over the golden dataset, 0.45 is where
precision and negative accuracy peak.

That floor is also a hard recall ceiling, and the failure mode is documented on a
live example:

```
query : 讲技术概念的时候应该怎么组织？
memory: 用户希望在被讲解 TypeScript 时，先了解整体结构和设计思想，再深入具体 API
cosine: 0.432   -> below the 0.45 floor, so it is never recalled
```

Measured over sixteen query/memory pairs from the dataset, relevant and irrelevant
cosine distributions **overlap** (relevant 0.432–0.800, irrelevant 0.152–0.799).
So no single absolute threshold can separate them: lowering the floor to 0.40 buys
that one true positive and drops negative accuracy from 1.000 to 0.750 everywhere
else. The floor is a coarse filter, not a relevance test.

Two asymmetries make the situation more promising than it looks:

- The **fast path** has no signal beyond these scores. Its floor is all it has.
- The **smart path** already pays for an LLM reranker that judges relevance
  directly. For it, cosine is an input rather than the verdict — yet candidates
  below the floor never reach the reranker, because the floor is applied when the
  candidate is *generated*.

## Decision

**On the smart path, probe below the semantic floor, and keep a below-floor
candidate only when the reranker confirms it.**

- The probe floor is `minSemanticSimilarity - semanticRescueMargin` (default
  margin 0.15, configurable, 0 disables).
- A candidate that enters this way is *rescued*. It is recalled only if its rerank
  relevance is at least `rescueMinRelevance` (default 0.6 — the rerank rubric's
  "useful background" band). Rescued candidates have no above-floor evidence of
  their own, so they are held to a stricter bar than ordinary hits.
- If reranking fails or is unavailable, rescued candidates are dropped and the
  answer is the one the floor would have given. Degradation is to the old
  behaviour, never past it.
- **The rescue may only add candidates; it never changes the treatment of a
  memory another route already matched.** A memory matched by the lexical or
  entity route has its own evidence — the fast path would have returned it — so
  the smart path must not demand more of it than the fast path does. Whatever the
  rescue does, `smart` cannot recall strictly less than `fast`.
- The **fast path never probes**: without a confirmation signal, a lowered floor
  admits noise and nothing else.

Every decision is recorded in the audit trail
(`kept_rescued_confirmed` / `rescued_unconfirmed`), because a recall that "should
not" have happened is otherwise indistinguishable from a bug.

## Consequences

- The mechanism is **inert on the offline stack** — measured: mock and oracle
  runs are identical with the margin at 0.15 and at 0, because the mock embedder
  derives similarity from shared tokens and the mock reranker can only confirm
  what it also sees lexically. Its value is only measurable with a real embedder
  plus a real reranker, and the eval suite says so rather than implying otherwise.
- No extra model call and no added latency: the reranker was already being asked
  to score the shortlist. The change is in which candidates reach it and what a
  low score now means.
- `rec-013` in the golden dataset is the live paraphrase above. The offline
  providers structurally cannot pass it; it exists to guard the real stack.
- `rec-014` is the trap this decision could open: a query about the *mnemonic
  technique* 记忆宫殿, which a real embedder places near memories about the Memory
  Palace project. Adjacency is not relevance, and the reranker has to refuse it.

## Alternatives rejected

- **One lower global floor.** Measured, and it trades one true positive for
  several false ones (negative accuracy 1.000 → 0.750 at 0.40).
- **An adaptive threshold relative to each query's own similarity distribution.**
  Tempting, and it does fix the example above — but a lone *irrelevant* hit is
  distributed exactly like a lone *relevant* one, so no per-query statistic can
  tell them apart. It also has to lower the floor for low-scoring queries, which
  is precisely where the negative cases live. It replaces a tunable constant with
  a heuristic that cannot be calibrated.
- **Letting the fast path probe too.** It has nothing to confirm a candidate with;
  the result would be a lower floor with no additional evidence, i.e. the
  precision loss without the compensating signal.
- **Requiring rerank confirmation for every candidate.** The reranker is a
  heuristic model too, and it is the *only* thing standing between a paraphrase
  and the user. Making it mandatory would let a bad rerank run delete memories the
  score-based path would have returned.
