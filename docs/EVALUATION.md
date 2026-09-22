# Evaluation: how the numbers are produced, and what they do not mean

The README carries the summary table. This page carries the rest: how the harness
is calibrated, what each caveat costs, the changes that were measured rather than
guessed at, and the bugs that only showed up in live use. It is deliberately long —
a score without its caveats is marketing.

Run it with `pnpm eval`; see the [Commands](../README.md#commands) table for the
flags. The harness itself is `evals/harness.ts`, the dataset `evals/datasets/`, and
the metrics `evals/metrics.ts`.

> **`pnpm eval` and `pnpm test` are both destructive.** Each truncates every memory
> table in whatever database `DATABASE_URL` points at — `eval` before each case so
> one cannot leak into the next, the suite through its own fixtures. **`pnpm test`
> defaults to a separate database** (`memory_palace_test`, created by `pnpm db:test`)
> precisely so that running the suite cannot delete your memories; `pnpm eval` still
> follows `DATABASE_URL`, so point that at a scratch database. That is the
> right behaviour for a benchmark and the wrong behaviour for your data: running
> either against your development database deletes everything in it. This is not
> hypothetical. It has cost this project its own reference table once (a run at the
> wrong configuration was misread as a documentation error) and a real user's first
> few memories once (while writing this very warning). Point `DATABASE_URL` at a
> scratch database, or take a backup first (`pnpm backup`), and do not run them
> against anything you care about:
>
> ```bash
> createdb -h 127.0.0.1 -p 55432 -U mp mp_scratch
> DATABASE_URL=postgresql://mp@127.0.0.1:55432/mp_scratch pnpm migrate
> DATABASE_URL=postgresql://mp@127.0.0.1:55432/mp_scratch pnpm eval
> ```

Three suites over a 46-case golden dataset, calibrated so the numbers mean
something.

## Reference points

| Provider / embedder | Extraction F1 | Adjudication | Recall P@5 / R@5 | Negative |
|---|---|---|---|---|
| `oracle` — calibrates the *harness* | **1.000** | **100%** | 0.646 / 0.708 | 100% |
| `null` — extracts nothing | **0.000** | 10% | see note | see note |
| `mock` — rule-based, no API key | 0.750 | 30% | 0.646 / 0.708 | 100% |
| DeepSeek + **bge-m3**, `smart` | 0.967 | 100% | 0.929 / 1.000 | 100% |
| DeepSeek + **bge-m3**, `auto` | — | — | 0.893 / 1.000 | 100% |
| DeepSeek + **embeddinggemma**, `smart` | **0.989** | 0.967 | **0.958 / 1.000** | 100% |
| DeepSeek + **embeddinggemma**, `auto` | 0.899 | 0.933 | **0.938 / 1.000** | 100% |
| DeepSeek + **embeddinggemma**, `fast` | — | — | 0.583 / 0.625 | 100% |

**Every row names its embedder, because the embedder decides recall.** The bge-m3
rows were measured when that model was installed, on an earlier 14-case recall
suite; the embeddinggemma rows are from the current 24-case suite and are
reproducible on a machine that has `embeddinggemma` (621 MB) rather than `bge-m3`
(1.2 GB). The two are not comparable — different exam, different embedder — and
the report fingerprint now records enough (embedder, width, mode, thresholds,
dataset hash) that `eval:compare` will say so rather than score the difference.

The three offline rows were measured with the repository's default configuration,
which is also what CI runs. They are not configuration-independent — see the first
note below.

`fast` applies no reranker, so its recall comes from the lexical and entity routes
and the embedding model cannot help it: P@5 0.583 against `smart`'s 0.958.
Essentially everything `smart` buys is bought by the reranker reaching memories
that share no surface form with the query at all.

Reports now record the embedding model, its width and the recall path in their
fingerprint, and `eval:compare` refuses to call two runs comparable when any of
those differ. Before that fix a report could not be attributed to an embedder at
all — which is how a baseline came to be published against a model that was no
longer installed.

The oracle and null runs are asserted in the test suite: if a perfect model does
not score 1.0 and an empty one 0.0, then a real score like "F1 = 0.75" is
measuring the harness rather than the system. The offline recall rows are pinned
to a fixed similarity floor so that they measure the same thing on every machine.

**Ten honest notes about this table.**

*`null`'s recall columns are blank on purpose, not because it scored well.*
`NullEmbedding` returns all-zero vectors, and cosine distance between two zero
vectors is undefined — so pgvector's ordering over them is arbitrary. Run anyway it
reports P@5 0.639, R@5 1.000, negative accuracy 16.7% and a 25% forbidden-hit rate:
that is what "arbitrary" looks like, and the forbidden hits are a reminder that **no
similarity floor can save you from an embedder that returns zeros**, because the
floors all assume distance means something. That provider calibrates the *extraction*
metric, where 0.000 is the answer that matters.

*The offline rows are stated at the shipped thresholds.* The similarity floor is
chosen per embedding provider (`DEFAULT_SEMANTIC_FLOOR` in `config.ts`), so it is
part of what these numbers mean. These rows are `oracle` and `mock`, which always
run the hashing stand-in embedder, yet they still inherit the floor named by
`MP_EMBEDDING_PROVIDER`: point it at `ollama` (floor 0.65) rather than the `mock`
default (0.15) and the same suite scores differently, because a higher floor drops
more paraphrases from `fast`. Both readings are correct; they answer different
questions. If you compare your own run against this table, check the thresholds
first — `eval:compare` now reports every one that differs, so a disagreement here
is the configuration talking, not a regression.

*The recall suite has 24 cases, and the last ten are placed by measurement.* Cases
`rec-015` .. `rec-024` sit *inside* the band the smart path probes (the floor minus
`semanticRescueMargin`), at measured cosines between 0.408 and 0.605, where the
earlier cases sat either far above the floor or far below it. A suite that cannot
reach the band cannot tell you whether widening it is safe — which is exactly the
question that made them necessary. The set is a matched pair at an identical
0.429: `rec-017` (a documentation-style preference, must be recalled) and `rec-020`
(a cat's name, must not). No threshold can satisfy both, so the pair only passes if
the system is judging relevance rather than distance.

*The offline rows fell from 0.750 / 0.857 to 0.646 / 0.708 when those ten cases
arrived.* That is the dataset getting harder, not the system getting worse, and the
distinction is why the dataset hash sits in the report fingerprint. Every one of
the seven cases the offline stack now misses needs a term that appears only in the
memory and never in the query; a hashing bag-of-tokens has no notion of a
paraphrase, so it structurally cannot reach them. `rec-014` is the matching guard —
a negative the offline stack does pass.

*Those two rows are also stated at the default vector width.* The stand-in embedder
hashes each token into `hash % dim`, so its recall depends on the column width that
`pnpm migrate` creates — `vector(1024)`, which is what CI and a fresh clone have.
At 768 dimensions the same command reports 0.604 / 0.667. Neither is wrong; they
are different configurations, and `embeddingDim` is in the fingerprint so
`eval:compare` will refuse to read one as a change in the other.

*The bge-m3 rows are from an earlier, 14-case suite and are not comparable to the
rest.* They were measured while that model was installed. Comparing them to the
current embeddinggemma rows would be comparing different exams — different embedder,
different dataset — which is the mistake the fingerprint now exists to prevent.
Read them as a direction, not as a score.

*Re-measured on the current suite, bge-m3 gives `smart` P@5 0.917 / R@5 0.958 in a
single run*, with extraction F1 1.000, adjudication 100%, negative accuracy 100%,
$0.022 and **one** miss: `rec-022`, "容器编排要注意哪些问题？" against "用户的生产环境跑在
Kubernetes 上" (annotated cosine 0.416). That case sits inside the probe band, so it
was rescued and the reranker declined to confirm it — the mechanism behaving as
designed on a pair whose similarity alone cannot decide. One run is a data point,
not a baseline, and the embeddinggemma rows remain the measured ones.

*`auto` is the row that matters, because it is the default.* It reaches within two
points of the smart path's precision on this suite — P@5 0.938 against 0.958, both
at R@5 1.000 and negative accuracy 100% — while escalating only the answers nothing
corroborates. Both numbers are measured, not estimated;
`pnpm eval --recall-mode auto` reproduces them.

*The two paths answer different questions.* Measured on the same suite, `fast` gives
P@5 0.583 / R@5 0.625 / negative 100%: it declines more often and is never wrong
about what it returns. `smart` gives up some precision to answer more — 0.958 at
R@5 1.000. Neither is "the" score, which is why the report prints the mode it
measured, and why `recallMode` is in the fingerprint.

*The mock scores 0.750 on extraction, not the 0.900 it scored on the first version
of the dataset.* That earlier number was inflated: the dataset had been written
while looking at the rule-based extractor's output, so it rewarded that extractor's
phrasing. In particular it expected **one** memory where a compound sentence
contains two facts, while the extraction prompt explicitly says "one idea per
memory, split compound statements". The model was following the instruction and
the benchmark penalised it. Correcting the dataset *lowered* the mock's score,
which is the expected direction when a benchmark stops being fitted to one
implementation.

*Adjudication is noisier than extraction.* Across six identical runs of the real
stack:

```
extraction F1        0.944   (min 0.897  max 1.000)
evolution accuracy   0.950   (min 0.900  max 1.000)
recall P@5 / R@5     0.833 / 0.917                    stable
```

A hosted model is not deterministic even at temperature 0. Use `--repeat` when
comparing prompt changes:

```bash
pnpm eval --provider real --repeat 3
```

## A prompt change, measured

Adjudication was the weak spot. The failing case looked like this:

```
existing : 用户喜欢在回答里看到大段代码示例
candidate: 用户不太喜欢大段代码，更希望看到思路和解释
expected : SUPERSEDE        got: CONTRADICT
```

The cause was subtle. When the candidate happened to **mirror the existing
wording** ("不太喜欢在回答里看到大段代码示例"), the model returned SUPERSEDE 3/3.
With the looser phrasing that extraction actually produces, it returned CONTRADICT
3/3. The decision was being driven by surface similarity rather than by whether the
user was describing a change.

The prompt already *stated* the rule ("a change over time is SUPERSEDE, never
CONTRADICT"). Restating a principle was not enough, so the guidance was rewritten
as a procedure — ask *when* each statement was true, treat 了/不再/现在/no longer/now
as signals of a change, and use "could both have been written at the same moment?"
to identify a genuine contradiction. It also adds a tie-break: prefer SUPERSEDE,
because it preserves the old version in history whereas CONTRADICT leaves both
claims live.

A/B over six runs each, same model and same embedder:

```
evolution accuracy   0.883 -> 0.950   better    (A 0.800-0.900, B 0.900-1.000)
extraction F1        0.944 -> 0.943   indistinguishable
recall P@5 / R@5     unchanged
```

B's worst run equals A's best run, and B reaches 100% while A never exceeds 90%.
Extraction is unchanged, so the change improved adjudication specifically rather
than the prompt as a whole.

This also fixed a flaw in `eval:compare`: comparing two single runs reported
extraction as "WORSE" by 0.037 on what was pure run-to-run noise. It now compares
ranges over repeated runs and refuses to call an overlapping difference a change.

## What is still weak

- **`DUPLICATE` vs `REFINE`.** Genuinely ambiguous — a restatement that adds one
  word is defensibly either. Three cases list both as acceptable rather than
  asserting the author's preference, so they can no longer register as failures.
- **The fast path's precision/recall tradeoff is unresolvable without a model.**
  Measured across four floors, it can have R@5 1.000 with 40% of negative queries
  answered, or 100% negative accuracy with three misses. There is no plateau in
  between, because with bge-m3 an unrelated pair can score higher than a relevant
  one. Only the smart path can separate them, which is why `auto` escalates rather
  than the floor being tuned harder.
- **Both new mechanisms are only as good as the reranker.** The veto deletes
  recall the fast path would have returned, and the escalation spends two model
  calls, so a cheap or weak reranker makes the smart path *worse* than the fast
  one — measured, and the reason the thresholds default to 0 under the mock
  provider. Set `MP_RECALL_MIN_RERANK_RELEVANCE=0` to make the smart path only
  ever add, never subtract.
- **Hard paraphrases.** The similarity floor is a coarse filter (see above), so a
  question that shares little surface vocabulary with the memory it needs can fall
  below it. The smart path rescues exactly these, but only when the reranker
  confirms them, so the mechanism is live only where a real reranker is running.
  Under the mock providers it is **inert by construction**: the mock embedder
  derives similarity from shared tokens, so it has no notion of a paraphrase, and
  the fast path never probes at all, so the margin cannot move the offline rows.
  `rec-013` is the live case, and it fails offline on purpose.

  Worth restating plainly, since an earlier version of this document got it wrong:
  with bge-m3 at the old 0.45 floor that case scored 0.523 and never needed
  rescuing, and for a while the honest reading was that the mechanism bought
  precision (60% → 100% negative accuracy) rather than paraphrase recall. That is
  no longer the whole story. The suite now carries ten cases placed *inside* the
  band, and on those the mechanism buys recall: widening the margin from 0.15 to
  0.25 took P@5 from 0.667 to 0.958 and R@5 to 1.000, with negative accuracy held
  at 100%. The correction stands — the old example proved nothing about the floor —
  but the conclusion drawn from it was a property of a 14-case suite that could not
  reach the band in the first place.
- **Nothing measures latency.** The design doc budgets p95 < 150 ms for `fast` and
  p95 < 2.5 s for `smart`, and the default mode escalates to `smart` for any answer
  nothing corroborates. Every threshold in this document was chosen on quality
  alone; the cost side is unmeasured.

## Language drift, and a correction to my own estimate

A model occasionally answers in the wrong language. This is close to a silent
failure: an English memory in a Chinese memory store is nearly unfindable, because
CJK lexical matching is bigram-based and the semantic route is comparing across
languages.

An earlier version of this document put the rate at "roughly 1 in 20", from a
single observed case. Sampling 55 extractions of Chinese input produced **one**
occurrence, so the honest figure is closer to 1 in 55 — rare, and not reproducible
on demand. That is precisely why the fix is tested deterministically rather than
statistically:

- `detectScript` classifies text as CJK / latin / mixed, and the guard only fires
  when the input is CJK-dominant and **every** candidate is entirely latin —
  so Chinese memories containing "PostgreSQL" or "Effect-TS" are untouched.
- When it fires, the chunk is re-asked **once** with the language named
  explicitly. Two attempts and no more: retrying a stubborn model in a loop would
  burn tokens and delay every write.
- The retry is kept only if it actually corrected the mismatch, and the count is
  persisted in `extraction_runs.language_retries` (migration 0002) so a rising
  rate is visible rather than buried in a log line.

Six tests cover it with a stub that drifts on the first call and corrects on the
second. Disabling the guard makes three of them fail, so they are testing the
behaviour rather than the code path.

## A bug the live system found that the tests did not

Recorded here because it is the clearest argument for `pnpm eval` existing.

Neighbour lookup for adjudication was restricted to the **same memory type**, on
the reasoning that "a goal never supersedes a preference". Then a real model
stored *"I use Vue"* as a `fact` and *"I've switched to React"* as a `decision` —
same subject, different type. Adjudication was **never called**, the candidate was
inserted unconditionally, and the store ended up asserting both that the user uses
Vue and that they do not.

Type describes how a statement was phrased, not what it is about. The restriction
is removed, the prompt now says which decisions may cross types, and adjudication
accuracy went from 0.767 to 0.833. [ADR-0004](./adr/0004-one-adjudication-call.md)
records the correction in full.

The regression test for it initially passed against the buggy code, because the
offline mock extractor types both statements identically — so the type filter
never mattered. It was rewritten to seed the earlier memory under a deliberately
different type, and now fails on the bug with the message *"no relation was
written, so adjudication never ran on the earlier memory"*.

## Two more bugs, found by running the walkthrough twice

Both of these were hiding in `pnpm demo`'s own output, and neither was reachable
from the suites. Recorded for the same reason as the case above.

**A repeat crashed the write.** Running `pnpm demo` a second time without
`--reset` died with a foreign key violation:

```
error: insert or update on table "memories" violates foreign key constraint
       "memories_origin_observation_id_fkey"
detail: Key (origin_observation_id)=(obs_01M322VD...) is not present in table "observations".
```

`insertObservation` deduplicates by content hash with `ON CONFLICT ... DO NOTHING`
— by design, so re-ingesting the same text cannot store it twice. But `remember`
carried on with the id it had *proposed*, so the memory it then wrote referenced an
observation row that was never created. The write was lost, and with it the user's
statement.

The idempotency test covers the same text three times and passed throughout, which
is the interesting part: a repeat adjudicated **DUPLICATE** is applied as
`reinforce`, an UPDATE, which never touches the foreign key. The bug needs a repeat
whose decision is an **insert** — REFINE or SUPERSEDE — and that is what the demo's
second run produced, because by then the neighbour it compared against had already
been refined into different wording. Reachable in production for the same reason,
with nothing exotic involved.

The fix is a contract, not a patch: `insertObservation` now returns **the row that
holds this content**, existing one included, and `remember` uses that row for
everything downstream. The port says so, so a future adapter cannot quietly break
it again.

**A goal became a fact.** Step 6 printed
`active Effect-TS goal memories: 0 (should stay 1)` — in an output nobody had read
closely, for as long as the demo existed. The check was reading the *type*; the type
had drifted. The same fact, re-worded, re-extracts under a different type
("我最近开始系统学习 Effect-TS" reads as a `goal`, "我最近在系统学习 Effect-TS" as
a `fact`), and REFINE inherited the *candidate's* type — so paraphrasing yourself
moved a memory between context groups and, worse, between write policies
(`decision` needs confirmation, `fact` does not). A refinement now inherits its
origin's type; SUPERSEDE still keeps the candidate's, because a genuine change of
state can change the category without contradicting ADR-0004's lesson.

So the demo now checks the claims it prints — current versions of the *fact*
whatever type, is the store's state what it should be — and exits non-zero when one
is false. It is the first command a new user runs; it should not be the least
verified thing in the repository.

## The scripts were typechecked by nothing

Fixing the above needed a type error to surface at runtime first: a duplicate
`const before` in `scripts/demo.ts` compiled fine and threw when the demo ran.
`pnpm test` transpiles without checking, and the root build only referenced
`packages/` and `apps/` — so every CLI in `scripts/` and the whole eval harness in
`evals/` were unchecked. `tsconfig.tools.json` now covers them (no emit: they are
entry points, not artifacts), and `pnpm build` runs it.

Switching it on immediately found two latent errors that had been invisible: a
`as never` cast in the harness that was papering over an `acceptDecisions` type too
narrow to hold the `UNKNOWN` the harness itself infers, and a type re-exported from
a module that never exported it.

## Why the embedder matters more than it looks

Switching from the hashing stand-in to a real embedder **improved** recall
(P@5 0.750 → 0.833, R@5 0.833 → 0.917) *and* fixed adjudication cases — because
adjudication cannot decide to replace a memory it never retrieved.

It also broke the system the first time, until the similarity floor was
recalibrated per model (see [recall](./RECALL.md)). That is the whole reason the
harness exists.
