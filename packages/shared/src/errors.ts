/** Error taxonomy. Everything thrown by Memory Palace extends AppError. */
export class AppError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, details)
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, id: string) {
    super("NOT_FOUND", `${what} not found: ${id}`, { id })
  }
}

/** Raised when a write would create two simultaneously-valid memories in one slot. */
export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFLICT", message, details)
  }
}

/** Raised when an LLM call fails or returns output that fails schema validation. */
export class LlmError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("LLM_ERROR", message, details)
  }
}

/** Raised when the configured provider is missing credentials. */
export class ConfigurationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFIG_ERROR", message, details)
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

/** Best-effort human-readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * Turn any thrown value into a serialisable shape. Used by the HTTP API and the
 * MCP layer so an internal failure never leaks a stack trace to a model.
 */
export function toErrorPayload(e: unknown): { code: string; message: string; details?: unknown } {
  if (isAppError(e)) return { code: e.code, message: e.message, details: e.details }
  return { code: "INTERNAL_ERROR", message: errorMessage(e) }
}
