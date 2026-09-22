# How recall decides, and how each threshold was chosen

The README shows the shape of a recall: five routes, RRF fusion, a qualifying-route
filter, a threshold. This page is the part that took the longest to get right — the
two thresholds, the two mechanisms that exist because a threshold cannot do the job,
and the evidence behind each. Everything here is measured on the golden dataset; the
reproduction commands are in the [evaluation page](./EVALUATION.md).

The short version: **a cosine floor can exclude noise, and it cannot decide
relevance.** The fast path lives with that. The smart path pays a model to decide
instead.

## The similarity floor is model-specific

`MP_RECALL_MIN_SEMANTIC_SIMILARITY` defaults **per provider**, because the right
value is a property of the embedding model rather than of the system. A hashing
stand-in puts unrelated text near 0, so a floor tuned for it admits everything
once a real model is used — which is exactly what happened the first time the
embedder was switched.

The floor was then set from a sweep over the golden dataset rather than from
intuition. That sweep has been **re-run on the real stack** (bge-m3 + DeepSeek,
the 14-case recall suite), because the mechanisms below changed what the floor
still decides:

| floor | `fast` P@5 / R@5 / negative | `smart` P@5 / R@5 / negative |
|---|---|---|
| 0.35 | 0.488 / 1.000 /  20% | 0.893 / 1.000 / 100% |
| **0.45** *(old default)* | 0.750 / 1.000 /  60% | 0.929 / 1.000 / 100% |
| 0.55 | 0.679 / 0.857 /  80% | 0.929 / 1.000 / 100% |
| **0.65** *(current default)* | 0.714 / 0.786 / 100% | 0.929 / 1.000 / 100% |

Two things to read out of it. **The smart path barely notices the floor** — the
rescue recovers the recall it costs and the veto removes the noise it admits — so
the floor is no longer "the effective knob" it used to be. **The fast path is
where the tradeoff lives**, because cosine is all it has: it can have R@5 1.000
with 40% of negative queries answered, or 100% negative accuracy and three misses,
and nothing in between is a plateau. 0.65 was chosen by this document's own
long-standing criterion — the point where negative accuracy reaches its maximum —
which costs the fast path R@5 0.786. `MP_RECALL_MIN_SEMANTIC_SIMILARITY=0.45`
trades back, and is one environment variable away.

The hosted providers still carry the earlier 0.45. The floor is a property of the
model, and none of them have been swept here; that is stated rather than guessed.

The **final** blended-score threshold (`MP_RECALL_MIN_SCORE`) was swept against
the floor and turns out not to be a useful lever:

```
floor  minScore=0.18  0.30  0.40  0.50
0.25   P@5 0.667      0.667 0.667 0.583
0.35   P@5 0.750      0.750 0.750 0.667
0.45   P@5 0.833      0.833 0.833 0.750
```

Raising it does not separate relevant from irrelevant results, because an
irrelevant memory that clears the semantic floor also collects the same
importance and recency priors as a relevant one. **The reason is structural, and
it is the same reason the smart path now vetoes explicitly:** a lone semantic hit
normalises to an RRF of 1.0, and that term alone (0.45 on the smart weights)
outweighs whatever the model thought of it. Re-weighting cannot fix a term whose
range depends on how many candidates a query happened to return; a veto can, and
does (measured: negative accuracy 60% → 100% on the smart path).

**A correction worth recording.** An earlier version of this document claimed a
clean separation — "irrelevant 0.164-0.400, relevant 0.599-0.800". That was drawn
from five hand-picked pairs. Measured over sixteen pairs from the dataset, the
distributions **overlap**:

```
RELEVANT    n=9  min 0.432  median 0.597  max 0.800
IRRELEVANT  n=7  min 0.152  median 0.213  max 0.799
```

The paragraph that followed this table used to give a live example of a hard
paraphrase falling *below* the floor:

```
query : 讲技术概念的时候应该怎么组织？
memory: 用户希望在被讲解 TypeScript 时，先了解整体结构和设计思想，再深入具体 API
cosine: 0.432   -> below the 0.45 floor, so it is not recalled
```

**Re-measured with bge-m3, that pair scores 0.523, not 0.432** — above both floors,
so it was recalled all along and the example proved nothing about the floor. The
supposed fix ("lower the floor to 0.40") would have bought nothing and cost
negative accuracy. What the same sweep *did* show is sharper than the old story:
bge-m3 puts genuinely unrelated pairs at **0.502 and 0.553**, i.e. *higher* than a
relevant paraphrase at 0.523. With this embedder there is no floor that separates
them, and the earlier table's confidence about "0.45 is where precision and
negative accuracy peak" does not survive the measurement.

That is the real problem the two mechanisms below solve, and neither of them is a
threshold: the fast path keeps a floor and accepts its tradeoff, while the smart
path stops pretending a cosine can answer a question the model can answer better.

## The smart path probes below the floor, and pays for it with a confirmation

The fast path has nothing but scores, so its floor is all it has. The smart path
has already paid for an LLM reranker that judges relevance directly — but
candidates below the floor never reached it, because the floor is applied when the
candidate is *generated*.

So on the smart path the floor is split in two:

```text
              probe floor                     floor
                   │                            │
   ────────────────┼────────────────────────────┼──────────────►  cosine
                   │        rescued band        │
                   │   kept only if the         │  kept on the
                   │   reranker confirms        │  score alone
                   │   (relevance ≥ 0.6)        │
```

- `MP_RECALL_SEMANTIC_RESCUE_MARGIN` (default 0.25) is how far below the floor the
  smart path probes. 0 disables it.
- A candidate that enters this way is **rescued**, and is recalled only if its
  rerank relevance is at least `MP_RECALL_RESCUE_MIN_RELEVANCE` (default 0.6 —
  the rerank rubric's "useful background" band). It has no above-floor evidence of
  its own, so it is held to a stricter bar than an ordinary hit.
- If reranking fails, rescued candidates are dropped and the answer is the one the
  floor would have given. Degradation goes to the old behaviour, never past it.
- **The rescue may only add candidates; it never changes the treatment of a memory
  another route already matched.** Anything the lexical or entity route matched
  has evidence of its own, and the fast path would have returned it — so the
  rescue itself never makes `smart` recall less than `fast`. (A *veto* deliberately
  can, for the semantic-only case; that is the subject of the next section.)
- The **fast path never probes**: without a confirmation signal, a lowered floor
  admits noise and nothing else.

Every decision is visible in the audit trail (`kept_rescued_confirmed` /
`rescued_unconfirmed`); a recall that "should not" have happened is otherwise
indistinguishable from a bug.

The rejected alternative is worth recording, because it is the obvious one: an
**adaptive threshold relative to each query's own similarity distribution**. It
does fix the example above. But a lone *irrelevant* hit is distributed exactly like
a lone *relevant* one, so no per-query statistic can tell them apart — and such a
rule has to lower the floor for low-scoring queries, which is precisely where the
irrelevant hits live. It trades a tunable constant for a heuristic that cannot be
calibrated. [ADR-0006](./adr/0006-confirmed-rescue-below-the-semantic-floor.md) has
the full argument.

## The reranker's "not useful" verdict is binding

The rescue asks the model to confirm candidates the score rejected. The measured
problem was the mirror image: candidates the score *accepted* and the model
rejected.

```
                                        semantic   rerank   final   outcome
rec-013  relevant paraphrase              0.523     0.950    0.873   recalled
rec-008  "what do I use?" vs a preference 0.502     0.050    0.563   recalled  <- wrong
rec-014  the mnemonic technique            0.553     0.050    0.558   recalled  <- wrong
```

The model was right both times it said "not useful", and its judgement was worth
0.35 of a score that had already reached 0.56 from rank alone. So on the smart
path **a rerank relevance below `MP_RECALL_MIN_RERANK_RELEVANCE` (default 0.3,
the rerank rubric's own "not useful here" band) vetoes the candidate outright.**

Two guards keep it from being reckless. The veto only applies when the reranker
*answered* — if it failed, there is no verdict to honour, and treating an outage as
a relevance judgement would be worse than the noise it removes. And it applies
only on the smart path, which is only reached by an explicit `mode: "smart"` or by
`auto` deciding the answer was unresolved.

Measured on the recall suite, same model, same embedder:

```
                     P@5     R@5     negative accuracy   forbidden hits
veto off             0.714   0.929   60.0%               7.1%
veto on              0.893   0.929   100.0%              0.0%
```

No recall lost: everything the veto removed was wrong.

**`auto` escalates on the same evidence.** The default mode runs the fast path
first, and its escalation rule used to be "the blended score is below 0.42" —
which cannot fire for the cases above, because a lone semantic hit scores ~0.78
whatever it is. It now also escalates when the fast path's best answer rests on
cosine alone and that cosine is below `MP_RECALL_ESCALATE_BELOW_SEMANTIC`
(default 0.6): no lexical or entity match means nothing corroborates it, and the
smart path is the only place that can be resolved.

```
auto, 14 recall cases        P@5     R@5     negative   model calls
escalation on evidence off   0.750   1.000   60.0%       5
escalation on evidence on    0.893   1.000   100.0%     15
```

Fifteen calls against twenty-seven for "always smart": the corroborated answers
never leave the fast path, and the ones that escalate are the ones that needed it.
[ADR-0007](./adr/0007-the-rerankers-judgement-is-binding.md) records the
alternatives and why re-weighting the score cannot do this.

**Trust is per provider, like the floor.** Both mechanisms are only sound if the
reranker is competent, and the built-in stand-in is not — it scores relevance from
token overlap, so a Chinese memory sharing one distinctive term with the query
gets ~0.09 where a real reranker gives ~0.95. Trusting that deleted legitimate
recall (measured: mock smart fell from 0.714/0.786 to 0.500/0.500). So the two
thresholds default to **0 under `MP_LLM_PROVIDER=mock`** and to 0.3 / 0.6 under
the real providers: a stand-in's verdict has no standing. Disable them explicitly
with the two environment variables if you configure a model whose judgement you do
not want to bind.

## A history question is not clamped to now

`includeHistory` used to mean less than it sounds like. The validity window was
still clamped to the present, and a superseded memory's `valid_until` is in the
past by definition — so "what did I use before?" could only return what is *still*
true. `rec-010` had been failing since the suite was written for exactly this
reason.

Now an explicit `asOf` wins, and otherwise the window is only clamped when history
was **not** asked for. A question understood as historical (or a caller setting
`includeHistory`) searches the whole timeline and lets ranking and the reranker
decide what belongs in the answer. Measured: `rec-010` passes, `rec-009`/`rec-011`
are unaffected, and the offline suite went from 0.714/0.786 to 0.750/0.857.
[ADR-0008](./adr/0008-history-is-not-clamped-to-now.md) records why the
alternative — requiring callers to pass a past `asOf` — was rejected.
