import { createHash } from "node:crypto"
import type {
  EmbeddingPort,
  GenerateObjectRequest,
  GenerateObjectResult,
  LlmPort,
  TokenUsage,
} from "@memory-palace/core"
import { extractTagged } from "@memory-palace/shared"

/**
 * A deterministic, dependency-free LLM stand-in.
 *
 * Why this exists rather than mocks in each test:
 *  - the whole pipeline, the MCP server and the eval suite must run with no API
 *    key and no network, or they simply will not be run often enough to be useful
 *  - it gives the eval suite a *baseline*: "the crude rule-based extractor
 *    scores X" is a number every real prompt must beat, which is far more
 *    informative than "0 tests failing"
 *
 * It is intentionally a real (if crude) implementation, not a stub returning
 * canned data. It parses the same prompt text the real providers receive, so if
 * the prompt format changes it breaks loudly — which is what we want.
 */

/** Crude token cost estimate so mock runs still exercise the cost plumbing. */
function estimateUsage(prompt: string, output: string): TokenUsage {
  const inputTokens = Math.ceil(prompt.length / 4)
  const outputTokens = Math.ceil(output.length / 4)
  return { inputTokens, outputTokens, costUsd: 0 }
}

// ---------------------------------------------------------------------------
// Rule tables
// ---------------------------------------------------------------------------

interface TypeRule {
  type: string
  re: RegExp
  importance: number
}

/**
 * Order matters: the first match wins, so more specific intentions must be
 * tested before the generic `fact` fallback.
 */
const TYPE_RULES: TypeRule[] = [
  // Preference first: "希望/以后讲…先…" patterns also contain goal-ish words.
  {
    type: "preference",
    re: /(喜欢|偏好|倾向|更愿意|更想|希望|不要|别|尽量|习惯|以后.{0,12}(讲|说|解释|告诉|用)|下次.{0,12}(讲|说|解释)|先从|prefer|would rather|like (it )?when|don'?t want|instead of)/i,
    importance: 0.82,
  },
  {
    type: "goal",
    re: /((正在|开始|想|打算|计划|准备|希望).{0,8}(学习|研究|做|开发|写|掌握|入门|系统)|目标|learning|studying|plan(ning)? to|goal is|aim to|want to learn)/i,
    importance: 0.85,
  },
  {
    type: "decision",
    re: /(决定|已经?选(择|定|用)|采用|确定(用|使)|拍板|decided|chose|going with|settled on|picked)/i,
    importance: 0.8,
  },
  {
    type: "event",
    re: /(开始(了|做|研究)|启动|昨天|今天|前天|上周|去年|meeting|started (on|the)|began)/i,
    importance: 0.45,
  },
  {
    type: "experience",
    re: /(曾经|以前(做|开发|用)|做过|开发过|写过|用过|参与过|have built|used to|previously worked)/i,
    importance: 0.5,
  },
  {
    type: "relationship",
    re: /(项目|产品|系统).{0,12}(使用|用的?是|基于|依赖).{0,12}(技术|框架|语言)|(uses|depends on|built with|based on)/i,
    importance: 0.6,
  },
  { type: "fact", re: /./, importance: 0.6 },
]

/** Signals that the user is describing a *change* of state, which means SUPERSEDE. */
const CHANGE_CUE =
  /(现在|如今|改为|改成|改|转(到|向|用)|换成|换到|不再|已经?不|又(用|开始|回)|回到|重新(用|使用)|switch(ed|ing)? to|now use|no longer|stopped using|moved (to|from)|back to)/i

/** Questions and hypotheticals are not memories. */
const NOT_MEMORY =
  /[?？]\s*$|(怎么|如何|为什么|是否|能否|可不可以|帮我|请(问|帮)|how (do|does|can|should)|what (is|are)|why (is|does)|can you|could you)/i

/** Transient states that will not matter in a month. */
const TRANSIENT =
  /(现在有?点|暂时|此刻|正在忙|心情|今天(有点|很)|刚刚遇到|报错了|卡住了|right now|at the moment|temporarily)/i

/** Known technology/product names, used for entity extraction. */
const KNOWN_ENTITIES = [
  "Effect-TS",
  "TypeScript",
  "JavaScript",
  "React",
  "Vue",
  "Svelte",
  "Angular",
  "Next.js",
  "Node.js",
  "Deno",
  "Bun",
  "PostgreSQL",
  "MySQL",
  "SQLite",
  "Redis",
  "MongoDB",
  "pgvector",
  "Docker",
  "Kubernetes",
  "Rust",
  "Go",
  "Python",
  "Java",
  "Kotlin",
  "Swift",
  "Elixir",
  "Haskell",
  "Clojure",
  "Zod",
  "Prisma",
  "Drizzle",
  "Hono",
  "Fastify",
  "Express",
  "Tailwind",
  "Vite",
  "Vitest",
  "Jest",
  "Playwright",
  "OpenAI",
  "Anthropic",
  "Claude",
  "DeepSeek",
  "Gemini",
  "LangChain",
  "MCP",
  "Memory Palace",
  "GraphQL",
  "gRPC",
  "REST",
]

const CJK = /[\u4e00-\u9fff]/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split on sentence terminators only.
 *
 * Splitting on every comma looks reasonable and is actively harmful for Chinese:
 * a single statement like "以后讲 TypeScript 的时候，先从整体结构讲，再深入 API"
 * becomes three fragments, none of which is a complete thought — so the
 * memory loses the very nuance it was supposed to preserve.
 */
function splitClauses(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]+|(?<=\.)\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 4)
}

function words(s: string): string[] {
  const latin = s.toLowerCase().match(/[a-z0-9][a-z0-9+.#_-]*/g) ?? []
  const cjkRuns = s.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  const bigrams: string[] = []
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) bigrams.push(run.slice(i, i + 2))
    if (run.length === 1) bigrams.push(run)
  }
  return [...latin, ...bigrams]
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter += 1
  return inter / (sa.size + sb.size - inter)
}

function findEntities(text: string): Array<{ name: string; kind: string }> {
  const found: Array<{ name: string; kind: string }> = []
  const seen = new Set<string>()
  for (const known of KNOWN_ENTITIES) {
    // Match with separators treated as optional so "Effect TS" finds "Effect-TS".
    const pattern = known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-.]/g, "[-. ]?")
    if (new RegExp(pattern, "i").test(text) && !seen.has(known.toLowerCase())) {
      seen.add(known.toLowerCase())
      found.push({ name: known, kind: "technology" })
    }
  }
  return found
}

function confidenceFor(clause: string): number {
  // Explicit first-person statements are the strongest evidence we get.
  if (/(我|我的|我们)/.test(clause) || /\b(i|my|we)\b/i.test(clause)) return 0.92
  return 0.7
}

// ---------------------------------------------------------------------------
// The rule-based provider
// ---------------------------------------------------------------------------

export class RuleBasedLlm implements LlmPort {
  readonly defaultModelId = "mock-rule-based"

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    const raw = this.dispatch(req)
    // Validate through the real schema: the mock must satisfy exactly the same
    // contract as a provider, so a schema change cannot be absorbed silently.
    const value = req.schema.parse(raw) as T
    const usage = estimateUsage(req.prompt, JSON.stringify(raw))
    return {
      value,
      usage,
      modelId: this.defaultModelId,
      promptHash: createHash("sha256").update(req.prompt).digest("hex").slice(0, 16),
      cached: false,
    }
  }

  private dispatch(req: GenerateObjectRequest<unknown>): unknown {
    switch (req.schemaName) {
      case "MemoryExtraction":
        return this.extract(req.prompt)
      case "MemoryAdjudication":
        return this.adjudicate(req.prompt)
      case "QueryUnderstanding":
        return this.understand(req.prompt)
      case "MemoryRerank":
        return this.rerank(req.prompt)
      default:
        throw new Error(`RuleBasedLlm does not implement schema "${req.schemaName}"`)
    }
  }

  private extract(prompt: string): { candidates: unknown[] } {
    const observation = extractTagged(prompt, "observation") ?? prompt
    const clauses = splitClauses(observation)
    const candidates: unknown[] = []
    const seen = new Set<string>()

    for (const clause of clauses) {
      if (NOT_MEMORY.test(clause)) continue
      if (TRANSIENT.test(clause)) continue

      const rule = TYPE_RULES.find((r) => r.re.test(clause))
      if (!rule) continue
      // A bare factual clause with no assertion verb is usually conversational
      // filler; require either a recognised pattern or an entity mention.
      const entities = findEntities(clause)
      if (rule.type === "fact" && entities.length === 0) continue

      const content = this.toThirdPerson(clause)
      const key = `${rule.type}::${content.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)

      candidates.push({
        type: rule.type,
        content,
        summary: content.length > 24 ? `${content.slice(0, 22)}…` : content,
        entities,
        confidence: confidenceFor(clause),
        importance: rule.importance,
        validFrom: null,
        reasoning: `Matched ${rule.type} pattern in the clause.`,
      })
    }

    return { candidates }
  }

  /** Convert a first-person clause into a third-person statement. */
  private toThirdPerson(clause: string): string {
    let out = clause.trim()
    out = out.replace(/^我(们)?/, "用户").replace(/^我的/, "用户的")
    out = out.replace(/\bI\s+/gi, "the user ").replace(/\bmy\b/gi, "the user's")
    out = out.replace(/^用户(的)?(最近|现在|如今)/, "用户")
    return out
  }

  private adjudicate(prompt: string): unknown {
    const candidateBlock = extractTagged(prompt, "candidate") ?? ""
    const existingBlock = extractTagged(prompt, "existing_memories") ?? ""

    const candidateContent = /content:\s*(.+)/.exec(candidateBlock)?.[1]?.trim() ?? ""
    const entries = this.parseExisting(existingBlock)
    if (entries.length === 0) {
      return {
        decision: "NEW",
        targetMemoryIds: [],
        mergedContent: null,
        effectiveFrom: null,
        confidenceDelta: 0,
        reason: "No existing memories to compare against.",
      }
    }

    const candWords = words(candidateContent)
    const candEntities = new Set(findEntities(candidateContent).map((e) => e.name.toLowerCase()))

    let best: { id: string; content: string; score: number } | null = null
    for (const entry of entries) {
      // Sharing a named entity is far stronger evidence of "about the same
      // thing" than bag-of-words overlap, which is noisy for Chinese bigrams.
      const entryEntities = findEntities(entry.content).map((e) => e.name.toLowerCase())
      const sharedEntity = entryEntities.some((e) => candEntities.has(e))
      const lexical = jaccard(candWords, words(entry.content))
      const score = sharedEntity ? Math.max(lexical, 0.35) : lexical
      if (!best || score > best.score) best = { ...entry, score }
    }
    if (!best) {
      return {
        decision: "NEW",
        targetMemoryIds: [],
        mergedContent: null,
        effectiveFrom: null,
        confidenceDelta: 0,
        reason: "No comparable memory.",
      }
    }

    if (best.score >= 0.8) {
      return {
        decision: "DUPLICATE",
        targetMemoryIds: [best.id],
        mergedContent: null,
        effectiveFrom: null,
        confidenceDelta: 0.03,
        reason: `Near-identical wording (overlap ${best.score.toFixed(2)}).`,
      }
    }

    // A change of state only supersedes something it is actually about. Without
    // this guard, "I switched to React" retires whatever unrelated memory
    // happened to rank first — silently destroying information.
    const MIN_RELATEDNESS = 0.05
    if (CHANGE_CUE.test(candidateContent) && best.score >= MIN_RELATEDNESS) {
      return {
        decision: "SUPERSEDE",
        targetMemoryIds: [best.id],
        mergedContent: null,
        effectiveFrom: null,
        confidenceDelta: 0,
        reason: `States a change of state about a related memory (overlap ${best.score.toFixed(2)}).`,
      }
    }

    if (best.score >= 0.5) {
      return {
        decision: "REFINE",
        targetMemoryIds: [best.id],
        mergedContent: candidateContent,
        effectiveFrom: null,
        confidenceDelta: 0.02,
        reason: `Adds detail to an overlapping memory (overlap ${best.score.toFixed(2)}).`,
      }
    }

    return {
      decision: "NEW",
      targetMemoryIds: [],
      mergedContent: null,
      effectiveFrom: null,
      confidenceDelta: 0,
      reason: `Only weakly related (overlap ${best.score.toFixed(2)}).`,
    }
  }

  private parseExisting(block: string): Array<{ id: string; content: string }> {
    const out: Array<{ id: string; content: string }> = []
    const re = /\[\d+\]\s+id=(\S+)[^\n]*\n\s+(.+)/g
    let m: RegExpExecArray | null = re.exec(block)
    while (m !== null) {
      out.push({ id: m[1]!, content: m[2]!.trim() })
      m = re.exec(block)
    }
    return out
  }

  private understand(prompt: string): unknown {
    const query = extractTagged(prompt, "query") ?? prompt
    const intent = /(以前|之前|曾经|过去|used to|previously|before)/i.test(query)
      ? "historical"
      : /(现在|目前|当前|如今|currently|right now|these days)/i.test(query)
        ? "current_state"
        : /(喜欢|偏好|希望|prefer|like)/i.test(query)
          ? "preference"
          : "general"

    const entities = findEntities(query).map((e) => e.name)
    const keywords = [...new Set(words(query))].slice(0, 6)

    return {
      entities,
      taskType: /(架构|设计|architecture|design)/i.test(query)
        ? "architecture"
        : /(debug|报错|错误|排查)/i.test(query)
          ? "debugging"
          : /(教|讲|解释|tutorial|explain)/i.test(query)
            ? "tutorial"
            : null,
      keywords,
      intent,
      timeRangeFrom: null,
      timeRangeTo: null,
    }
  }

  private rerank(prompt: string): unknown {
    const query = extractTagged(prompt, "query") ?? ""
    const block = extractTagged(prompt, "candidates") ?? ""
    const queryWords = words(query)

    const rankings: Array<{ memoryId: string; relevance: number; reason: string }> = []
    const re = /\[\d+\]\s+id=(\S+)[^\n]*\n\s+(.+)/g
    let m: RegExpExecArray | null = re.exec(block)
    while (m !== null) {
      const id = m[1]!
      const content = m[2]!.trim()
      const relevance = Math.min(1, jaccard(queryWords, words(content)) * 1.6)
      rankings.push({
        memoryId: id,
        relevance: Number(relevance.toFixed(3)),
        reason: `Token overlap with the query.`,
      })
      m = re.exec(block)
    }
    return { rankings }
  }
}

// ---------------------------------------------------------------------------
// Deterministic embedding stand-in
// ---------------------------------------------------------------------------

/**
 * Hashed bag-of-tokens embedding.
 *
 * Not semantic — it encodes lexical overlap only. That is sufficient to exercise
 * the vector path end to end and to keep the pipeline honest, but it is NOT a
 * substitute for a real model: recall quality on paraphrases will be poor. The
 * eval suite reports which provider produced a run for exactly this reason.
 */
export class MockEmbedding implements EmbeddingPort {
  readonly dim: number
  readonly modelId: string

  constructor(dim = 1024) {
    this.dim = dim
    this.modelId = `mock-hashing-${dim}`
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t))
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0)
    const tokens = words(text)
    if (tokens.length === 0) return vec

    for (const token of tokens) {
      const h = createHash("md5").update(token).digest()
      const idx = ((h[0]! << 8) | h[1]!) % this.dim
      // Sign from a separate byte keeps unrelated collisions from always adding.
      const sign = (h[2]! & 1) === 0 ? 1 : -1
      vec[idx] = (vec[idx] ?? 0) + sign
    }

    let norm = 0
    for (const v of vec) norm += v * v
    norm = Math.sqrt(norm)
    if (norm === 0) return vec
    return vec.map((v) => v / norm)
  }
}

export { CJK, jaccard, splitClauses, words }
