/**
 * Migrations, as ordered SQL.
 *
 * Kept as TypeScript strings rather than .sql files read at runtime so that the
 * schema travels with the compiled package and cannot go missing because of a
 * working-directory assumption.
 *
 * Rules for adding one: never edit an applied migration, always append. Each is
 * applied inside a transaction and recorded by id.
 */

export interface Migration {
  id: string
  sql: string
}

const INITIAL_SCHEMA = `
-- Extensions. pgvector for semantic search, btree_gist so a GiST exclusion
-- constraint can mix an equality column with a range column, pg_trgm because
-- Postgres' built-in full-text search does not tokenise Chinese.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- observations: raw experience, append-only, never deleted on extraction failure
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observations (
  id              text PRIMARY KEY,
  user_id         text NOT NULL,
  content         text NOT NULL,
  content_hash    text NOT NULL,
  source_kind     text NOT NULL,
  agent_id        text,
  occurred_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processed','failed','skipped')),
  metadata        jsonb
);

CREATE INDEX IF NOT EXISTS observations_user_created_idx
  ON observations (user_id, created_at DESC);

-- Idempotency: re-ingesting the identical text must not create a second
-- observation, and therefore must not create a second set of memories.
CREATE UNIQUE INDEX IF NOT EXISTS observations_user_hash_idx
  ON observations (user_id, content_hash);

-- ---------------------------------------------------------------------------
-- memories: immutable versions. The CLAIM columns are never updated; only the
-- assessment columns (confidence, importance, status, superseded_at, last_seen_at,
-- reinforced_count) may change. See Memory in @memory-palace/core.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id                    text PRIMARY KEY,
  user_id               text NOT NULL,
  type                  text NOT NULL
                          CHECK (type IN ('fact','preference','experience','decision','relationship','goal','event')),
  content               text NOT NULL,
  summary               text,
  slot_key              text,
  confidence            real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  importance            real NOT NULL CHECK (importance >= 0 AND importance <= 1),
  valid_from            timestamptz,
  valid_until           timestamptz,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  superseded_at         timestamptz,
  last_seen_at          timestamptz,
  reinforced_count      integer NOT NULL DEFAULT 0,
  status                text NOT NULL
                          CHECK (status IN ('active','pending','superseded','archived')),
  origin_observation_id text REFERENCES observations(id) ON DELETE SET NULL,
  agent_id              text,
  extraction_run_id     text,
  metadata              jsonb,
  content_tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED,
  -- Half-open validity intervals [valid_from, valid_until).
  CONSTRAINT memories_validity_order CHECK (
    valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from
  )
);

-- Two ACTIVE memories may never share a slot with overlapping validity.
--
-- The \`status = 'active'\` predicate is essential: a REFINE produces a new
-- version covering the SAME period as the one it replaces, so without the
-- predicate every refinement would violate the constraint. Superseded rows are
-- history and are allowed to overlap.
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_no_overlapping_slot;
ALTER TABLE memories ADD CONSTRAINT memories_no_overlapping_slot
  EXCLUDE USING gist (
    user_id WITH =,
    slot_key WITH =,
    tstzrange(valid_from, COALESCE(valid_until, 'infinity'::timestamptz)) WITH &&
  ) WHERE (slot_key IS NOT NULL AND status = 'active');

CREATE INDEX IF NOT EXISTS memories_user_status_idx ON memories (user_id, status);
CREATE INDEX IF NOT EXISTS memories_user_type_status_idx ON memories (user_id, type, status);
CREATE INDEX IF NOT EXISTS memories_validity_idx ON memories (user_id, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS memories_recorded_idx ON memories (user_id, recorded_at);
CREATE INDEX IF NOT EXISTS memories_tsv_idx ON memories USING gin (content_tsv);
-- Trigram index: the only lexical route that works for Chinese, where 'simple'
-- tokenisation produces no useful words.
CREATE INDEX IF NOT EXISTS memories_content_trgm_idx
  ON memories USING gin (content gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- memory_embeddings: one row per (memory, model).
--
-- Separate from memories so that changing embedding model is a background
-- re-embed, not a migration: both models can coexist and be A/B compared.
-- Embeddings from different providers live in different vector spaces and are
-- NOT interchangeable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id   text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  model       text NOT NULL,
  dim         integer NOT NULL,
  embedding   vector(1024) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, model)
);

CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx ON memory_embeddings (model);
CREATE INDEX IF NOT EXISTS memory_embeddings_hnsw_idx
  ON memory_embeddings USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- memory_relations: typed, append-only edges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_relations (
  id              text PRIMARY KEY,
  user_id         text NOT NULL,
  from_memory_id  text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id    text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind            text NOT NULL
                    CHECK (kind IN ('supersedes','refines','contradicts','supports','related_to','derived_from')),
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_relations_no_self CHECK (from_memory_id <> to_memory_id)
);

CREATE INDEX IF NOT EXISTS memory_relations_from_idx ON memory_relations (from_memory_id, kind);
CREATE INDEX IF NOT EXISTS memory_relations_to_idx ON memory_relations (to_memory_id, kind);

-- ---------------------------------------------------------------------------
-- entities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  canonical_name text NOT NULL,
  kind           text NOT NULL,
  aliases        text[] NOT NULL DEFAULT '{}',
  -- Normalised matching key: "Effect-TS" / "effect ts" / "EffectTS" share one.
  entity_key     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS entities_user_key_idx ON entities (user_id, entity_key);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id  text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id  text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role       text,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS memory_entities_entity_idx ON memory_entities (entity_id);

-- ---------------------------------------------------------------------------
-- provenance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_sources (
  id             text PRIMARY KEY,
  memory_id      text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  observation_id text REFERENCES observations(id) ON DELETE SET NULL,
  agent_id       text,
  kind           text NOT NULL,
  ref            text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_sources_memory_idx ON memory_sources (memory_id);

-- ---------------------------------------------------------------------------
-- per-agent write policy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_policies (
  user_id                 text NOT NULL,
  agent_id                text NOT NULL,
  allowed_types           text[] NOT NULL,
  require_confirmation_for text[] NOT NULL,
  can_write               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id)
);

-- ---------------------------------------------------------------------------
-- extraction_runs: observability. Without this, a bad eval score cannot be
-- attributed to the prompt, the model, or the input.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extraction_runs (
  id                  text PRIMARY KEY,
  user_id             text NOT NULL,
  observation_id      text,
  prompt_version      text NOT NULL,
  model_id            text NOT NULL,
  input_tokens        integer NOT NULL DEFAULT 0,
  output_tokens       integer NOT NULL DEFAULT 0,
  cost_usd            double precision NOT NULL DEFAULT 0,
  latency_ms          integer NOT NULL DEFAULT 0,
  candidates_produced integer NOT NULL DEFAULT 0,
  memories_written    integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  error               text
);

CREATE INDEX IF NOT EXISTS extraction_runs_user_created_idx
  ON extraction_runs (user_id, created_at DESC);
`

/**
 * Language drift only became measurable after running against a real model, so it
 * was not in the initial schema. Recording it in the database rather than only in
 * a log line means it survives and can be trended.
 */
const LANGUAGE_RETRIES = `
ALTER TABLE extraction_runs
  ADD COLUMN IF NOT EXISTS language_retries integer NOT NULL DEFAULT 0;
`

/** Append-only: never edit an applied migration, always add a new one. */
export const MIGRATIONS: Migration[] = [
  { id: "0001_initial_schema", sql: INITIAL_SCHEMA },
  { id: "0002_extraction_run_language_retries", sql: LANGUAGE_RETRIES },
]

/** SQL applied before any migration runs. */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
`
