/**
 * Memory Palace MCP server (stdio).
 *
 * Transport note: stdout is the JSON-RPC channel. Nothing may write to stdout
 * except the SDK. The logger in @memory-palace/shared writes to stderr for
 * exactly this reason, and `console.log` must never be used in this process.
 */

import { createRuntime, registerTools, SERVER_INSTRUCTIONS } from "@memory-palace/runtime"
import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

const SERVER_NAME = "memory-palace"
const SERVER_VERSION = "0.1.0"

async function main(): Promise<void> {
  const runtime = createRuntime()

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      // Kept well under the 32 KiB instruction cap that clients like DSH apply.
      // The long-form memory briefing is generated per call inside the recall
      // tool result instead — instructions are for *how to use the server*, not
      // for carrying data.
      instructions: SERVER_INSTRUCTIONS,
    },
  )

  registerTools(server, runtime.palace, runtime.config.userId)

  const transport = new StdioServerTransport()

  const shutdown = async (signal: string) => {
    process.stderr.write(`memory-palace: received ${signal}, shutting down\n`)
    try {
      await server.close()
      await runtime.close()
    } catch {
      // Nothing useful left to do during shutdown.
    }
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  await server.connect(transport)
  process.stderr.write(
    `memory-palace: ready on stdio (${runtime.config.userId}) — ${runtime.llm.describe()}\n`,
  )
}

main().catch((error) => {
  // stderr, never stdout: a partially-written stdout stream would corrupt the
  // protocol for a client that has already started reading.
  process.stderr.write(
    `memory-palace: fatal — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
