# Architecture decision records

Each record captures a decision that is expensive to reverse, the alternatives
that were rejected, and what the decision costs.

| # | Decision |
|---|---|
| [0001](./0001-immutable-versions-and-bitemporal-time.md) | Memories are immutable versions with valid time and transaction time |
| [0002](./0002-postgres-and-pgvector.md) | One PostgreSQL + pgvector, no separate vector store |
| [0003](./0003-provider-abstraction-boundary.md) | Model access goes through ports defined in the domain |
| [0004](./0004-one-adjudication-call.md) | Dedup and conflict detection are one model call |
| [0005](./0005-qualifying-routes-and-similarity-floors.md) | Recall requires retrieval evidence; nothing is padded |
| [0006](./0006-confirmed-rescue-below-the-semantic-floor.md) | A below-floor candidate is recalled only if the reranker confirms it |
| [0007](./0007-the-rerankers-judgement-is-binding.md) | The reranker's "not useful" verdict is binding, when the reranker can be trusted |
| [0008](./0008-history-is-not-clamped-to-now.md) | A history question is not clamped to now |
