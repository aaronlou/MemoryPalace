# ADR-0001: Memories are immutable versions, with two time axes

**Status:** accepted · **Date:** 2026-09-21

## Context

The design doc requires that a change of belief never destroys history (§6):
"2025 React → 2026 Vue → 2027 React" must be fully reconstructible, and the
system must answer both "what do you use now?" and "why did you switch?".

The original proposal put `supersededBy`, `validFrom`, `validUntil` and `status`
on a single mutable `Memory` row while also mentioning a `memory_versions` table.
That is ambiguous the first time a memory's content changes: either the row is
updated (history lost) or a new row is inserted (and it is unclear what
`superseded_by` now points at).

## Decision

**Rows are immutable versions. A change of belief is a new row plus a relation
edge. Only the assessment is mutable.**

- Immutable: `type`, `content`, `summary`, `validFrom`, `validUntil`,
  `recordedAt`, `originObservationId`
- Mutable: `confidence`, `importance`, `status`, `supersededAt`, `lastSeenAt`,
  `reinforcedCount`

Two independent time axes:

| Axis | Columns | Question it answers |
|---|---|---|
| valid time | `valid_from` / `valid_until` | when was this true in the world? |
| transaction time | `recorded_at` / `superseded_at` | when did we believe it? |

`valid_until IS NULL` means "still true as far as we know".

Re-observing a fact raises `confidence` and `reinforced_count` without creating a
version. Creating a version on every mention would make the chain useless noise.

## Consequences

**Enabled**

- History is complete and cheap to query (`supersedesChain` is a recursive CTE).
- `REFINE` (better wording, same fact) is distinguishable from `SUPERSEDE` (the
  fact stopped being true): a refinement leaves `valid_until` NULL, a supersede
  sets it. This single discriminator is what lets historical queries return one
  row per fact instead of double-reporting.
- Bi-temporal queries are expressible: "in mid-2026 we had already learned the
  2025 state was over" returns nothing for 2025-06, which a single timeline
  cannot express.

**Costs**

- "Currently valid" is a projection over relations and must be maintained in the
  same transaction; a consistency test guards against drift.
- The exclusion constraint must be scoped to `status = 'active'`, because a
  refinement deliberately overlaps its predecessor's validity.
- Two rows can describe the same period; every read path must know which one to
  prefer (see ADR-0005).

## Alternatives rejected

- **Mutable row with an audit table.** Read paths get fast but every write path
  must remember to write the audit row; one missed path silently loses history.
- **Event sourcing from scratch.** More machinery than this problem needs, and it
  makes the common query (what is true now?) the expensive one.
