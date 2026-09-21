# ADR-0002: PostgreSQL + pgvector, no separate vector store

**Status:** accepted · **Date:** 2026-09-21

## Context

The system needs semantic, lexical, entity and temporal retrieval over memories,
plus transactional writes across several tables.

## Decision

One PostgreSQL 18 instance with `pgvector`, `pg_trgm` and `btree_gist`. Vector
search is a table (`memory_embeddings`), not a separate service.

## Rationale

The hard part of this system is *change over time*, not similarity search.
Temporal queries need range predicates, recursive CTEs and exclusion constraints;
"insert the new version, close the old one's validity, write the relation edge and
update the status projection" needs to be atomic. All of that is a relational
database's strength, and none of it survives being split across two stores.

`memory_embeddings` is keyed by `(memory_id, model)` so two embedding models can
coexist. Embeddings from different providers live in different vector spaces and
are **not** interchangeable, so the ability to run an old and a new model side by
side turns "switch models" from a downtime migration into a background re-embed
plus an A/B comparison.

## Consequences

- Hybrid retrieval fuses five routes with reciprocal rank fusion **in one SQL
  query**; no application-level fan-out or second system.
- Chinese lexical search needs care: Postgres `simple` tokenisation produces
  almost nothing useful for CJK, so the lexical route gates on shared
  discriminative terms and uses trigram similarity only for ordering.
- `vector(N)` needs a fixed width to index. 1024 is declared; a different width
  needs a migration, and the apps assert the configuration against it at startup.

## Alternatives rejected

- **Qdrant / Chroma / Weaviate.** A second store means two backups, two
  consistency stories and two upgrades, in exchange for faster vector search on a
  corpus of tens of thousands of rows. This is the "RAG thinking" the design doc
  warns against.
- **SQLite + sqlite-vec.** Attractive for a single-file local product, but it
  gives up range types, exclusion constraints and real concurrent writes — the
  features the temporal model depends on.
- **PGlite (embedded Postgres in WASM).** Genuinely appealing for distribution,
  but MCP's stdio transport spawns one server process per agent session, so
  several processes would write the same data file. It becomes viable only if the
  system moves to a single long-lived HTTP process, which is why the storage port
  exists.
- **Neo4j.** See design doc §18: graph is a query pattern here, not a storage
  choice, until relationship traversal is a *measured* bottleneck.
