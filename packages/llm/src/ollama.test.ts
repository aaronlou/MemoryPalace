import { afterEach, describe, expect, it, vi } from "vitest"
import { OllamaEmbedding } from "./ollama.js"

/**
 * Ollama adapter unit tests.
 *
 * These stub `fetch` rather than requiring a running server, so the error paths
 * are exercised in CI. The error paths are the ones that matter: the three
 * realistic first-run failures are "Ollama is not running", "the model is not
 * pulled", and "the model's width does not match the schema", and each has to
 * produce an actionable message rather than a stack trace.
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch
}

describe("OllamaEmbedding", () => {
  it("posts to /api/embed and returns one vector per input", async () => {
    let seenBody: unknown
    stubFetch((url, init) => {
      expect(url).toBe("http://127.0.0.1:11434/api/embed")
      seenBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          embeddings: [
            [1, 0, 0],
            [0, 1, 0],
          ],
        }),
        { status: 200 },
      )
    })

    const adapter = new OllamaEmbedding({ model: "bge-m3", dim: 3 })
    const vectors = await adapter.embed(["a", "b"])

    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ])
    expect(seenBody).toEqual({ model: "bge-m3", input: ["a", "b"] })
  })

  it("returns nothing for an empty input without calling the server", async () => {
    let called = false
    stubFetch(() => {
      called = true
      return new Response("{}")
    })
    expect(await new OllamaEmbedding({ model: "bge-m3", dim: 3 }).embed([])).toEqual([])
    expect(called).toBe(false)
  })

  it("accepts the older single-vector response shape", async () => {
    // Some servers answer /api/embed with a bare `embedding` array.
    stubFetch(() => new Response(JSON.stringify({ embedding: [1, 2, 3] }), { status: 200 }))
    const vectors = await new OllamaEmbedding({ model: "bge-m3", dim: 3 }).embed(["a"])
    expect(vectors).toEqual([[1, 2, 3]])
  })

  it("explains how to pull a missing model", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'model "bge-m3" not found, try pulling it first' }), {
          status: 404,
        }),
    )
    await expect(new OllamaEmbedding({ model: "bge-m3", dim: 1024 }).embed(["x"])).rejects.toThrow(
      /ollama pull bge-m3/,
    )
  })

  it("explains how to start an unreachable server", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch
    await expect(new OllamaEmbedding({ model: "bge-m3", dim: 1024 }).embed(["x"])).rejects.toThrow(
      /cannot reach Ollama|ollama serve/,
    )
  })

  it("fails with the migration recipe when the width disagrees", async () => {
    // The realistic trap: pulling a 768-dimensional model into a vector(1024)
    // schema. Caught on the first embedding, not on the first recall.
    stubFetch(
      () => new Response(JSON.stringify({ embeddings: [new Array(768).fill(0)] }), { status: 200 }),
    )
    const adapter = new OllamaEmbedding({ model: "embeddinggemma", dim: 1024 })
    await expect(adapter.embed(["x"])).rejects.toThrow(/produces 768-dimensional vectors/)
    // The message must also carry the fix, and the failure must be sticky:
    // a misconfiguration that healed after one call would feed wrong-length
    // vectors to the database instead.
    await expect(adapter.embed(["x"])).rejects.toThrow(/pnpm embedding:dim 768/)
  })

  it("only reports a width mismatch once", async () => {
    // The check is cached; a long re-embed must not re-raise per batch.
    stubFetch(() => new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), { status: 200 }))
    const adapter = new OllamaEmbedding({ model: "m", dim: 3 })
    await expect(adapter.embed(["a"])).resolves.toEqual([[1, 2, 3]])
    await expect(adapter.embed(["b"])).resolves.toEqual([[1, 2, 3]])
  })

  it("rejects a response with the wrong number of vectors", async () => {
    stubFetch(() => new Response(JSON.stringify({ embeddings: [[1]] }), { status: 200 }))
    await expect(new OllamaEmbedding({ model: "m", dim: 1 }).embed(["a", "b"])).rejects.toThrow(
      /1 embeddings for 2 inputs/,
    )
  })

  it("lists models, and degrades quietly when the server is down", async () => {
    stubFetch(
      () => new Response(JSON.stringify({ models: [{ name: "bge-m3:latest" }] }), { status: 200 }),
    )
    expect(await new OllamaEmbedding({ model: "bge-m3", dim: 1024 }).listModels()).toEqual([
      "bge-m3:latest",
    ])

    globalThis.fetch = (() => Promise.reject(new Error("down"))) as typeof fetch
    expect(await new OllamaEmbedding({ model: "bge-m3", dim: 1024 }).listModels()).toEqual([])
  })

  it("trims a trailing slash from the base URL", async () => {
    let url = ""
    stubFetch((u) => {
      url = u
      return new Response(JSON.stringify({ embeddings: [[1]] }), { status: 200 })
    })
    await new OllamaEmbedding({ model: "m", dim: 1, baseUrl: "http://host:1234/" }).embed(["a"])
    expect(url).toBe("http://host:1234/api/embed")
  })
})
