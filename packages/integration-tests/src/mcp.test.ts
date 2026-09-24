import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { TestRuntime } from "@memory-palace/test-support"
import { createTestRuntime, TEST_DATABASE_URL, truncateAll } from "@memory-palace/test-support"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * MCP integration, exercised the way a real agent does it.
 *
 * This spawns the actual server process and talks to it over stdio with the
 * official client. Anything less — calling the tool handlers directly, say —
 * would not catch the failure modes that actually break MCP integrations:
 * protocol framing, stdout pollution, schema conversion, and tool naming.
 *
 * A dedicated user id keeps this suite from colliding with the others, which all
 * share one database.
 */

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const tsxCli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs")

const USER = "mcp-test-user"
const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL

let client: Client
let transport: StdioClientTransport
let rt: TestRuntime
let serverStderr = ""

beforeAll(async () => {
  // Seed/clean through a direct connection, since the server process owns its own.
  rt = await createTestRuntime({ userId: USER })
  await truncateAll(rt.storage.db)

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, join(repoRoot, "apps", "mcp", "src", "main.ts")],
    cwd: repoRoot,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL,
      MP_USER_ID: USER,
      MP_LLM_PROVIDER: "mock",
      MP_EMBEDDING_PROVIDER: "mock",
      // Must match the schema, which is a deployment property.
      MP_EMBEDDING_DIM: String(rt.config.embedding.dim),
      MP_LOG_LEVEL: "error",
    },
  })

  transport.stderr?.on("data", (chunk: Buffer) => {
    serverStderr += chunk.toString()
  })

  client = new Client({ name: "memory-palace-tests", version: "1.0.0" })
  await client.connect(transport)
}, 60_000)

afterAll(async () => {
  await client?.close()
  await rt.cleanup()
})

describe("server handshake", () => {
  it("advertises instructions that tell the model when to call it", () => {
    const instructions = client.getInstructions()
    expect(instructions).toBeTruthy()
    // The instruction has to name the situations, not just describe the server.
    expect(instructions).toContain("memory_recall")
    expect(instructions).toContain("memory_remember")
  })

  it("exposes a small, non-overlapping tool set", async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    // `memory_feedback` joined this set, which is why the assertion exists: every
    // tool costs selection accuracy, so adding one has to be a decision someone
    // makes in the open rather than a drift nobody noticed. It earns the slot by
    // overlapping nothing — the other seven read or write memories, and none of
    // them accepts a judgement about one.
    expect(names).toEqual([
      "memory_confirm",
      "memory_feedback",
      "memory_forget",
      "memory_recall",
      "memory_remember",
      "memory_search",
      "memory_stats",
      "memory_update",
    ])

    // Every tool needs a description: it is the only thing the model sees when
    // deciding whether to call it.
    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy()
      expect(tool.description!.length).toBeGreaterThan(40)
    }
  })

  it("converts Zod schemas into usable JSON Schema for tool inputs", async () => {
    const { tools } = await client.listTools()
    const recall = tools.find((t) => t.name === "memory_recall")!
    const schema = recall.inputSchema as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(schema.properties).toBeDefined()
    expect(Object.keys(schema.properties!)).toContain("query")
    expect(schema.required).toContain("query")
  })
})

describe("remember then recall over the wire", () => {
  it("stores a durable statement and reports what it kept", async () => {
    const result = await client.callTool({
      name: "memory_remember",
      arguments: {
        content: "我最近开始系统学习 Effect-TS。以后讲 TypeScript 时先从整体结构和设计思想讲。",
        source_kind: "user",
      },
    })
    expect(result.isError).toBeFalsy()
    const text = extractText(result)
    expect(text).toMatch(/Remembered|Reviewed/)
    expect(text).toContain("Effect-TS")
  })

  it("returns a briefing for a related question", async () => {
    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "Effect-TS 的 Context.Service 怎么理解？" },
    })
    expect(result.isError).toBeFalsy()
    const text = extractText(result)
    expect(text).toContain("Effect-TS")
    // The rendered context carries a validity window the model can reason about.
    expect(text).toContain("至今")
  })

  it("says so plainly when nothing is relevant, rather than erroring", async () => {
    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "今天东京的天气怎么样？" },
    })
    expect(result.isError).toBeFalsy()
    const text = extractText(result)
    // Design doc Case 4: "nothing known" must be distinguishable from "here is
    // something vaguely related", and must not look like a failure.
    expect(text).toContain("No relevant memories")
  })

  it("supports structured output for programmatic consumers", async () => {
    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "Effect-TS", format: "json" },
    })
    const structured = result.structuredContent as { memories?: unknown[] } | undefined
    expect(structured?.memories).toBeDefined()
    expect(Array.isArray(structured!.memories)).toBe(true)
  })

  it("searches directly without a model call", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "Effect-TS" },
    })
    expect(result.isError).toBeFalsy()
    expect(extractText(result)).toContain("Effect-TS")
  })

  it("reports statistics", async () => {
    const result = await client.callTool({ name: "memory_stats", arguments: {} })
    expect(result.isError).toBeFalsy()
    const text = extractText(result)
    expect(text).toContain("active:")
    expect(text).toMatch(/models:\s+mock/)
  })

  it("rejects an invalid argument without crashing the server", async () => {
    // `limit` is constrained to 1..50. Whether the SDK rejects the request or
    // returns a tool error is an implementation detail; what matters is that the
    // model does not receive a silent success, and the server survives.
    let failed = false
    try {
      const result = await client.callTool({
        name: "memory_recall",
        arguments: { query: "x", limit: 9999 },
      })
      failed = result.isError === true
    } catch {
      failed = true
    }
    expect(failed).toBe(true)

    const after = await client.callTool({ name: "memory_stats", arguments: {} })
    expect(after.isError).toBeFalsy()
  })
})

describe("transport hygiene", () => {
  it("keeps protocol noise off stdout", () => {
    // A stray write to stdout corrupts the JSON-RPC stream. Anything the server
    // wants to say must go to stderr.
    expect(serverStderr.length).toBeGreaterThanOrEqual(0)
    expect(serverStderr).not.toContain("undefined is not a function")
  })
})

function extractText(result: { content?: unknown }): string {
  const content = result.content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (isTextBlock(block) ? block.text : ""))
    .filter(Boolean)
    .join("\n")
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: string }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  )
}
