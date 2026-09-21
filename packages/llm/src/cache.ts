import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Response cache.
 *
 * This exists for one reason: the eval suite has to be cheap enough to run on
 * every prompt change. Without caching, each full evaluation re-bills every
 * call, and the rational behaviour becomes "run it rarely" — which is exactly
 * backwards for a system whose quality lives in its prompts.
 *
 * The cache key must include everything that can change the answer: the prompt
 * text, the instructions, the model, and the schema. Changing a prompt must
 * therefore MISS the cache, not silently return a stale verdict.
 */
export interface CacheEntry {
  value: unknown
  modelId: string
  inputTokens: number
  outputTokens: number
  createdAt: string
}

export function hashPrompt(parts: Array<string | undefined>): string {
  const h = createHash("sha256")
  for (const part of parts) {
    h.update(part ?? "\u0000")
    h.update("\u0001")
  }
  return h.digest("hex").slice(0, 32)
}

export interface ResponseCache {
  get(key: string): CacheEntry | undefined
  set(key: string, entry: CacheEntry): void
  readonly size: number
  flush(): void
}

/** In-memory only. Default for tests and CLI runs. */
export class MemoryCache implements ResponseCache {
  private readonly map = new Map<string, CacheEntry>()

  get(key: string): CacheEntry | undefined {
    return this.map.get(key)
  }

  set(key: string, entry: CacheEntry): void {
    this.map.set(key, entry)
  }

  get size(): number {
    return this.map.size
  }

  flush(): void {
    // nothing to do
  }
}

/** No caching at all. Used when measuring true latency/cost. */
export class NullCache implements ResponseCache {
  get(): undefined {
    return undefined
  }
  set(): void {}
  get size(): number {
    return 0
  }
  flush(): void {}
}

/**
 * File-backed cache, loaded once and written on flush.
 *
 * A flat JSON object rather than a database: the working set is small (one
 * entry per distinct prompt), and keeping it inspectable matters more than
 * throughput — being able to `grep` the cache is useful when debugging why an
 * eval produced a surprising score.
 */
export class FileCache implements ResponseCache {
  private readonly path: string
  private readonly map: Map<string, CacheEntry>
  private dirty = false

  constructor(path: string) {
    this.path = path
    this.map = new Map()
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, CacheEntry>
        for (const [k, v] of Object.entries(raw)) this.map.set(k, v)
      } catch {
        // A corrupt cache is not worth failing over; start clean.
        this.map.clear()
      }
    }
  }

  get(key: string): CacheEntry | undefined {
    return this.map.get(key)
  }

  set(key: string, entry: CacheEntry): void {
    this.map.set(key, entry)
    this.dirty = true
  }

  get size(): number {
    return this.map.size
  }

  flush(): void {
    if (!this.dirty) return
    const dir = dirname(this.path)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map)), "utf8")
    this.dirty = false
  }
}
