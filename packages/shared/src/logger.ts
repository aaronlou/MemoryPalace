export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

/**
 * Structured JSON-lines logger.
 *
 * Memory Palace writes to stdout for the MCP stdio server, so log lines MUST go
 * to stderr — anything on stdout corrupts the JSON-RPC stream.
 */
export function createLogger(level: LogLevel = "info", base: Record<string, unknown> = {}): Logger {
  const threshold = LEVELS[level]

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < threshold) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...base,
      ...fields,
    })
    process.stderr.write(`${line}\n`)
  }

  const logger: Logger = {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  }
  return logger
}

/** A logger that discards everything. Keeps tests quiet. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
}
