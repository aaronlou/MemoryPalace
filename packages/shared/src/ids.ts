/**
 * ULID: 48-bit timestamp + 80-bit randomness, Crockford base32 encoded.
 *
 * Why not UUIDv4? Memory ids are written once and then scanned by humans in
 * logs, exports and the web UI. ULIDs sort lexicographically by creation time,
 * which makes `ORDER BY id` a stable proxy for `ORDER BY created_at` and makes
 * ids in a Markdown export read chronologically.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford base32 (no I, L, O, U)
const TIME_LEN = 10
const RANDOM_LEN = 16

function encodeTime(now: number, len: number): string {
  let out = ""
  let t = now
  for (let i = len - 1; i >= 0; i--) {
    out = ALPHABET[t % 32] + out
    t = Math.floor(t / 32)
  }
  return out
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % 32]
  return out
}

/** Generate a monotonic-ish ULID string (26 chars, uppercase). */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN)
}

/** Extract the embedded creation time from a ULID. */
export function ulidTime(id: string): Date | null {
  if (id.length < TIME_LEN) return null
  let t = 0
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ALPHABET.indexOf(id[i]!.toUpperCase())
    if (idx === -1) return null
    t = t * 32 + idx
  }
  return new Date(t)
}

/**
 * Prefixed ids make a raw database dump or log line self-describing:
 * `mem_...` is a memory, `obs_...` is an observation.
 */
export type IdPrefix = "obs" | "mem" | "rel" | "ent" | "src" | "run" | "pol" | "pa" | "fb"

export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`
}
