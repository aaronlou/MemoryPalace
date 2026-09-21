# Memory Palace

**Long-term memory infrastructure for AI agents — the same person's preferences,
goals, decisions and history, available to every agent they use.**

This is not a chat-history store with a vector index bolted on. The value is not
in how much is stored; it is in whether an agent retrieves the right thing at the
right moment, and whether it can tell what is *currently* true from what *used* to
be.

> Status: v0.1, working end to end. 158 tests green. The mock providers let the
> whole system — including the evaluation suite — run with no API key and no
> network. Cold start from an empty directory takes about 90 seconds, of which
> most is dependency installation.

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

Or all of it at once: `pnpm setup`.

### What you should see

`pnpm demo` walks through the design doc's own example: a user writes something
naturally, memories form, an agent recalls them, the situation then changes, and
**both** questions — "what do you use now?" and "what did you use six months
ago?" — stay answerable from the same store.

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
| `pnpm demo` | end-to-end walkthrough (`--reset` to start clean) |
| `pnpm backup [file]` | write a full JSON backup (default `backups/<date>.json`) |
| `pnpm restore <file>` | replace all data from a backup |
| `pnpm backup check <file>` | verify a backup **without touching the database** |
| `pnpm test` | full test suite (needs the database running) |
| `pnpm eval` | run the evaluation suite |
| `pnpm eval --repeat N` | run it N times and report mean/min/max |
| `pnpm eval --embedding mock\|real` | vary the embedder independently of the LLM |
| `pnpm eval:compare A B` | diff two eval runs after a prompt change |
| `pnpm build` | typecheck and emit `dist/` |
| `pnpm lint` / `format` | Biome |

---

## Evaluation

Three suites over a 36-case golden dataset, calibrated so the numbers mean
something.

### Reference points

| Provider | What it is | Extraction F1 | Adjudication | Recall P@5 / R@5 | Negative |
|---|---|---|---|---|---|
| `oracle` | returns the expected answer — calibrates the *harness* | **1.000** | **100%** | 0.750 / 0.833 | 100% |
| `null` | stores nothing | **0.000** | 10% | — | — |
| `mock` | rule-based, no API key | 0.750 | 30% | 0.750 / 0.833 | 100% |
| **DeepSeek + local embeddings** | the real stack | **0.933** | **100%** | 0.833 / 0.917 | 100% |

The real stack is DeepSeek (`deepseek-chat` for extraction, `deepseek-reasoner`
for adjudication) with a local embedding model served by Ollama, so no memory text
leaves the machine. Roughly $0.014 per full evaluation.

The oracle and null runs are asserted in the test suite: if a perfect model does
not score 1.0 and an empty one 0.0, then a real score like "F1 = 0.75" is
measuring the harness rather than the system.

**Two honest notes about this table.**

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
- **Hard paraphrases.** The similarity floor is a coarse filter (see above), so a
  question that shares little surface vocabulary with the memory it needs can fall
  below it. A stronger embedder is the real fix. The floor has been swept to its
  optimum and cannot be lowered further without trading away negative accuracy.

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
intuition. Recall is insensitive to it (the lexical and entity routes carry
recall); precision and negative accuracy are not:

| floor | P@5 | R@5 | negative accuracy | forbidden hits |
|---|---|---|---|---|
| 0.15 | 0.444 | 0.917 | 0.250 | 0.250 |
| 0.25 | 0.667 | 0.917 | 0.500 | 0.083 |
| 0.30 | 0.750 | 0.917 | 0.750 | 0.000 |
| 0.40 | 0.750 | 0.917 | 0.750 | 0.000 |
| **0.45** | **0.833** | **0.917** | **1.000** | 0.000 |
| **0.50** | **0.833** | **0.917** | **1.000** | 0.000 |

0.45 and 0.50 are identical, so the default sits on a small plateau rather than a
knife edge; 0.45 is used because it gives a little more headroom at no measured
cost.

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
importance and recency priors as a relevant one. It only starts cutting genuine
results at 0.50. **The semantic floor is the effective knob; the final threshold
is not.** The option is kept because the balance can differ under a different
embedder or on the smart path, where a reranker changes the score distribution.

**A correction worth recording.** An earlier version of this document claimed a
clean separation — "irrelevant 0.164-0.400, relevant 0.599-0.800". That was drawn
from five hand-picked pairs. Measured over sixteen pairs from the dataset, the
distributions **overlap**:

```
RELEVANT    n=9  min 0.432  median 0.597  max 0.800
IRRELEVANT  n=7  min 0.152  median 0.213  max 0.799
```

So a single absolute cosine threshold **cannot** cleanly separate relevant from
irrelevant with this embedder. The threshold still earns its place — it removes
the bulk of the noise at no cost to recall — but it is a coarse filter, not a
relevance test, and a hard paraphrase can fall below it. One live example:

```
query : 讲技术概念的时候应该怎么组织？
memory: 用户希望在被讲解 TypeScript 时，先了解整体结构和设计思想，再深入具体 API
cosine: 0.432   -> below the 0.45 floor, so it is not recalled
```

Lowering the floor to 0.40 would catch that case and drop negative accuracy from
1.000 to 0.750 everywhere else — buying one true positive with several false ones.
The better fixes are a stronger multilingual embedder (this is the concrete
argument for `bge-m3`, which is purpose-built for Chinese retrieval) or an
adaptive threshold relative to each query's own similarity distribution, rather
than one number for every query.

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
