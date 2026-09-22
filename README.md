# Memory Palace

**Long-term memory infrastructure for AI agents — the same person's preferences,
goals, decisions and history, available to every agent they use.**

This is not a chat-history store with a vector index bolted on. The value is not
in how much is stored; it is in whether an agent retrieves the right thing at the
right moment, and whether it can tell what is *currently* true from what *used* to
be.

> Status: v0.1, working end to end. 181 tests green. The mock providers let the
> whole system — including the evaluation suite — run with no API key and no
> network. Cold start from an empty directory takes about 90 seconds, of which
> most is dependency installation. CI runs lint, migrations, the build, the whole
> suite and the walkthrough twice on every push, on mock providers, so it costs
> nothing.

---

## Quick start

```bash
pnpm install                 # dependencies
pnpm db:start                # self-contained PostgreSQL 18 + pgvector cluster
pnpm migrate                 # create the schema
pnpm demo --reset            # end-to-end walkthrough, no credentials needed
```

Then run the two surfaces:

```bash
pnpm dev:api                 # HTTP API + web UI + MCP over HTTP  → http://127.0.0.1:8787
pnpm dev:mcp                 # MCP server over stdio (what agents spawn)
```

**No build step is needed for any of this.** The CLIs and both servers run the
TypeScript sources directly through `tsx`, and `tsconfig.tools.json` maps the
workspace packages to `src/` so they resolve without `dist/` existing. That is
deliberate: previously they resolved through each package's `exports` field to
`dist/`, so every one of these commands failed with `ERR_MODULE_NOT_FOUND` on a
fresh clone until something had run a build — which is how `pnpm migrate` broke
CI on its first substantive step.

Run `pnpm build` when you want the compiled artifacts, which the stdio MCP config
below points at.

Or all of it at once: `pnpm setup` (install → database → build → migrate).

### What you should see

`pnpm demo` walks through the design doc's own example: a user writes something
naturally, memories form, an agent recalls them, the situation then changes, and
**both** questions — "what do you use now?" and "what did you use six months
ago?" — stay answerable from the same store.

It also **checks the claims it prints** and exits non-zero if one of them is false,
so it works as a smoke test rather than a wall of output to skim. That is not
decorum: two real defects were hiding in that output, and both are described under
"what the walkthrough found" below.

---

## Using it from an agent

Memory Palace speaks [MCP](https://modelcontextprotocol.io) (v2, spec
`2026-07-28`). Point any MCP client at the stdio server.

**Claude Desktop / Cursor / any stdio client:**

```json
{
  "mcpServers": {
    "memory-palace": {
      "command": "node",
      "args": ["/absolute/path/to/MemoryPalace/apps/mcp/dist/main.js"],
      "env": {
        "DATABASE_URL": "postgresql://mp@127.0.0.1:55432/memory_palace",
        "MP_LLM_PROVIDER": "deepseek",
        "DEEPSEEK_API_KEY": "sk-..."
      }
    }
  }
}
```

Run `pnpm build` first so `apps/mcp/dist/main.js` exists. For development, swap
the command for `pnpm` with `args: ["exec", "tsx", "apps/mcp/src/main.ts"]`.

**DSH**, which this project was dogfooded against, uses a slightly different
shape (verified against `packages/mcp/mcp-client` in the DSH source):

```jsonc
{
  "transport": "stdio",
  "serverName": "memory-palace",   // tools appear as mcp__memory-palace__memory_recall
  "command": "node",
  "args": ["/absolute/path/to/MemoryPalace/apps/mcp/dist/main.js"],
  "toolCallTimeoutMs": 60000
}
```

**Remote / containerised agents** can use Streamable HTTP instead: the API server
exposes the same tools at `POST /mcp`.

### The tools

| Tool | When the agent should call it |
|---|---|
| `memory_recall` | Before answering anything where the user's own context, preferences or history would change the answer |
| `memory_remember` | When the user states something durable about themselves |
| `memory_search` | Deterministic lookup — "what exactly is stored?" |
| `memory_update` | Correcting a memory that is wrong |
| `memory_forget` | Retiring or permanently deleting |
| `memory_confirm` | Reviewing what is awaiting confirmation |
| `memory_stats` | Checking whether anything is known at all |

Tool descriptions are written as prompts, not as API docs — that is the only
thing the model sees when deciding whether to call one.

---

## How it works

```
        remember                          recall
           │                                │
           ▼                                ▼
   ┌───────────────┐              ┌──────────────────┐
   │  Observation  │              │  Query            │
   │  (verbatim)   │              │  understanding    │
   └───────┬───────┘              └────────┬─────────┘
           ▼                               ▼
   ┌───────────────┐            semantic · lexical · entity
   │  Extraction   │            recent   · importance      ← 5 routes
   │  + classify   │                       │
   └───────┬───────┘                       ▼
           ▼                          RRF fusion
   ┌───────────────┐                       │
   │ Adjudication  │  one call:      qualifying-route filter
   │ DUPLICATE     │  dedup AND      score threshold
   │ REFINE        │  conflict              │
   │ SUPERSEDE     │                        ▼
   │ CONTRADICT    │                 Context assembly
   │ COEXIST/NEW   │                 (token-budgeted)
   └───────┬───────┘                        │
           ▼                                ▼
   ┌───────────────────────────────────────────┐
   │  memories: immutable versions,            │
   │  two time axes, append-only + relations   │
   └───────────────────────────────────────────┘
```

### Three decisions that shape everything

**1. Memories are immutable versions, not rows you update.**
The claim (`content`, `type`, validity) never changes; changing it means a new
row plus a relation edge. Only the *assessment* (`confidence`, `importance`,
`status`) is mutable. This is what makes "why did that change?" answerable and
what stops a correction from silently destroying history.

**2. Two independent time axes.**
`validFrom`/`validUntil` is when the fact held in the world; `recordedAt`/
`supersededAt` is when the system believed it. A single timeline cannot express
"in mid-2026 we had already learned the 2025 state was over", which is exactly
what you need to answer questions about the past honestly.

```bash
# what is true now
curl -s localhost:8787/api/recall -H 'content-type: application/json' \
  -d '{"query":"用户现在用什么前端框架？","format":"json"}' | jq '.memories[].memory.content'

# what was true six months ago
curl -s localhost:8787/api/recall -H 'content-type: application/json' \
  -d '{"query":"用户用什么前端框架？","asOf":"2026-03-01","includeHistory":true}' | jq '.memories[].memory.content'
```

**3. Returning nothing is a correct answer.**
A memory is only recalled if a query-conditional route actually matched it, and
only above a similarity floor. `recent` and `improved` are priors, not evidence:
if they could introduce candidates, every query would return something and an
agent could never distinguish "nothing is known" from "here is something vaguely
related".

### Safety properties worth knowing

- **No input is ever lost to a model failure.** The observation is written before
  any model call; a failed extraction leaves it replayable.
- **Agents cannot silently rewrite history.** Per-agent policies decide which
  memory types auto-commit; anything consequential lands in a confirmation queue
  and is never presented as fact until confirmed.
- **Conflicts are never auto-resolved.** Unresolvable ones park *both* sides for
  review rather than picking a winner.
- **Your data is yours.** Markdown export you can read, JSON export you can
  restore, and deletion that actually deletes.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm setup` | install + start database + migrate + build |
| `pnpm db:start` / `db:stop` / `db:status` | manage the repo-local Postgres cluster |
| `pnpm db:psql` | open a psql shell |
| `pnpm db:reset` | destroy and recreate the cluster (**deletes all data**) |
| `pnpm migrate` | apply pending migrations |
| `pnpm embedding:status` | schema width, model, and how many memories have a vector |
| `pnpm embedding:dim <N>` | change the vector width (**discards existing vectors**) |
| `pnpm embedding:reembed` | recompute every embedding with the configured model |
| `pnpm dev:api` | HTTP API + web UI + MCP-over-HTTP |
| `pnpm dev:mcp` | MCP server on stdio |
| `pnpm demo` | end-to-end walkthrough that verifies its own claims (`--reset` to start clean) |
| `pnpm backup [file]` | write a full JSON backup (default `backups/<date>.json`) |
| `pnpm restore <file>` | replace all data from a backup |
| `pnpm backup check <file>` | verify a backup **without touching the database** |
| `pnpm test` | full test suite (needs the database running) |
| `pnpm eval` | run the evaluation suite |
| `pnpm eval --repeat N` | run it N times and report mean/min/max |
| `pnpm eval --recall-mode fast\|smart\|auto` | measure the path an agent actually uses |
| `pnpm eval --embedding mock\|real` | vary the embedder independently of the LLM |
| `pnpm eval --filter rec-` | one suite only, when that is all that changed |
| `pnpm eval:compare A B` | diff two eval runs — refuses to compare across a changed dataset or recall mode |
| `pnpm build` | typecheck and emit `dist/`, plus `scripts/` and `evals/` (`tsconfig.tools.json`) |
| `pnpm lint` / `format` | Biome |

---

## Evaluation

Three suites over a 36-case golden dataset, calibrated so the numbers mean
something.

### Reference points

| Provider / embedder | Extraction F1 | Adjudication | Recall P@5 / R@5 | Negative |
|---|---|---|---|---|
| `oracle` — calibrates the *harness* | **1.000** | **100%** | 0.750 / 0.857 | 100% |
| `null` — stores nothing | **0.000** | 10% | 0.714 / 0.786 | 100% |
| `mock` — rule-based, no API key | 0.750 | 30% | 0.750 / 0.857 | 100% |
| DeepSeek + **bge-m3**, `smart` | 0.967 | 100% | 0.929 / 1.000 | 100% |
| DeepSeek + **bge-m3**, `auto` | — | — | 0.893 / 1.000 | 100% |
| DeepSeek + **embeddinggemma**, `smart` | **0.989** | 0.967 | 0.857 / 0.929 | 100% |
| DeepSeek + **embeddinggemma**, `auto` | 0.899 | 0.933 | 0.821 / 0.929 | 100% |
| DeepSeek + **embeddinggemma**, `fast` | — | — | 0.714 / 0.786 | 100% |

**Every row names its embedder, because the embedder decides recall.** The bge-m3
rows were measured when that model was installed; the embeddinggemma rows were
re-measured afterwards with `--repeat 3` and are reproducible on a machine that
has `embeddinggemma` (621 MB) rather than `bge-m3` (1.2 GB). The gap between them
— P@5 0.929 versus 0.857, R@5 1.000 versus 0.929 — is what the stronger retrieval
model buys, and it is the whole reason to prefer it.

`fast` agrees exactly across both embedders (0.714 / 0.786), which is expected:
that path applies no reranker, so its recall is dominated by the lexical and
entity routes rather than by semantic similarity.

Reports now record the embedding model, its width and the recall path in their
fingerprint, and `eval:compare` refuses to call two runs comparable when any of
those differ. Before that fix a report could not be attributed to an embedder at
all — which is how a baseline came to be published against a model that was no
longer installed.

The oracle and null runs are asserted in the test suite: if a perfect model does
not score 1.0 and an empty one 0.0, then a real score like "F1 = 0.75" is
measuring the harness rather than the system.

**Four honest notes about this table.**

*The offline recall numbers moved in two directions at once, and both are
explained.* The generator moved them **down**: the recall suite gained `rec-013`,
a hard paraphrase the offline stack **structurally cannot pass**, because a
hashing embedder has no notion of a paraphrase. `rec-014` is the matching guard —
a negative the offline stack does pass. Then the implementation moved them **up**:
`includeHistory` no longer clamps the validity window to now (see below), which
fixed `rec-010`, a case that had been failing since the suite was written. Net,
`mock` and `oracle` went from 0.750 / 0.833 to **0.750 / 0.857** — the dataset got
one case harder and the system got one case better.

*The real-stack numbers are all from the same 14-case recall suite*, measured with
`--repeat 3` for `smart` (P@5 0.929 over three runs, stable) and single runs for
`auto`/`fast`. Comparing them to the 0.833 / 0.917 published earlier would be
comparing different exams: the suite has changed, the embedder has changed, and
the recall path has changed.

*`auto` is the row that matters, because it is the default.* It reaches the smart
path's precision on this suite — P@5 0.893, R@5 1.000, negative accuracy 100% — for
**15 model calls instead of 27**, because it only escalates answers that nothing
corroborates. Both numbers are measured, not estimated; `pnpm eval --recall-mode
auto` reproduces them.

*The two paths answer different questions, and `fast` is now precision-first.*
Measured on the same suite, `fast` gives P@5 0.714 / R@5 0.786 / negative 100%: it
declines more often and is never wrong about what it returns. `smart` gives up some
precision to answer more. Neither is "the" score, which is why the report prints
the mode it measured.

*The mock scores 0.750, not the 0.900 it scored on the first version of the
dataset.* That earlier number was inflated: the dataset had been written while
looking at the rule-based extractor's output, so it rewarded that extractor's
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

### A prompt change, measured

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

### What is still weak

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
  the check on it is that it changes nothing (measured: identical scores with the
  margin at 0.15 and at 0). `rec-013` is the live case, and it fails offline on
  purpose. Worth restating plainly, since the earlier version of this document got
  it wrong: with bge-m3 the case is *not* below the floor (0.523) and never needed
  rescuing — the mechanism's measured value on this suite is precision (60% → 100%
  negative accuracy), not paraphrase recall.

### Language drift, and a correction to my own estimate

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

### A bug the live system found that the tests did not

Recorded here because it is the clearest argument for `pnpm eval` existing.

Neighbour lookup for adjudication was restricted to the **same memory type**, on
the reasoning that "a goal never supersedes a preference". Then a real model
stored *"I use Vue"* as a `fact` and *"I've switched to React"* as a `decision` —
same subject, different type. Adjudication was **never called**, the candidate was
inserted unconditionally, and the store ended up asserting both that the user uses
Vue and that they do not.

Type describes how a statement was phrased, not what it is about. The restriction
is removed, the prompt now says which decisions may cross types, and adjudication
accuracy went from 0.767 to 0.833. ADR-0004 records the correction in full.

The regression test for it initially passed against the buggy code, because the
offline mock extractor types both statements identically — so the type filter
never mattered. It was rewritten to seed the earlier memory under a deliberately
different type, and now fails on the bug with the message *"no relation was
written, so adjudication never ran on the earlier memory"*.

### Two more bugs, found by running the walkthrough twice

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

**A goal became a fact.** Step 6 printed `active Effect-TS goal memories: 0
(should stay 1)` — in an output nobody had read closely, for as long as the demo
existed. The check was reading the *type*; the type had drifted. The same fact,
re-worded, re-extracts under a different type ("我最近开始系统学习 Effect-TS"
reads as a `goal`, "我最近在系统学习 Effect-TS" as a `fact`), and REFINE inherited
the *candidate's* type — so paraphrasing yourself moved a memory between context
groups and, worse, between write policies (`decision` needs confirmation, `fact`
does not). A refinement now inherits its origin's type; SUPERSEDE still keeps the
candidate's, because a genuine change of state can change the category without
contradicting ADR-0004's lesson.

So the demo now checks the claims it prints — current versions of the *fact*
whatever type, is the store's state what it should be — and exits non-zero when one
is false. It is the first command a new user runs; it should not be the least
verified thing in the repository.

### The scripts were typechecked by nothing

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

### Why the embedder matters more than it looks

Switching from the hashing stand-in to a real embedder **improved** recall
(P@5 0.750 → 0.833, R@5 0.833 → 0.917) *and* fixed adjudication cases — because
adjudication cannot decide to replace a memory it never retrieved.

It also broke the system the first time, until the similarity floor was
recalibrated per model (see below). That is the whole reason the harness exists.

---

## Configuration

See [`.env.example`](./.env.example) for every option. The two that matter most:

**`MP_LLM_PROVIDER`** — `mock` (default, no key) or `deepseek` / `openai` /
`anthropic`. Extraction is the high-volume path and adjudication is the
quality-sensitive one, so they can use different models.

**`MP_EMBEDDING_PROVIDER`** — `mock` is a hashing stand-in that captures lexical
overlap only. **For real use, set this to a real embedding model**: paraphrase
recall depends on it, and the mock's recall numbers are a floor rather than a
target. `ollama` runs a model locally so nothing leaves the machine; `bge-m3` is
1024-dimensional and matches the schema out of the box.

The embedding model is a **separate quality axis from the language model**, and
the eval harness can vary them independently — `pnpm eval --provider oracle
--embedding real` isolates the embedder's contribution.

**Recall trust thresholds** — `MP_RECALL_MIN_RERANK_RELEVANCE` and
`MP_RECALL_ESCALATE_BELOW_SEMANTIC` decide how much authority the reranker's
judgement has. Both default to 0 under `MP_LLM_PROVIDER=mock` (a stand-in cannot
judge relevance) and to 0.3 / 0.6 under the real providers. Setting either to 0
makes the smart path only ever add candidates, never remove them.

### Switching embedding model

```bash
ollama pull bge-m3          # or whichever model you want
pnpm embedding:status       # compare schema width, model, and coverage
pnpm embedding:dim 1024     # only if the width differs — discards old vectors
pnpm embedding:reembed      # recompute
```

The application reads the column width from the **schema**, not from a constant
in the source, so it cannot disagree with its own database. A mismatch fails at
startup with the exact commands to fix it.

### The similarity floor is model-specific

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

### The smart path probes below the floor, and pays for it with a confirmation

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

- `MP_RECALL_SEMANTIC_RESCUE_MARGIN` (default 0.15) is how far below the floor the
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
calibrated. ADR-0006 has the full argument.

### The reranker's "not useful" verdict is binding

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
ADR-0007 records the alternatives and why re-weighting the score cannot do this.

**Trust is per provider, like the floor.** Both mechanisms are only sound if the
reranker is competent, and the built-in stand-in is not — it scores relevance from
token overlap, so a Chinese memory sharing one distinctive term with the query
gets ~0.09 where a real reranker gives ~0.95. Trusting that deleted legitimate
recall (measured: mock smart fell from 0.714/0.786 to 0.500/0.500). So the two
thresholds default to **0 under `MP_LLM_PROVIDER=mock`** and to 0.3 / 0.6 under
the real providers: a stand-in's verdict has no standing. Disable them explicitly
with the two environment variables if you configure a model whose judgement you do
not want to bind.

### A history question is not clamped to now

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
ADR-0008 records why the alternative — requiring callers to pass a past `asOf` —
was rejected.

---

## Project layout

```
packages/
  shared/            ids, time, errors, RRF fusion, token estimation
  core/              domain: types, ports, formation, evolution, recall
  llm/               provider adapters + deterministic mock + response cache
  storage-pg/        the only package that knows SQL exists
  runtime/           composition root, MCP tool registrations, export rendering
  test-support/      test fixtures (separate so production can't import them)
  integration-tests/ cross-cutting tests that span packages
apps/
  api/               Hono: REST + web UI + MCP over Streamable HTTP
  mcp/               MCP server over stdio
  web/               static UI, no bundler
evals/               golden dataset, metrics, harness, oracle
docs/                the design doc, the plan, and the ADRs
```

`packages/core` cannot import `storage-pg` — enforced by TypeScript project
references, not by convention.

---

## Documentation

- [Design doc](./docs/Memory-Palace-技术方案-v0.1.md) — the original proposal
- [Technology choices](./docs/01-技术选型评估-v0.1.md) — every selection with the
  rejected alternatives and why
- [Development plan](./docs/02-开发计划-v0.1.md) — phases, acceptance criteria, risks

---

## Requirements

- Node.js **≥ 22** (developed on 24.21 LTS)
- PostgreSQL **18** with **pgvector** and **pg_trgm**
  (`brew install postgresql@18 pgvector`, or use `docker compose up`)
- pnpm 11

Docker is optional: `scripts/db-local.sh` runs a self-contained cluster under
`.local-pg/` and touches no system state.

---

## Not built yet

Honest scope of v0.1:

- **Graph queries.** Relations are stored (`supersedes`, `refines`, `contradicts`,
  …) and walkable, but there is no graph projection. Deliberate: see §18 of the
  design doc.
- **Managed re-embedding.** The schema supports several embedding models side by
  side; the background job that fills them in does not exist yet.
- **Multi-device sync.** Export/import is the transport today.
- **Multi-user.** Every table is namespaced by `user_id` and the repository layer
  requires it, but there is no auth or tenant isolation.
- **Memory decay.** `archived` exists and is excluded from recall; automatic
  ageing-out does not.
- **Scheduled backups.** Backup is a command you run, not a daemon; there is no
  cron or retention policy.
