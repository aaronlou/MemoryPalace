# ADR-0008: A history question is not clamped to now

**Status:** accepted · **Date:** 2026-09-21

## Context

The bi-temporal model (ADR-0001) separates two axes: when a fact held in the world
(`validFrom`/`validUntil`) and when the system believed it (`recordedAt`/
`supersededAt`). Recall exposes both — `asOf` for the first, `believedAt` for the
second — plus `includeHistory`, which widens the status filter to include
`superseded` rows.

`includeHistory` never worked on its own. The validity window was still clamped to
the present:

```ts
const asOf = query.asOf ?? referenceTime
```

A superseded memory's `valid_until` is in the past by definition, so
`valid_until > now` excluded exactly the versions `includeHistory` was asked for.
Answering "what did I use before?" required the caller to *also* supply a past
`asOf` — which is not how anyone asks the question, and not something the caller
can know without already holding the answer. `rec-010` had been failing in the
golden dataset since the suite was written, on both paths:

```
query    : 用户之前用什么框架？
memories : 用户使用 Vue (superseded, valid_until 2026-06-01), 用户改用 React
expected : Vue         got: nothing on fast, React on smart
```

The smart path tries to recover the window from query understanding
(`understanding.timeRangeFrom`), but the model returns `null` for this phrasing —
and it is right to: "before" has no lower bound.

## Decision

**An explicit `asOf` wins. Otherwise the validity window is clamped to now only
when history was not asked for.**

```ts
const includeHistory = (query.includeHistory ?? false) || understanding?.intent === "historical"
const asOf = query.asOf ?? understanding?.timeRangeFrom ?? (includeHistory ? undefined : referenceTime)
```

"History was asked for" means either the caller set `includeHistory`, or query
understanding classified the intent as historical. In both cases the search covers
the whole timeline — statuses already include `superseded` — and ranking plus the
reranker decide what belongs in the answer. Ranking still penalises versions that
are no longer current (`HISTORICAL_PENALTY`), so including them is not the same as
preferring them.

## Consequences

- `rec-010` passes on both paths. The offline suite went from 0.714 / 0.786 to
  **0.750 / 0.857**; `rec-009` and `rec-011` (which also query about the past) are
  unaffected.
- Expired-but-never-superseded memories (`validUntil` in the past, `status`
  still `active`) are now reachable for historical questions. Previously they were
  unreachable by any query that did not name a past `asOf`, which was a silent hole
  rather than a decision.
- The default path is unchanged: without `includeHistory` (and with non-historical
  intent) the window is still clamped to now, so "what do I use now?" cannot
  return what the user stopped using.
- The transaction-time axis is untouched. Asking what the system *believed* at a
  past moment still requires `believedAt`, because that question genuinely has no
  default.

## Alternatives rejected

- **Require callers to pass `asOf`.** That is what the README used to document,
  and it is a reasonable API for a program. It is not how an agent asks: the query
  arrives as "what did I use before?", and the whole point of the system is to
  answer it. It also made `includeHistory` a flag that could not do what its name
  promised.
- **Derive a lower bound from the query understanding and keep the clamp.**
  Tried: the model returns `null` for "before", correctly, because the question has
  no lower bound. Requiring one would make the case unanswerable by construction.
- **Drop `includeHistory` and always search the whole timeline.** Then every
  current-state question competes with the versions it superseded, and the
  `status`/penalty machinery is doing precision work that a filter does for free.
- **Return the superseded version only, rather than ranking both.** "What did I use
  before?" and "what do I use now?" are different questions, but a caller may
  legitimately want the history *and* the current answer — `rec-010` asserts Vue,
  and the ranking is what decides the order when both are relevant.
