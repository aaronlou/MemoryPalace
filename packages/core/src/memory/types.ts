import type { IsoDateTime } from "@memory-palace/shared"

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

export const MEMORY_TYPES = [
  "fact",
  "preference",
  "experience",
  "decision",
  "relationship",
  "goal",
  "event",
] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const MEMORY_STATUSES = [
  /** Currently believed and retrievable. */
  "active",
  /**
   * Awaiting confirmation before it may be believed — either because an agent's
   * write policy requires it, or because it conflicts with an existing memory.
   * Never returned by default recall.
   */
  "pending",
  /** Was active, replaced by a newer version. Kept for history. */
  "superseded",
  /** Deliberately retired. Retrievable only when history is requested. */
  "archived",
] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export const RELATION_KINDS = [
  /** The target fact stopped being true; the source states the new truth. */
  "supersedes",
  /** Same fact, better/more detailed wording. Validity range is unchanged. */
  "refines",
  "contradicts",
  "supports",
  "related_to",
  "derived_from",
] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

export const OBSERVATION_SOURCES = ["user", "agent", "chat", "document", "event", "import"] as const
export type ObservationSourceKind = (typeof OBSERVATION_SOURCES)[number]

export type ObservationStatus = "pending" | "processed" | "failed" | "skipped"

// ---------------------------------------------------------------------------
// Observation — raw experience, append-only
// ---------------------------------------------------------------------------

/**
 * An `Observation` is raw input: what the user or an agent actually said.
 * It is NOT a memory. Observations are kept forever so that a failed or
 * low-quality extraction can always be replayed after a prompt improvement.
 */
export interface Observation {
  id: string
  userId: string
  content: string
  sourceKind: ObservationSourceKind
  /** Which agent produced this, for audit and per-agent write policy. */
  agentId?: string
  /** When the described event happened, if known. Distinct from createdAt. */
  occurredAt: IsoDateTime
  createdAt: IsoDateTime
  status: ObservationStatus
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Memory — an immutable version
// ---------------------------------------------------------------------------

/**
 * A `Memory` is one immutable version of a belief about the user.
 *
 * Rows are never UPDATEd. A change of belief produces a *new* row plus a
 * relation edge, so the full history stays queryable.
 *
 * Two time axes are tracked:
 *  - valid time   (`validFrom` / `validUntil`) — when the fact held in the world
 *  - transaction time (`recordedAt` / `supersededAt`) — when the system believed it
 *
 * `validUntil === undefined` means "still true as far as we know".
 *
 * MUTABILITY RULE — the claim is immutable, the assessment is not:
 *  - Immutable: `type`, `content`, `summary`, `validFrom`, `validUntil`,
 *    `recordedAt`, `originObservationId`. Changing any of these means a NEW row
 *    (plus a relation edge), never an UPDATE.
 *  - Mutable: `confidence`, `importance`, `status` (a projection over relations),
 *    `supersededAt`, `lastSeenAt`, `reinforcedCount`. These are running estimates
 *    about the claim, not the claim itself. Bumping confidence on every
 *    re-observation must not create a new version, or the version chain becomes
 *    useless noise.
 */
export interface Memory {
  id: string
  userId: string
  type: MemoryType
  content: string
  summary?: string
  /**
   * Optional mutual-exclusion slot, e.g. "tech.frontend". When set, Postgres
   * enforces (via a GiST exclusion constraint) that two memories in the same
   * slot can never have overlapping validity.
   */
  slotKey?: string
  confidence: number
  importance: number
  validFrom?: IsoDateTime
  validUntil?: IsoDateTime
  recordedAt: IsoDateTime
  supersededAt?: IsoDateTime
  status: MemoryStatus
  /** Last time this fact was observed again (mutable assessment metadata). */
  lastSeenAt?: IsoDateTime
  /** How many times this fact has been re-observed (mutable assessment metadata). */
  reinforcedCount: number
  /** Provenance: the observation this version was derived from. */
  originObservationId?: string
  agentId?: string
  /** Groups every memory produced by one pipeline run, for eval attribution. */
  extractionRunId?: string
  metadata?: Record<string, unknown>
}

export interface MemoryRelation {
  id: string
  userId: string
  /** The newer / acting memory. */
  fromMemoryId: string
  /** The older / target memory. */
  toMemoryId: string
  kind: RelationKind
  reason?: string
  createdAt: IsoDateTime
}

export interface Entity {
  id: string
  userId: string
  canonicalName: string
  kind: string
  aliases: string[]
  createdAt: IsoDateTime
}

/** A pointer from a memory to one of its entities. */
export interface MemoryEntityLink {
  memoryId: string
  entityId: string
  role?: string
}

export interface MemorySource {
  id: string
  memoryId: string
  observationId?: string
  agentId?: string
  kind: string
  ref?: string
  createdAt: IsoDateTime
}

/** Per-agent write policy. Decided on day one because retrofitting pollutes data. */
export interface AgentPolicy {
  agentId: string
  userId: string
  /** Memory types this agent may create without confirmation. */
  allowedTypes: MemoryType[]
  /** Types that require explicit user confirmation before becoming active. */
  requireConfirmationFor: MemoryType[]
  /** When false, this agent may only read. */
  canWrite: boolean
  createdAt: IsoDateTime
}

/** Observability record for one pipeline execution. */
export interface ExtractionRun {
  id: string
  userId: string
  observationId?: string
  promptVersion: string
  modelId: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  candidatesProduced: number
  memoriesWritten: number
  /**
   * How many extractions had to be re-asked because the model answered in the
   * wrong language. Should be near zero; a rising number means the extraction
   * prompt needs attention.
   */
  languageRetries: number
  createdAt: IsoDateTime
  error?: string
}

// ---------------------------------------------------------------------------
// Filters and results
// ---------------------------------------------------------------------------

export interface MemoryFilter {
  types?: MemoryType[]
  statuses?: MemoryStatus[]
  minConfidence?: number
  minImportance?: number
  /** Restrict to memories linked to at least one of these entity ids. */
  entityIds?: string[]
  /** Restrict to memories derived from these agent ids. */
  agentIds?: string[]
}

export interface WriteOutcome {
  observationId: string
  memories: Memory[]
  relations: MemoryRelation[]
  /** Candidates the extractor proposed vs. what actually got persisted. */
  candidateCount: number
  /** True when the observation was stored but not processed (LLM failure). */
  deferred: boolean
  runId?: string
  error?: string
}

export interface NewObservationInput {
  userId: string
  content: string
  sourceKind?: ObservationSourceKind
  agentId?: string
  occurredAt?: IsoDateTime
  metadata?: Record<string, unknown>
}

export interface RecallQuery {
  userId: string
  query: string
  /** Free-form task hint, e.g. "architecture". Used as a ranking signal. */
  taskType?: string
  /** Entity names or ids to bias retrieval toward. */
  entities?: string[]
  /** Valid time to evaluate the query at. Defaults to now. */
  asOf?: IsoDateTime
  /** Transaction time: "what did we believe then". Defaults to now. */
  believedAt?: IsoDateTime
  limit?: number
  tokenBudget?: number
  mode?: RecallMode
  /** Include superseded versions as historical context. */
  includeHistory?: boolean
  format?: RecallFormat
}

export type RecallMode = "fast" | "smart" | "auto"
export type RecallFormat = "json" | "text"

/** Per-signal score breakdown. Without this, recall quality is undebuggable. */
export interface ScoreBreakdown {
  semantic?: number
  lexical?: number
  entity?: number
  temporal?: number
  importance?: number
  recency?: number
  taskMatch?: number
  conflictRisk?: number
  /**
   * LLM relevance judgement, smart path only.
   *
   * Present for the same reason as the rest of the breakdown: on the smart path
   * this is the largest term after RRF, so a result that looks wrong cannot be
   * diagnosed without it.
   */
  rerank?: number
  rrf: number
  final: number
}

export interface ScoredMemory {
  memory: Memory
  score: number
  breakdown: ScoreBreakdown
  /** Which retrieval routes surfaced this memory, and at what rank. */
  routes: Array<{ route: string; rank: number; rawScore?: number }>
  /** Human-readable reason this memory was included. */
  why: string
}

export interface RecallResult {
  userId: string
  query: string
  memories: ScoredMemory[]
  /** Rendered, token-budgeted context ready to paste into a prompt. */
  context: string
  mode: Exclude<RecallMode, "auto">
  /** Set when `auto` escalated, so the decision is visible. */
  escalated: boolean
  diagnostics: {
    candidatesConsidered: number
    routesUsed: string[]
    conflictsFiltered: number
    latencyMs: number
    estimatedTokens: number
    /** Deliberately first-class: returning nothing is a valid, correct answer. */
    returnedEmpty: boolean
  }
}

export interface RecallAudit {
  result: RecallResult
  /** Every candidate with its rank, including ones that were filtered out. */
  considered: Array<{ memoryId: string; score: number; kept: boolean; reason: string }>
}
