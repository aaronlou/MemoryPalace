import type { Clock, Logger } from "@memory-palace/shared"
import {
  allCandidatesDrifted,
  chunkText,
  detectScript,
  languageName,
  newId,
  normalizeWhitespace,
} from "@memory-palace/shared"
import { entityIdsFor, resolveEntities } from "../entity/resolve.js"
import { AdjudicationOutput, ExtractionOutput } from "../memory/decisions.js"
import type { Entity, Memory, MemoryType, Observation } from "../memory/types.js"
import {
  ADJUDICATION_PROMPT_VERSION,
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_PROMPT_VERSION,
  embeddingText,
} from "../policies.js"
import type { EmbeddingPort, LlmPort, TokenUsage } from "../ports/llm.js"
import type { MemorySearch, MemoryStore } from "../ports/storage.js"
import { adjudicationPrompt, extractionPrompt, instructionsFor, keepKnownIds } from "./prompt.js"

/** How many already-known entity names to show the extractor as context. */
const KNOWN_ENTITY_LIMIT = 60
/** Neighbours pulled per retrieval route when looking for duplicates/conflicts. */
const NEIGHBOUR_LIMIT = 6
/** Long inputs are chunked; each chunk is extracted independently. */
const CHUNK_CHARS = 4000
const CHUNK_OVERLAP = 200

export interface CandidateMemory {
  type: MemoryType
  content: string
  summary?: string
  entities: Array<{ name: string; kind: string }>
  confidence: number
  importance: number
  validFrom?: string
  reasoning: string
}

/**
 * A single write the formation stage has decided on, to be applied atomically
 * by the evolution stage.
 *
 * Formation decides *what is worth recording*; evolution decides *how the record
 * changes*. Keeping them separate means the tricky transactional part can be
 * tested without any LLM in the loop.
 */
export type PlannedAction =
  | { kind: "create"; memory: Memory; entityIds: string[] }
  /** Same fact, better wording. Validity range unchanged. */
  | { kind: "refine"; memory: Memory; targetId: string; entityIds: string[]; reason: string }
  | {
      kind: "reinforce"
      memoryId: string
      confidence: number
      importance?: number
      reason: string
    }
  | {
      kind: "supersede"
      memory: Memory
      targetIds: string[]
      entityIds: string[]
      effectiveFrom: string
      reason: string
    }
  /** Unresolvable conflict: both sides go to the confirmation queue. */
  | { kind: "dispute"; memory: Memory; targetIds: string[]; entityIds: string[]; reason: string }

export interface FormationPlan {
  observation: Observation
  actions: PlannedAction[]
  candidateCount: number
  runId: string
  usage: TokenUsage
  modelId: string
  promptVersion: string
  latencyMs: number
  /** How many chunks had to be re-asked for a language mismatch. */
  languageRetries: number
  /** True when the observation was stored but could not be processed. */
  deferred: boolean
  error?: string
}

export interface FormationDeps {
  store: MemoryStore
  search: MemorySearch
  llm: LlmPort
  embeddings: EmbeddingPort
  clock: Clock
  logger: Logger
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 }
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  }
}

/**
 * Turns raw observations into a plan of memory writes.
 *
 * Nothing here writes to the database — the returned plan is applied by
 * `applyFormationPlan`. That makes every decision inspectable in tests and in
 * the eval suite.
 */
export class FormationPipeline {
  private readonly store: MemoryStore
  private readonly search: MemorySearch
  private readonly llm: LlmPort
  private readonly embeddings: EmbeddingPort
  private readonly clock: Clock
  private readonly logger: Logger

  constructor(deps: FormationDeps) {
    this.store = deps.store
    this.search = deps.search
    this.llm = deps.llm
    this.embeddings = deps.embeddings
    this.clock = deps.clock
    this.logger = deps.logger
  }

  async plan(observation: Observation): Promise<FormationPlan> {
    const started = Date.now()
    const runId = newId("run")
    const base: Pick<FormationPlan, "observation" | "runId" | "modelId" | "promptVersion"> = {
      observation,
      runId,
      modelId: this.llm.defaultModelId,
      promptVersion: `${EXTRACTION_PROMPT_VERSION}+${ADJUDICATION_PROMPT_VERSION}`,
    }

    let usage = emptyUsage()
    try {
      const knownEntities = await this.store.listEntities(observation.userId, KNOWN_ENTITY_LIMIT)
      const candidates = await this.extract(observation, knownEntities)
      usage = candidates.usage

      if (candidates.items.length === 0) {
        return {
          ...base,
          actions: [],
          candidateCount: 0,
          usage,
          latencyMs: Date.now() - started,
          languageRetries: candidates.languageRetries,
          deferred: false,
        }
      }

      const { actions, adjudicationUsage } = await this.planActions(observation, candidates.items)
      usage = addUsage(usage, adjudicationUsage)

      return {
        ...base,
        actions,
        candidateCount: candidates.items.length,
        usage,
        latencyMs: Date.now() - started,
        languageRetries: candidates.languageRetries,
        deferred: false,
      }
    } catch (error) {
      // A failed extraction must never lose the user's input. The observation is
      // already persisted; it stays replayable and is marked for retry.
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error("formation failed", { observationId: observation.id, error: message })
      await this.store.setObservationStatus(observation.userId, observation.id, "failed")
      return {
        ...base,
        actions: [],
        candidateCount: 0,
        usage,
        latencyMs: Date.now() - started,
        languageRetries: 0,
        deferred: true,
        error: message,
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 1+2: extraction and classification in one call
  // -------------------------------------------------------------------------

  private async extract(
    observation: Observation,
    knownEntities: Entity[],
  ): Promise<{ items: CandidateMemory[]; usage: TokenUsage; languageRetries: number }> {
    const chunks = chunkText(observation.content, CHUNK_CHARS, CHUNK_OVERLAP)
    const items: CandidateMemory[] = []
    let usage = emptyUsage()
    let languageRetries = 0

    for (const [index, chunk] of chunks.entries()) {
      const prompt = extractionPrompt({
        content: chunk,
        occurredAt: observation.occurredAt,
        knownEntities: knownEntities.map((e) => e.canonicalName),
        sourceKind: observation.sourceKind,
      })

      const call = (promptText: string, cacheKey: string) =>
        this.llm.generateObject({
          schema: ExtractionOutput,
          schemaName: "MemoryExtraction",
          instructions: EXTRACTION_INSTRUCTIONS,
          prompt: promptText,
          temperature: 0,
          cacheKey,
        })

      let result = await call(prompt, `extract:${observation.id}:${index}`)
      usage = addUsage(usage, result.usage)
      let extracted = this.toCandidates(result.value)

      // A model occasionally answers in the wrong language. Retry once with the
      // language named explicitly rather than storing a memory that the user's
      // own queries cannot find.
      if (
        allCandidatesDrifted(
          chunk,
          extracted.map((c) => c.content),
        )
      ) {
        const script = detectScript(chunk)
        const retry = await call(
          `${prompt}\n\nIMPORTANT: Write every memory in ${languageName(script, chunk)}, ` +
            `the same language as the observation above. Do not translate it.`,
          `extract:${observation.id}:${index}:lang`,
        )
        const retried = this.toCandidates(retry.value)
        // Keep the retry only if it actually fixed the mismatch; otherwise the
        // original answer is no worse and we have not paid for nothing.
        if (
          !allCandidatesDrifted(
            chunk,
            retried.map((c) => c.content),
          )
        ) {
          result = retry
          extracted = retried
          languageRetries += 1
        }
        usage = addUsage(usage, retry.usage)
      }

      items.push(...extracted)
    }

    return { items: this.dedupCandidates(items), usage, languageRetries }
  }

  /** Map a provider response onto our internal candidate shape. */
  private toCandidates(value: { candidates: ExtractionOutput["candidates"] }): CandidateMemory[] {
    const out: CandidateMemory[] = []
    for (const candidate of value.candidates) {
      const content = normalizeWhitespace(candidate.content)
      if (content === "") continue
      out.push({
        type: candidate.type,
        content,
        summary: candidate.summary ? normalizeWhitespace(candidate.summary) : undefined,
        entities: candidate.entities.map((e) => ({ name: e.name, kind: e.kind })),
        confidence: candidate.confidence,
        importance: candidate.importance,
        validFrom: candidate.validFrom ?? undefined,
        reasoning: candidate.reasoning,
      })
    }
    return out
  }

  /** Drop exact-duplicate candidates produced by overlapping chunks. */
  private dedupCandidates(items: CandidateMemory[]): CandidateMemory[] {
    const seen = new Set<string>()
    const out: CandidateMemory[] = []
    for (const item of items) {
      const key = `${item.type}::${item.content.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Step 3-6: neighbour lookup and single-call adjudication
  // -------------------------------------------------------------------------

  private async planActions(
    observation: Observation,
    candidates: CandidateMemory[],
  ): Promise<{ actions: PlannedAction[]; adjudicationUsage: TokenUsage }> {
    const actions: PlannedAction[] = []
    let usage = emptyUsage()
    const now = this.clock.now().toISOString()

    const resolved = await resolveEntities(
      this.store,
      observation.userId,
      candidates.flatMap((c) => c.entities),
      this.clock,
    )

    for (const candidate of candidates) {
      const entityIds = entityIdsFor(
        resolved,
        candidate.entities.map((e) => e.name),
      )

      const neighbours = await this.findNeighbours(observation.userId, candidate)

      let decision: AdjudicationOutput | null = null
      if (neighbours.length > 0) {
        const result = await this.llm.generateObject({
          schema: AdjudicationOutput,
          schemaName: "MemoryAdjudication",
          instructions: instructionsFor("adjudication"),
          prompt: adjudicationPrompt({
            candidate: {
              type: candidate.type,
              content: candidate.content,
              validFrom: candidate.validFrom,
              confidence: candidate.confidence,
            },
            existing: neighbours,
            today: now,
          }),
          temperature: 0,
          cacheKey: `adjudicate:${observation.id}:${candidate.type}:${candidate.content}`,
        })
        usage = addUsage(usage, result.usage)
        decision = this.sanitiseDecision(result.value, neighbours)
      }

      actions.push(this.toAction(candidate, decision, entityIds, observation, neighbours, now))
    }

    return { actions, adjudicationUsage: usage }
  }

  /**
   * Find memories that might already cover, or conflict with, this candidate.
   *
   * Both routes are used and unioned. Semantic search fails to recall near-
   * duplicates when the embedding provider is a stub, and lexical search fails
   * on paraphrase — running both is cheap insurance and the union is small.
   */
  private async findNeighbours(userId: string, candidate: CandidateMemory): Promise<Memory[]> {
    const options = {
      limit: NEIGHBOUR_LIMIT,
      // Deliberately NOT filtered by memory type.
      //
      // The original reasoning was that "a goal never supersedes a preference",
      // so restricting to the same type would keep adjudication precise. The
      // live system disproved it: "I use Vue" is recorded as a `fact` while
      // "I've switched to React" extracts as a `decision`. Same subject,
      // different type — so the change never reached adjudication and the
      // system ended up holding both, contradicting itself.
      //
      // Type is a property of how a statement was phrased, not of what it is
      // about. The model sees each neighbour's type in the prompt and is told
      // which decisions may cross types.
      filter: { statuses: ["active" as const] },
    }

    const [vector] = await this.embeddings.embed([embeddingText(candidate)])
    const [semanticHits, lexicalHits] = await Promise.all([
      vector ? this.search.semantic(userId, vector, options) : Promise.resolve([]),
      this.search.lexical(userId, candidate.content, options),
    ])

    const ids: string[] = []
    const seen = new Set<string>()
    for (const hit of [...semanticHits, ...lexicalHits]) {
      if (seen.has(hit.memoryId)) continue
      seen.add(hit.memoryId)
      ids.push(hit.memoryId)
    }
    if (ids.length === 0) return []

    const memories = await this.store.getMemories(userId, ids)
    return memories.filter((m) => m.status === "active")
  }

  /** Never trust the model to reference ids that were not in the prompt. */
  private sanitiseDecision(raw: AdjudicationOutput, neighbours: Memory[]): AdjudicationOutput {
    return { ...raw, targetMemoryIds: keepKnownIds(raw.targetMemoryIds, neighbours) }
  }

  private toAction(
    candidate: CandidateMemory,
    decision: AdjudicationOutput | null,
    entityIds: string[],
    observation: Observation,
    neighbours: Memory[],
    now: string,
  ): PlannedAction {
    const byId = new Map(neighbours.map((m) => [m.id, m]))

    const makeMemory = (
      content: string,
      opts: { type?: MemoryType; validFrom?: string; summary?: string } = {},
    ): Memory => ({
      id: newId("mem"),
      userId: observation.userId,
      type: opts.type ?? candidate.type,
      content,
      summary: opts.summary ?? candidate.summary,
      confidence: candidate.confidence,
      importance: candidate.importance,
      // Default validity start is when we learned it. Without a validFrom the
      // interval containment test is NULL and the memory becomes unretrievable
      // by every "what is true at time T" query.
      validFrom: opts.validFrom ?? candidate.validFrom ?? observation.occurredAt ?? now,
      recordedAt: now,
      status: "active",
      reinforcedCount: 0,
      originObservationId: observation.id,
      agentId: observation.agentId,
    })

    if (decision === null) {
      return { kind: "create", memory: makeMemory(candidate.content), entityIds }
    }

    switch (decision.decision) {
      case "DUPLICATE": {
        const target = decision.targetMemoryIds[0]
        const existing = target ? byId.get(target) : undefined
        if (!existing) {
          return { kind: "create", memory: makeMemory(candidate.content), entityIds }
        }
        // Re-observation is evidence, so confidence may rise — but never exceed
        // the ceiling, and never drop below what we already believed.
        return {
          kind: "reinforce",
          memoryId: existing.id,
          confidence: Math.min(
            0.98,
            Math.max(existing.confidence, candidate.confidence) + decision.confidenceDelta,
          ),
          importance: Math.max(existing.importance, candidate.importance),
          reason: decision.reason,
        }
      }

      case "REFINE": {
        const target = decision.targetMemoryIds[0]
        const original = target ? byId.get(target) : undefined
        const merged = decision.mergedContent ? normalizeWhitespace(decision.mergedContent) : ""
        if (!original || merged === "") {
          return { kind: "create", memory: makeMemory(candidate.content), entityIds }
        }
        // A refinement describes the same fact over the same period, so it
        // inherits the original's validity start rather than resetting it.
        //
        // It inherits the TYPE too, and that is not cosmetic. A type is a guess
        // made while reading one particular phrasing, so re-reading the same fact
        // with different words can type it differently — measured: "我最近开始
        // 系统学习 Effect-TS" extracts as `goal` while "我最近在系统学习
        // Effect-TS" extracts as `fact`, and the demo's own repeat step used to
        // flip a user's goal into a fact. The type decides which group a memory
        // appears under in assembled context *and* which write policy applies to
        // it (`decision` needs confirmation, `fact` does not), so letting it drift
        // on a re-wording moves a memory between categories without anything about
        // the user changing. ADR-0004's lesson cuts this way: the type describes
        // how the statement was phrased, so a RE-phrasing must not move it.
        //
        // SUPERSEDE is the opposite case and keeps the candidate's type: a change
        // of state can legitimately change the category ("I use Vue" is a fact,
        // "I switched to React" is a decision).
        return {
          kind: "refine",
          memory: makeMemory(merged, {
            type: original.type,
            validFrom: original.validFrom,
            summary: original.summary,
          }),
          targetId: original.id,
          entityIds,
          reason: decision.reason,
        }
      }

      case "SUPERSEDE": {
        const targets = decision.targetMemoryIds
          .map((id) => byId.get(id))
          .filter((m): m is Memory => m !== undefined)
        if (targets.length === 0) {
          return { kind: "create", memory: makeMemory(candidate.content), entityIds }
        }
        // When the change took effect:
        //  - an explicit date wins;
        //  - otherwise it happened NOW, at the moment we were told;
        //  - and it can never precede the state it replaces, or the two validity
        //    intervals would invert.
        //
        // Falling back to `earliest` here would be wrong and is a subtle trap:
        // it collapses the predecessor's interval to zero length, silently
        // erasing the period during which the old fact was true.
        const earliest = targets
          .map((m) => m.validFrom)
          .filter((v): v is string => v !== undefined)
          .sort()[0]
        let effectiveFrom = decision.effectiveFrom ?? candidate.validFrom ?? now
        if (earliest && new Date(effectiveFrom) < new Date(earliest)) effectiveFrom = earliest

        return {
          kind: "supersede",
          memory: makeMemory(candidate.content, { validFrom: effectiveFrom }),
          targetIds: targets.map((m) => m.id),
          entityIds,
          effectiveFrom,
          reason: decision.reason,
        }
      }

      case "CONTRADICT": {
        const targets = decision.targetMemoryIds.filter((id) => byId.has(id))
        return {
          kind: "dispute",
          memory: makeMemory(candidate.content),
          targetIds: targets,
          entityIds,
          reason: decision.reason,
        }
      }

      default:
        // COEXIST and NEW both mean "record it alongside what is already known".
        return { kind: "create", memory: makeMemory(candidate.content), entityIds }
    }
  }
}
