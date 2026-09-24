# ADR-0009: Recall feedback is recorded, not consumed

**Status:** accepted · **Date:** 2026-09-24

## Context

Every number the evaluation suite reports measures a question somebody typed by
hand into a dataset. That is the bottleneck: the golden set grows at the speed a
person is willing to write it, which is therefore also the speed at which this
system can be told it got something wrong.

The asymmetry matters more than the slowness. A precision failure is visible from
the inside — something was returned that should not have been, and the audit trail
says why. A recall failure is invisible: a query arrived, nothing relevant was
found, and the store has no way to distinguish that from a query nobody cared about.
"Nothing is known" is a correct answer often enough that the wrong instances of it
leave no trace anywhere.

Two things were true when this was decided:

- turning one real failure into a golden-set case took about seven minutes of
  transcription, which is why the dataset had stayed around thirty-eight cases
  across a month of daily use;
- the fix could not be allowed to become part of the thing it measures.

## Decision

A judgement can be recorded **at the moment of failure**, in both places failures
are observed:

- **Web UI** — the recall test offers three verdicts after every recall.
- **MCP** — `memory_feedback` lets an agent report the same thing after a wrong
  answer. It is the eighth tool; see "tool count" below.

Each row stores the query verbatim and **everything recall returned**, not merely
the part that offended. At labelling time nobody knows which half will matter later,
and a verdict that cannot be reconstructed is only a count.

Verdicts are `helpful`, `not_relevant`, `missed`. A `missed` verdict **must** name
what should have come back — either an existing memory (`expectedMemoryId`) or a
description of one that was never formed (`expectedText`) — enforced both in the
service and by a check constraint on the row. A complaint without an expectation
can be counted but never acted on, so it is refused rather than stored.

Promotion into the golden dataset is a **human step, deliberately not automated**:

```
pnpm feedback review                 print unresolved judgements as candidate cases
pnpm feedback promote <fb> <case>    record that `fb` became golden-set case `case`
```

Rows are picked up by export/import and deleted by `wipeUser`, because this is the
least recoverable data in the store: it was typed by a person at a moment that
cannot be replayed.

## Consequences

**Nothing in recall reads these rows.** The moment ranking consumed feedback, the
labels would become part of the system rather than a measurement of it, and later
numbers would be partly an artefact of earlier labels. Feedback changes what gets
measured, through cases a human adopts.

**The benchmark is still edited only by hand.** `review` prints and never appends.
A script that edited the golden set would also silently change what every future
comparison means — the dataset fingerprint added for exactly this reason would keep
working while comparing two datasets it believes are the same.

**Tool count went from seven to eight.** `mcp-tools.ts` opens by arguing that every
extra tool dilutes selection accuracy. `memory_feedback` earns the slot because it
overlaps nothing: the other seven either read or write memories, and none accepts a
judgement about one. The tool-set assertion in `mcp.test.ts` was updated in the same
commit, so the addition cannot drift into invisibility.

**`not_relevant` cannot say which returned memory was wrong.** Attributing it to a
single item would have meant a pick list in the UI and per-item buttons, which costs
more attention than the label is worth at the moment of judgement. `review`
therefore emits every returned memory as `forbidden` for these rows and marks the
 line for trimming, leaving the attribution to whoever adopts the case.

## Rejected alternatives

**Thumbs up/down on memories.** Cheaper to build and impossible to interpret: a
downvote on a memory says nothing about the query it was returned for, which is the
only thing the ranking can be blamed for.

**Learning from feedback at recall time** (re-weighting routes per user, or
reinforcing the memories that were judged right). It makes every subsequent
measurement depend on earlier labels, and it turns a disagreement into a change of
behaviour with no way to attribute a regression.

**Reward-signal style implicit labels** (did the agent's answer get accepted?). The
signal is about the agent's prose, not about whether the right memories came back;
the two diverge constantly.
