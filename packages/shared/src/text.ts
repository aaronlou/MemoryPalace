/**
 * Small text helpers shared by extraction, dedup and export.
 * No NLP libraries: everything here must be explainable and dependency-free.
 */

/** Collapse whitespace and trim. Does not change wording. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * Normalised form used for exact-duplicate detection.
 *
 * Deliberately conservative: lowercases and strips punctuation/whitespace only.
 * It must NOT stem or drop words, because "用户喜欢 Java" and "用户不喜欢 Java"
 * collapse to the same key if negation is stripped — a silent correctness bug.
 */
export function dedupKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[.,;:!?'"`()[\]{}<>《》【】（）「」、，。；：！？…—–-]/g, "")
}

/** Split a long document into overlapping windows on paragraph/sentence bounds. */
export function chunkText(text: string, maxChars = 4000, overlapChars = 200): string[] {
  const clean = normalizeWhitespace(text)
  if (clean.length <= maxChars) return clean === "" ? [] : [clean]

  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length)
    if (end < clean.length) {
      // Prefer to break at a sentence terminator in the last 25% of the window.
      const window = clean.slice(start, end)
      const searchFrom = Math.floor(window.length * 0.75)
      const idx = Math.max(
        window.lastIndexOf("。", window.length),
        window.lastIndexOf("！", window.length),
        window.lastIndexOf("？", window.length),
        window.lastIndexOf(". ", window.length),
      )
      if (idx >= searchFrom) end = start + idx + 1
    }
    chunks.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(end - overlapChars, start + 1)
  }
  return chunks.filter((c) => c.length > 0)
}

/** Truncate for display without splitting a surrogate pair. */
export function truncate(s: string, max = 120): string {
  const chars = Array.from(s)
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`
}

/**
 * Cheap CJK detection. Postgres' built-in full-text search tokenises poorly for
 * Chinese, so retrieval falls back to trigram matching for these inputs.
 */
export function hasCjk(s: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s)
}

/** Tokenise for lexical search: CJK becomes bigrams, latin becomes words. */
export function lexicalTokens(s: string): string[] {
  const tokens: string[] = []
  const latin = s.toLowerCase().match(/[a-z0-9][a-z0-9+.#_-]*/g) ?? []
  tokens.push(...latin)
  const cjkRuns = s.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
    if (run.length === 1) tokens.push(run)
  }
  return tokens
}

/**
 * Pull the contents of the first `<tag>...</tag>` block out of a prompt.
 *
 * Prompts are built with explicit XML-ish delimiters so that both providers and
 * the offline rule-based provider can locate the payload unambiguously. This
 * helper is the single place that knows that convention.
 */
export function extractTagged(text: string, tag: string): string | null {
  const open = `<${tag}`
  const start = text.indexOf(open)
  if (start === -1) return null
  const contentStart = text.indexOf(">", start)
  if (contentStart === -1) return null
  const close = `</${tag}>`
  const end = text.indexOf(close, contentStart)
  if (end === -1) return null
  return text.slice(contentStart + 1, end)
}

/**
 * Terms that appear in so many memories that they carry no signal.
 *
 * "用户" is the important one: every memory is written as a third-person
 * statement about the user, so it occurs in nearly all of them. Gating lexical
 * retrieval on it makes every query match everything, which is how a memory
 * system ends up unable to say "I don't know".
 */
const STOPWORDS = new Set([
  "用户",
  "自己",
  "我们",
  "你们",
  "他们",
  "什么",
  "怎么",
  "这个",
  "那个",
  "现在",
  "目前",
  "可以",
  "需要",
  "应该",
  "一直",
  "已经",
  "还是",
  "如果",
  "因为",
  "所以",
  "但是",
  "而且",
  "以及",
  "就是",
  "没有",
  "不是",
  "一个",
  "一下",
  "有点",
  "比较",
  "非常",
  "进行",
  "通过",
  "关于",
  "对于",
  "时间",
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "has",
  "was",
  "were",
  "are",
  "you",
  "your",
  "can",
  "will",
  "would",
  "should",
  "about",
  "into",
  "when",
  "what",
  "how",
  "does",
  "did",
  "not",
  "but",
  "use",
  "using",
])

/**
 * Tokens worth matching on: at least two characters and not a stopword.
 *
 * Used as the gate for lexical retrieval — similarity scores order results, but
 * this decides whether a memory is about the same thing at all.
 */
export function discriminativeTokens(s: string): string[] {
  return lexicalTokens(s).filter((t) => t.length >= 2 && !STOPWORDS.has(t.toLowerCase()))
}

/**
 * Which writing system a piece of text is predominantly in.
 *
 * Used to catch a language model answering in the wrong language. This is rare
 * (observed roughly once in 55 extractions of Chinese input) but it is worth
 * guarding against, because the failure is close to silent: an English memory
 * stored in a Chinese memory store is nearly unfindable, since CJK lexical
 * matching is bigram-based and the semantic route compares across languages.
 */
export type Script = "cjk" | "latin" | "mixed" | "none"

export function detectScript(text: string): Script {
  let cjk = 0
  let latin = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x3040 && code <= 0x30ff) cjk += 1
    else if (code >= 0x3400 && code <= 0x4dbf) cjk += 1
    else if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1
    else if (code >= 0xac00 && code <= 0xd7af) cjk += 1
    else if (/[A-Za-z]/.test(ch)) latin += 1
  }
  const total = cjk + latin
  if (total === 0) return "none"
  // A memory may legitimately mix scripts — "用户使用 PostgreSQL" is not drift.
  // Only a clear mismatch counts.
  if (cjk / total >= 0.2) return cjk >= latin ? "cjk" : "mixed"
  return latin > 0 ? "latin" : "none"
}

/** The language to ask for, named so a prompt can say it plainly. */
export function languageName(script: Script, sample: string): string {
  if (script === "cjk") {
    // Distinguish Chinese from Japanese/Korean with a cheap heuristic; only
    // Chinese needs naming because that is the input language here.
    return /[\u3040-\u30ff]/.test(sample) ? "Japanese" : "Chinese (中文)"
  }
  return "English"
}

/**
 * True when every candidate came back in a different script from the input.
 *
 * Requiring ALL candidates to mismatch avoids retrying over one stray English
 * technical term, which is normal and correct in Chinese text.
 */
export function allCandidatesDrifted(input: string, contents: string[]): boolean {
  if (contents.length === 0) return false
  const inputScript = detectScript(input)
  if (inputScript !== "cjk" && inputScript !== "mixed") return false
  return contents.every((c) => detectScript(c) === "latin")
}
