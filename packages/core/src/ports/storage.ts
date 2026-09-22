import type { IsoDateTime } from "@memory-palace/shared"
import type {
  AgentPolicy,
  Entity,
  ExtractionRun,
  Memory,
  MemoryEntityLink,
  MemoryFilter,
  MemoryRelation,
  MemoryStatus,
  Observation,
  ObservationStatus,
  RelationKind,
} from "../memory/types.js"
import type { PriorArtEntry, PriorArtInput } from "../prior-art/types.js"

/**
 * Storage port. `packages/storage-pg` implements it; nothing in the domain
 * knows that Postgres exists.
 *
 * This boundary is also what keeps a future single-process embedded build
 * (PGlite) possible: swapping storage means writing another adapter, not
 * rewriting the pipelines.
 */

export interface ObservationInsert {
  observation: Observation
}

export interface EmbeddingUpsert {
  userId: string
  memoryId: string
  model: string
  dim: number
  vector: number[]
}

export interface MemoryStore {
  // --- lifecycle -----------------------------------------------------------
  ping(): Promise<void>
  close(): Promise<void>
  /** Run `fn` in a single database transaction. Nested calls join the outer one. */
  transaction<T>(fn: (tx: MemoryStore) => Promise<T>): Promise<T>

  // --- observations --------------------------------------------------------
  /**
   * Store an observation, deduplicated by content, and return the row that holds
   * it — the existing one when this content was ingested before.
   *
   * Callers MUST use the returned observation for anything downstream: memories
   * reference their origin observation, and a repeat resolves to the row that
   * already existed rather than the id the caller proposed.
   */
  insertObservation(observation: Observation): Promise<Observation>
  getObservation(userId: string, id: string): Promise<Observation | null>
  setObservationStatus(userId: string, id: string, status: ObservationStatus): Promise<void>
  listObservations(
    userId: string,
    opts?: { status?: ObservationStatus; limit?: number },
  ): Promise<Observation[]>
  countObservations(userId: string): Promise<number>
  findObservationByHash(userId: string, contentHash: string): Promise<Observation | null>

  // --- memories ------------------------------------------------------------
  insertMemory(memory: Memory): Promise<void>
  getMemory(userId: string, id: string): Promise<Memory | null>
  getMemories(userId: string, ids: string[]): Promise<Memory[]>
  listMemories(
    userId: string,
    filter?: MemoryFilter,
    opts?: { limit?: number; orderBy?: "recordedAt" | "importance" | "confidence" },
  ): Promise<Memory[]>
  countMemories(userId: string, filter?: MemoryFilter): Promise<number>
  updateMemoryStatus(userId: string, ids: string[], status: MemoryStatus): Promise<void>
  /**
   * Close out a memory that a newer version replaces because the FACT changed:
   * sets `validUntil`, `supersededAt` and the status projection in one statement.
   */
  supersedeMemory(
    userId: string,
    id: string,
    opts: { validUntil: IsoDateTime; supersededAt: IsoDateTime; status?: MemoryStatus },
  ): Promise<void>
  /**
   * Stop treating a memory as the current version WITHOUT touching its valid
   * time. Used by REFINE, where only the wording improved — the fact held over
   * the same period, so its interval must stay intact.
   */
  markSupersededByRefinement(
    userId: string,
    id: string,
    opts: { supersededAt: IsoDateTime },
  ): Promise<void>
  /** Record another sighting of the same fact without creating a new version. */
  reinforceMemory(
    userId: string,
    id: string,
    opts: { confidence: number; importance?: number; recordedAt: IsoDateTime },
  ): Promise<void>
  /** Apply a correction from the user or an adjudicating agent. */
  updateMemoryContent(
    userId: string,
    id: string,
    opts: { content: string; summary?: string; importance?: number; confidence?: number },
  ): Promise<void>
  deleteMemories(userId: string, ids: string[]): Promise<number>

  // --- relations -----------------------------------------------------------
  insertRelations(relations: MemoryRelation[]): Promise<void>
  relationsFrom(userId: string, fromIds: string[], kind?: RelationKind): Promise<MemoryRelation[]>
  relationsTo(userId: string, toIds: string[], kind?: RelationKind): Promise<MemoryRelation[]>
  /** All memories awaiting confirmation (agent policy or unresolved conflict). */
  listPending(userId: string, limit?: number): Promise<Memory[]>
  /**
   * Memories that are active in the same slot and whose validity interval
   * overlaps `[from, to)`. Used to resolve the conflict a confirmation creates.
   */
  findOverlappingActive(
    userId: string,
    slotKey: string,
    from: IsoDateTime,
    to?: IsoDateTime,
    excludeIds?: string[],
  ): Promise<Memory[]>

  // --- temporal queries ----------------------------------------------------
  /** Memories whose valid-time interval contains `at`. */
  findValidAt(userId: string, at: IsoDateTime, filter?: MemoryFilter): Promise<Memory[]>
  /**
   * True bi-temporal query: what did the system believe at `believedAt` about
   * the world at `validAt`. This is the query a single-timeline model cannot answer.
   */
  findBelievedAt(
    userId: string,
    validAt: IsoDateTime,
    believedAt: IsoDateTime,
    filter?: MemoryFilter,
  ): Promise<Memory[]>
  /** Walk `supersedes` edges backwards from a memory, oldest first. */
  supersedesChain(userId: string, id: string): Promise<Memory[]>

  // --- entities ------------------------------------------------------------
  upsertEntity(entity: Entity): Promise<Entity>
  findEntitiesByNames(userId: string, names: string[]): Promise<Entity[]>
  listEntities(userId: string, limit?: number): Promise<Entity[]>
  countEntities(userId: string): Promise<number>
  linkMemoryEntities(links: MemoryEntityLink[]): Promise<void>
  entitiesForMemories(userId: string, memoryIds: string[]): Promise<Map<string, Entity[]>>
  memoryIdsForEntities(userId: string, entityIds: string[]): Promise<string[]>

  // --- embeddings ----------------------------------------------------------
  upsertEmbedding(input: EmbeddingUpsert): Promise<void>
  listEmbeddingModels(userId: string): Promise<string[]>
  countEmbeddings(userId: string, model: string): Promise<number>

  // --- observability -------------------------------------------------------
  insertExtractionRun(run: ExtractionRun): Promise<void>
  listExtractionRuns(userId: string, limit?: number): Promise<ExtractionRun[]>

  // --- agent policies ------------------------------------------------------
  getAgentPolicy(userId: string, agentId: string): Promise<AgentPolicy | null>
  upsertAgentPolicy(policy: AgentPolicy): Promise<void>
  listAgentPolicies(userId: string): Promise<AgentPolicy[]>
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface SearchHit {
  memoryId: string
  /** Route-specific raw score. Not comparable across routes. */
  score: number
  rank: number
}

export interface SearchOptions {
  limit: number
  filter?: MemoryFilter
  /** Valid-time point to search within. */
  asOf?: IsoDateTime
  /** Transaction-time point. */
  believedAt?: IsoDateTime
  /** Defaults to currently-valid statuses only. */
  statuses?: MemoryStatus[]
  /**
   * Minimum score for a hit to count, where the route's score is comparable
   * across queries.
   *
   * Only the semantic route needs one: an approximate-nearest-neighbour search
   * always returns `limit` rows no matter how dissimilar they are, so without a
   * floor an unrelated query still surfaces memories and "I don't know" becomes
   * impossible.
   *
   * Routes that are gated structurally do not use it. The lexical route, for
   * instance, matches on shared discriminative terms (ADR-0005): arriving at all
   * is the gate, and its score orders results rather than admitting them.
   */
  minScore?: number
}

/**
 * Each method is one retrieval route. Nothing here fans out or fuses; that is
 * `packages/retrieval` and the recall pipeline's job.
 */
export interface MemorySearch {
  semantic(userId: string, vector: number[], opts: SearchOptions): Promise<SearchHit[]>
  lexical(userId: string, query: string, opts: SearchOptions): Promise<SearchHit[]>
  byEntity(userId: string, entityIds: string[], opts: SearchOptions): Promise<SearchHit[]>
  recent(userId: string, opts: SearchOptions): Promise<SearchHit[]>
  important(userId: string, opts: SearchOptions): Promise<SearchHit[]>
}

/**
 * Prior-art storage.
 *
 * Its own port rather than methods on `MemoryStore`, because the two share no
 * lifecycle: memories are adjudicated and superseded, entries here are edited
 * and re-reviewed. `(userId, repo)` is unique, so re-adding a project updates
 * the existing entry instead of creating a duplicate.
 */
export interface PriorArtStore {
  list(userId: string): Promise<PriorArtEntry[]>
  get(userId: string, id: string): Promise<PriorArtEntry | undefined>
  /** Insert or replace by `(userId, repo)`. Returns the stored row. */
  upsert(userId: string, input: PriorArtInput, id?: string): Promise<PriorArtEntry>
  remove(userId: string, id: string): Promise<boolean>
}
