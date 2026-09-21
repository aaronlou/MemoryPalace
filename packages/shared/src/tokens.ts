/**
 * Token estimation without a tokenizer.
 *
 * A real tokenizer would mean shipping a BPE vocabulary and coupling the recall
 * path to one model family. Recall only needs to respect a budget approximately
 * — being 10% over is harmless, so a cheap estimate is the right trade.
 *
 * The important detail is CJK: Chinese text is roughly 1 token per character,
 * while Latin text is roughly 1 per 4 characters. A single chars/4 rule
 * under-counts Chinese by ~4x and would blow the context budget silently.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x3040 && code <= 0x30ff) || // kana
      (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
      (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
      (code >= 0xac00 && code <= 0xd7af) // hangul
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk + other / 4)
}

/** Fit `text` within a token budget, truncating on a character boundary. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(chars.slice(0, mid).join("")) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  return chars.slice(0, lo).join("")
}
