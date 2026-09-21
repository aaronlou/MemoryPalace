import { serve } from "@hono/node-server"
import { createRuntime } from "@memory-palace/runtime"
import { createApp, mountMcp, mountWebUi } from "./app.js"

/**
 * HTTP API + web UI entrypoint.
 *
 * Binds to loopback by default: this process holds a person's entire private
 * memory, so reaching it over a network is an explicit opt-in via MP_API_HOST.
 */
async function main(): Promise<void> {
  const runtime = createRuntime()
  const app = createApp(runtime)

  await mountMcp(app, runtime)
  mountWebUi(app)

  const server = serve(
    { fetch: app.fetch, port: runtime.config.api.port, hostname: runtime.config.api.host },
    (info) => {
      process.stderr.write(
        `memory-palace api: http://${runtime.config.api.host}:${info.port}\n` +
          `  web ui  : http://${runtime.config.api.host}:${info.port}/\n` +
          `  mcp     : http://${runtime.config.api.host}:${info.port}/mcp  (Streamable HTTP)\n` +
          `  ${runtime.llm.describe()}\n`,
      )
    },
  )

  const shutdown = async (signal: string) => {
    process.stderr.write(`api: ${signal}, shutting down\n`)
    server.close()
    await runtime.close()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

main().catch((error) => {
  process.stderr.write(
    `api: fatal — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
