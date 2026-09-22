import { createHash } from "node:crypto"
import type {
  EmbeddingPort,
  GenerateObjectRequest,
  GenerateObjectResult,
  LlmPort,
  Memory,
} from "@memory-palace/core"
import { createLlmBundle, MockEmbedding, RuleBasedLlm } from "@memory-palace/llm"
import type { Runtime } from "@memory-palace/runtime"
import { createRuntime } from "@memory-palace/runtime"
import type { Config } from "@memory-palace/shared"
import { loadConfig, newId } from "@memory-palace/shared"
import { truncateAll } from "@memory-palace/test-support"
import type { DecisionKind, EvolutionCase, ExpectMemory, RecallCase } from "./datasets/index.js"
import { dataset } from "./datasets/index.js"
import type { ProducedMemory } from "./metrics.js"
import {
  countViolations,
  matchSets,
  mean,
  precisionAtK,
  precisionRecallF1,
  recallAtK,
} from "./metrics.js"
import { NullEmbedding, NullLlm, OracleLlm } from "./oracle.js"

/**
 * The evaluation harness.
 *
 * Three suites, one report. The point is not the absolute score — it is that a
 * prompt or threshold change can be measured instead of guessed at, which is why
 * this had to exist before the formation pipeline was written rather than after.
 */

export type ProviderKind = "mock" | "oracle" | "null" | "real"

export interface EvalOptions {
  provider: ProviderKind
  /**
   * Embedding provider, varied independently of the language model.
   *
   * These are separate quality axes: swapping the LLM improves extraction and
   * adjudication, swapping the embedder improves recall. Being able to vary one
   * at a time is what makes "how much did that change help?" answerable instead
   * of a guess.
   */
  embedding?: "mock" | "real"
  /** Only run these case ids (substring match). */
  filter?: string
  /**
   * Which recall path to measure. `auto` is the default an agent gets when it
   * passes no mode, so it has to be measurable rather than assumed.
   */
  recallMode?: "fast" | "smart" | "auto"
  label?: string
}

export interface ExtractionCaseResult {
  id: string
  note: string
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
  violations: number
  produced: ProducedMemory[]
  missed: ExpectMemory[]
}

export interface EvolutionCaseResult {
  id: string
  note: string
  expected: DecisionKind
  actual: DecisionKind | "UNKNOWN"
  correct: boolean
  created: ProducedMemory[]
  superseded: string[]
}

export interface RecallCaseResult {
  id: string
  note: string
  precisionAtK: number
  recallAtK: number
  returnedCount: number
  expectedCount: number
  expectEmpty: boolean
  wasEmpty: boolean
  negativeCorrect: boolean
  forbiddenViolations: string[]
  returned: string[]
  /** The fragments the case required, so a miss can say WHAT was missed. */
  expected: string[]
}

/** Mean and range over repeated runs. */
export interface MetricRange {
  mean: number
  min: number
  max: number
  runs: number
}

export interface EvalReport {
  label: string
  provider: ProviderKind
  /**
   * Which recall path produced the recall numbers.
   *
   * Recorded because the two paths are not comparable: `smart` may rescue
   * candidates below the semantic floor when the reranker confirms them, so a
   * fast run and a smart run answer different questions.
   */
  recallMode: "fast" | "smart" | "auto"
  startedAt: string
  durationMs: number
  extraction: {
    cases: ExtractionCaseResult[]
    precision: number
    recall: number
    f1: number
    totalViolations: number
  }
  evolution: {
    cases: EvolutionCaseResult[]
    accuracy: number
    confusion: Record<string, Record<string, number>>
  }
  recall: {
    cases: RecallCaseResult[]
    precisionAtK: number
    recallAtK: number
    negativeAccuracy: number
    forbiddenViolationRate: number
  }
  usage: {
    llmCalls: number
    inputTokens: number
    outputTokens: number
    costUsd: number
  }
  /** Everything a later comparison needs to know whether the runs are comparable. */
  fingerprint: {
    extractionPrompt: string
    adjudicationPrompt: string
    modelId: string
    /**
     * Hash of the golden dataset.
     *
     * Without it, editing a case and re-running looks exactly like a code
     * change that moved the score — and the honest reading of such a
     * "regression" is impossible after the fact.
     */
    dataset: string
    /**
     * Which embedding model produced these numbers.
     *
     * The embedder is a first-class quality variable — it decides recall — so a
     * report that does not name it cannot be attributed. Its absence is how a
     * baseline came to be published as "bge-m3" while the machine was actually
     * running a different model with a different vector width.
     */
    embeddingModel: string
    embeddingDim: number
    /** Which recall path was measured. Fast, smart and auto answer differently. */
    recallMode: "fast" | "smart" | "auto"
    /**
     * The recall thresholds in force, recorded in full.
     *
     * Every one of these changes what the suite returns, so two runs at
     * different settings are answering different questions. This is snapshotted
     * from the loaded config rather than listing fields by hand: the last knob
     * added here (`semanticRescueMargin`) moved P@5 from 0.857 to 0.929 on its
     * own, and a hand-maintained list is exactly how a knob escapes the
     * fingerprint and lets a threshold change be reported as an improvement.
     */
    recallThresholds: Config["recall"]
  }
  /**
   * Populated when the same evaluation was repeated.
   *
   * Without this, comparing two single runs treats run-to-run noise as a real
   * change — which happened the first time this comparison was used on a
   * hosted model, and produced a confident but meaningless "regression".
   */
  variability?: {
    extractionF1: MetricRange
    evolutionAccuracy: MetricRange
    recallPrecisionAt5: MetricRange
    recallRecallAt5: MetricRange
    negativeAccuracy: MetricRange
  }
}

/** Wraps any LlmPort to count calls and accumulate cost. */
class CountingLlm implements LlmPort {
  readonly inner: LlmPort
  llmCalls = 0
  inputTokens = 0
  outputTokens = 0
  costUsd = 0

  constructor(inner: LlmPort) {
    this.inner = inner
  }

  get defaultModelId(): string {
    return this.inner.defaultModelId
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    const result = await this.inner.generateObject(req)
    this.llmCalls += 1
    this.inputTokens += result.usage.inputTokens
    this.outputTokens += result.usage.outputTokens
    this.costUsd += result.usage.costUsd
    return result
  }
}

function makeProviders(
  kind: ProviderKind,
  config: ReturnType<typeof loadConfig>,
  embeddingChoice: "mock" | "real",
): { llm: LlmPort; embeddings: EmbeddingPort; oracle?: OracleLlm; counter: CountingLlm } {
  // `real` embeddings come from whatever MP_EMBEDDING_PROVIDER names, so the
  // harness never has to know which model is in use.
  const realEmbeddings = (): EmbeddingPort => createLlmBundle(config, { noCache: true }).embeddings

  switch (kind) {
    case "oracle": {
      const oracle = new OracleLlm()
      const counter = new CountingLlm(oracle)
      return {
        llm: counter,
        embeddings:
          embeddingChoice === "real" ? realEmbeddings() : new MockEmbedding(config.embedding.dim),
        oracle,
        counter,
      }
    }
    case "null": {
      const counter = new CountingLlm(new NullLlm())
      return { llm: counter, embeddings: new NullEmbedding(config.embedding.dim), counter }
    }
    case "mock": {
      const counter = new CountingLlm(new RuleBasedLlm())
      return {
        llm: counter,
        embeddings:
          embeddingChoice === "real" ? realEmbeddings() : new MockEmbedding(config.embedding.dim),
        counter,
      }
    }
    case "real": {
      const bundle = createLlmBundle(config, { noCache: true })
      const counter = new CountingLlm(bundle.llm)
      // Honour the embedding axis here too: without this, `--provider real
      // --embedding mock` silently used the real embedder and the isolation the
      // flag promises never happened.
      return {
        llm: counter,
        embeddings:
          embeddingChoice === "real" ? bundle.embeddings : new MockEmbedding(config.embedding.dim),
        counter,
      }
    }
  }
}

/**
 * Stable short hash of the golden dataset.
 *
 * Derived from the dataset's own content, so it changes when a case changes and
 * never because of formatting. Used to refuse comparisons across a dataset edit.
 */
export function datasetFingerprint(): string {
  return createHash("sha256").update(JSON.stringify(dataset)).digest("hex").slice(0, 12)
}

export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const startedAt = new Date()
  const userId = "eval-user"

  const config = loadConfig({
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://mp@127.0.0.1:55432/memory_palace",
    userId,
    logLevel: "error",
  })

  // Default: a real provider implies real embeddings; everything else stays offline.
  const embeddingChoice = options.embedding ?? (options.provider === "real" ? "real" : "mock")
  const providers = makeProviders(options.provider, config, embeddingChoice)

  // One runtime, one connection pool, with the eval's providers injected.
  const runtime = createRuntime({
    // A response cache would make repeat runs free but would also hide the
    // effect of a prompt change, so the harness always measures a cold run.
    noCache: true,
    config: { databaseUrl: config.databaseUrl, userId, logLevel: "error" },
    llm: providers.llm,
    embeddings: providers.embeddings,
  })

  const palace = runtime.palace
  const store = runtime.storage.store
  const db = runtime.storage.db

  const selected = <T extends { id: string }>(cases: T[]): T[] =>
    options.filter ? cases.filter((c) => c.id.includes(options.filter!)) : cases

  const extractionCases = selected(dataset.extraction)
  const evolutionCases = selected(dataset.evolution)
  const recallCases = selected(dataset.recall)

  const extractionResults: ExtractionCaseResult[] = []
  const evolutionResults: EvolutionCaseResult[] = []
  const recallResults: RecallCaseResult[] = []

  try {
    // ---------------- extraction ------------------------------------------
    for (const c of extractionCases) {
      await truncateAll(db)
      providers.oracle?.setDecision(null)
      providers.oracle?.setExtractionCandidates(
        c.expect.map((e) => ({
          // Prefer the single type, else the first acceptable alternative, so a
          // dataset that lists several valid types still calibrates to 1.0.
          type: e.type ?? e.types?.[0] ?? "fact",
          content: e.contentContains.join(" "),
        })),
      )
      await palace.remember({
        userId,
        content: c.observation,
        occurredAt: c.occurredAt,
        sourceKind: "user",
      })

      const memories = await store.listMemories(userId, {
        statuses: ["active", "pending", "superseded"],
      })
      const produced: ProducedMemory[] = memories.map((m) => ({ type: m.type, content: m.content }))

      const { tp, fp, fn } = matchSets(produced, c.expect)
      const matched = new Set<number>()
      for (const [i, e] of c.expect.entries()) {
        if (
          produced.some(
            (m) =>
              (e.type ? m.type === e.type : true) &&
              e.contentContains.every((f) => m.content.includes(f)),
          )
        ) {
          matched.add(i)
        }
      }
      const missed = c.expect.filter((_, i) => !matched.has(i))
      const { precision, recall, f1 } = precisionRecallF1(tp, fp, fn)
      const violations = countViolations(produced, c.mustNotExtract ?? [])

      extractionResults.push({
        id: c.id,
        note: c.note,
        tp,
        fp,
        fn,
        precision,
        recall,
        f1,
        violations,
        produced,
        missed,
      })
    }

    // ---------------- evolution -------------------------------------------
    for (const c of evolutionCases) {
      await truncateAll(db)
      providers.oracle?.setExtractionCandidates([c.candidate])
      providers.oracle?.setDecision(c.expectDecision)
      const seeded = await seedMemories(store, userId, c, providers.embeddings)
      const before = new Map(seeded.map((m) => [m.id, m]))

      const outcome = await palace.remember({ userId, content: c.observation, sourceKind: "user" })
      const after = await store.listMemories(userId, {})
      const actual = inferDecision(
        before,
        after,
        outcome.relations.map((r) => r.kind),
      )

      const accepted = [c.expectDecision, ...(c.acceptDecisions ?? [])]
      evolutionResults.push({
        id: c.id,
        note: c.note,
        expected: c.expectDecision,
        actual,
        correct: accepted.includes(actual),
        created: outcome.memories.map((m) => ({ type: m.type, content: m.content })),
        superseded: after.filter((m) => m.status === "superseded").map((m) => m.content),
      })
    }

    // ---------------- recall ----------------------------------------------
    for (const c of recallCases) {
      await truncateAll(db)
      providers.oracle?.setDecision(null)
      await seedRecallMemories(store, userId, c, providers.embeddings)

      const result = await palace.recall({
        userId,
        query: c.query,
        mode: options.recallMode ?? "fast",
        asOf: c.asOf,
        includeHistory: c.includeHistory ?? false,
        format: "json",
        limit: 10,
      })

      const returned = result.memories.map((m) => m.memory.content)
      const forbiddenViolations = returned.filter((content) =>
        (c.forbidden ?? []).some((f) => content.includes(f)),
      )
      const wasEmpty = returned.length === 0
      const expectEmpty = c.expectEmpty ?? c.expected.length === 0

      recallResults.push({
        id: c.id,
        note: c.note,
        precisionAtK: precisionAtK(returned, c.expected, 5),
        recallAtK: recallAtK(returned, c.expected, 5),
        returnedCount: returned.length,
        expectedCount: c.expected.length,
        expectEmpty,
        wasEmpty,
        negativeCorrect: expectEmpty ? wasEmpty : true,
        forbiddenViolations,
        returned,
        expected: c.expected,
      })
    }
  } finally {
    await runtime.close()
  }

  // ---------------- aggregate ---------------------------------------------
  const totals = extractionResults.reduce(
    (acc, r) => ({ tp: acc.tp + r.tp, fp: acc.fp + r.fp, fn: acc.fn + r.fn }),
    { tp: 0, fp: 0, fn: 0 },
  )
  const extractionAgg = precisionRecallF1(totals.tp, totals.fp, totals.fn)

  const confusion: Record<string, Record<string, number>> = {}
  for (const r of evolutionResults) {
    confusion[r.expected] ??= {}
    confusion[r.expected]![r.actual] = (confusion[r.expected]![r.actual] ?? 0) + 1
  }

  const negativeCases = recallResults.filter((r) => r.expectEmpty)

  return {
    label: options.label ?? `${options.provider}${embeddingChoice === "real" ? "+real-embed" : ""}`,
    provider: options.provider,
    recallMode: options.recallMode ?? "fast",
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    extraction: {
      cases: extractionResults,
      precision: extractionAgg.precision,
      recall: extractionAgg.recall,
      f1: extractionAgg.f1,
      totalViolations: extractionResults.reduce((a, r) => a + r.violations, 0),
    },
    evolution: {
      cases: evolutionResults,
      accuracy: mean(evolutionResults.map((r) => (r.correct ? 1 : 0))),
      confusion,
    },
    recall: {
      cases: recallResults,
      precisionAtK: mean(recallResults.map((r) => r.precisionAtK)),
      recallAtK: mean(recallResults.map((r) => r.recallAtK)),
      negativeAccuracy:
        negativeCases.length === 0
          ? 1
          : mean(negativeCases.map((r) => (r.negativeCorrect ? 1 : 0))),
      forbiddenViolationRate:
        recallResults.length === 0
          ? 0
          : recallResults.filter((r) => r.forbiddenViolations.length > 0).length /
            recallResults.length,
    },
    usage: {
      llmCalls: providers.counter.llmCalls,
      inputTokens: providers.counter.inputTokens,
      outputTokens: providers.counter.outputTokens,
      costUsd: providers.counter.costUsd,
    },
    fingerprint: {
      extractionPrompt: "extraction-v1",
      adjudicationPrompt: "adjudication-v1",
      modelId: providers.counter.defaultModelId,
      dataset: datasetFingerprint(),
      embeddingModel: providers.embeddings.modelId,
      embeddingDim: providers.embeddings.dim,
      recallMode: options.recallMode ?? "fast",
      recallThresholds: { ...config.recall },
    },
  }
}

/**
 * Seed memories the way the pipeline would.
 *
 * Crucially this includes the embedding: a memory written without one is
 * invisible to the semantic route, so seeding rows directly would test a system
 * that never exists in production and would understate recall.
 */
async function seedMemories(
  store: Runtime["storage"]["store"],
  userId: string,
  c: EvolutionCase,
  embeddings: EmbeddingPort,
): Promise<Memory[]> {
  const seeded: Memory[] = []
  for (const [i, e] of c.existing.entries()) {
    const memory: Memory = {
      id: newId("mem"),
      userId,
      type: e.type,
      content: e.content,
      confidence: 0.9,
      importance: 0.7,
      validFrom: e.validFrom ?? "2026-01-01T00:00:00.000Z",
      recordedAt: `2026-0${i + 1}-01T00:00:00.000Z`,
      status: "active",
      reinforcedCount: 0,
    }
    await store.insertMemory(memory)
    await embedMemory(store, userId, memory, embeddings)
    seeded.push(memory)
  }
  return seeded
}

/** Attach an embedding, mirroring what the persistence stage does. */
async function embedMemory(
  store: Runtime["storage"]["store"],
  userId: string,
  memory: Memory,
  embeddings: EmbeddingPort,
): Promise<void> {
  const [vector] = await embeddings.embed([`${memory.type}\n${memory.content}`])
  if (!vector) return
  await store.upsertEmbedding({
    userId,
    memoryId: memory.id,
    model: embeddings.modelId,
    dim: embeddings.dim,
    vector,
  })
}

async function seedRecallMemories(
  store: Runtime["storage"]["store"],
  userId: string,
  c: RecallCase,
  embeddings: EmbeddingPort,
): Promise<void> {
  for (const [i, e] of c.memories.entries()) {
    const memory: Memory = {
      id: newId("mem"),
      userId,
      type: e.type,
      content: e.content,
      confidence: 0.92,
      importance: 0.75,
      validFrom: e.occurredAt ?? "2026-01-01T00:00:00.000Z",
      validUntil: e.validUntil,
      recordedAt: e.occurredAt ?? `2026-0${i + 1}-01T00:00:00.000Z`,
      supersededAt: e.status === "superseded" ? "2026-06-01T00:00:00.000Z" : undefined,
      status: e.status ?? "active",
      reinforcedCount: 0,
    }
    await store.insertMemory(memory)
    await embedMemory(store, userId, memory, embeddings)
  }
}

/**
 * Read the decision the pipeline actually took off the resulting state.
 *
 * The pipeline does not report its decision directly — it reports its effects,
 * which is the honest thing to measure. COEXIST is observationally identical to
 * NEW (a new memory is created and nothing is replaced), so the two are
 * indistinguishable here; the dataset therefore avoids asserting COEXIST.
 */
function inferDecision(
  before: Map<string, Memory>,
  after: Memory[],
  relationKinds: string[],
): DecisionKind | "UNKNOWN" {
  if (relationKinds.includes("supersedes")) return "SUPERSEDE"
  if (relationKinds.includes("refines")) return "REFINE"

  const created = after.filter((m) => !before.has(m.id))
  if (created.some((m) => m.status === "pending")) return "CONTRADICT"
  if (created.length > 0) return "NEW"

  const reinforced = after.some((m) => {
    const original = before.get(m.id)
    return original !== undefined && m.reinforcedCount > original.reinforcedCount
  })
  if (reinforced) return "DUPLICATE"

  // Nothing was created, nothing reinforced, no relation: the pipeline judged
  // the input to contain nothing worth storing.
  return "UNKNOWN"
}
