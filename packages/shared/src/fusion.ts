/**
 * Rank fusion.
 *
 * Reciprocal Rank Fusion combines several ranked lists without needing their
 * scores to be comparable. That matters here: a cosine distance, a `ts_rank`
 * value and an entity-overlap count live on completely different scales, and
 * any weighted sum of them needs re-tuning every time an embedding model or a
 * Postgres version changes. RRF only looks at *position*, so it survives both.
 *
 * Note: reciprocal rank fusion is sometimes written `sum(1/(k+rank))` — the
 * variant used here ranks from 1, so a route's best hit contributes 1/(k+1).
 */

export interface RankedItem {
  id: string
  /** Raw route-specific score. Recorded for explanations, not for fusion. */
  score?: number
}

export interface FusedItem {
  id: string
  rrf: number
  /** Which routes surfaced this item, and at what 1-based position. */
  routes: Array<{ route: string; rank: number; score?: number }>
}

export const DEFAULT_RRF_K = 60

/**
 * Fuse several ranked lists into one.
 *
 * @param lists  route name -> ranked items, best first
 * @param k      smoothing constant; larger values flatten the influence of top ranks
 * @param weights optional per-route multiplier, for when one route is known to be stronger
 */
export function reciprocalRankFusion(
  lists: Array<{ route: string; items: RankedItem[] }>,
  k: number = DEFAULT_RRF_K,
  weights: Record<string, number> = {},
): FusedItem[] {
  const acc = new Map<string, FusedItem>()

  for (const list of lists) {
    const weight = weights[list.route] ?? 1
    if (weight === 0) continue
    // Rank within a list must be 1-based and unique, so a route that returns the
    // same id twice still contributes only once at its best position.
    const seen = new Set<string>()
    let rank = 0
    for (const item of list.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      rank += 1
      const contribution = (weight * 1) / (k + rank)

      const existing = acc.get(item.id)
      if (existing) {
        existing.rrf += contribution
        existing.routes.push({ route: list.route, rank, score: item.score })
      } else {
        acc.set(item.id, {
          id: item.id,
          rrf: contribution,
          routes: [{ route: list.route, rank, score: item.score }],
        })
      }
    }
  }

  return [...acc.values()].sort((a, b) => b.rrf - a.rrf)
}

/**
 * Normalise RRF scores into 0-1 for comparison against a fixed threshold.
 *
 * RRF scores are not absolute — the top score depends on how many routes ran
 * and how deep they went, so a raw threshold would behave differently for a
 * fast-path query (2 routes) than a smart-path one (5 routes). Dividing by the
 * theoretical maximum for the routes actually used makes one threshold valid.
 */
export function normalizeRrf(
  fused: FusedItem[],
  routeCount: number,
  k: number = DEFAULT_RRF_K,
): number[] {
  if (routeCount <= 0) return fused.map(() => 0)
  const maxPossible = routeCount * (1 / (k + 1))
  return fused.map((f) => Math.min(1, f.rrf / maxPossible))
}

/** Convenience: fuse and normalise in one step. */
export function fuseAndNormalize(
  lists: Array<{ route: string; items: RankedItem[] }>,
  k: number = DEFAULT_RRF_K,
  weights: Record<string, number> = {},
): Array<FusedItem & { normalized: number }> {
  const fused = reciprocalRankFusion(lists, k, weights)
  const activeRoutes = lists.filter(
    (l) => (weights[l.route] ?? 1) !== 0 && l.items.length > 0,
  ).length
  const normalized = normalizeRrf(fused, activeRoutes, k)
  return fused.map((f, i) => ({ ...f, normalized: normalized[i] ?? 0 }))
}
