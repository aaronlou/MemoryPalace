import type {
  EvaluationState,
  PriorArtEntry,
  PriorArtEvaluation,
  PriorArtEvidence,
  PriorArtInput,
  PriorArtStatus,
  PriorArtStore,
} from "@memory-palace/core"
import { repoUrl } from "@memory-palace/core"
import { newId } from "@memory-palace/shared"
import type pg from "pg"
import type { PgDatabase } from "./client.js"

/**
 * Postgres implementation of `PriorArtStore`.
 *
 * `evidence` is jsonb, so it is written and read as a whole. That is deliberate:
 * references are never queried across entries, and keeping them in one column
 * makes a half-written entry impossible.
 */
export class PgPriorArtStore implements PriorArtStore {
  private readonly db: PgDatabase

  constructor(db: PgDatabase) {
    this.db = db
  }

  private async q<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<R[]> {
    const result = await this.db.query<R>(text, params)
    return result.rows
  }

  async list(userId: string): Promise<PriorArtEntry[]> {
    const rows = await this.q<PriorArtRow>(
      `SELECT * FROM prior_art WHERE user_id = $1 ORDER BY added_at DESC, repo`,
      [userId],
    )
    return rows.map(toEntry)
  }

  async get(userId: string, id: string): Promise<PriorArtEntry | undefined> {
    const rows = await this.q<PriorArtRow>(
      `SELECT * FROM prior_art WHERE user_id = $1 AND id = $2`,
      [userId, id],
    )
    return rows[0] ? toEntry(rows[0]) : undefined
  }

  /**
   * Insert or replace, keyed on `(userId, repo)`.
   *
   * `ON CONFLICT ... DO UPDATE` rather than a read-then-write: re-adding a
   * project you already listed should update the assessment, and two concurrent
   * adds of the same repo must not both succeed. `id` is preserved on conflict so
   * links into the page keep working.
   */
  async upsert(userId: string, input: PriorArtInput, id?: string): Promise<PriorArtEntry> {
    const repo = input.repo.trim()
    const rows = await this.q<PriorArtRow>(
      `INSERT INTO prior_art
         (id, user_id, repo, url, title, claim, status, rationale,
          not_taken, kill_criterion, source_revision, evidence, evaluation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
       ON CONFLICT (user_id, repo) DO UPDATE SET
         url             = EXCLUDED.url,
         title           = EXCLUDED.title,
         claim           = EXCLUDED.claim,
         status          = EXCLUDED.status,
         rationale       = EXCLUDED.rationale,
         not_taken       = EXCLUDED.not_taken,
         kill_criterion  = EXCLUDED.kill_criterion,
         source_revision = EXCLUDED.source_revision,
         evidence        = EXCLUDED.evidence,
         evaluation      = EXCLUDED.evaluation,
         -- An edit counts as a review: the point of the timestamp is to surface
         -- entries nobody has looked at, not to punish correcting one.
         reviewed_at     = now()
       RETURNING *`,
      [
        id ?? newId("pa"),
        userId,
        repo,
        input.url?.trim() || repoUrl(repo),
        input.title.trim(),
        input.claim.trim(),
        input.status,
        input.rationale.trim(),
        input.notTaken?.trim() || null,
        input.killCriterion?.trim() || null,
        input.sourceRevision?.trim() || null,
        JSON.stringify(input.evidence ?? []),
        JSON.stringify(input.evaluation ?? { state: "none" }),
      ],
    )
    return toEntry(rows[0]!)
  }

  async getByRepo(userId: string, repo: string): Promise<PriorArtEntry | undefined> {
    const rows = await this.q<PriorArtRow>(
      `SELECT * FROM prior_art WHERE user_id = $1 AND repo = $2`,
      [userId, repo],
    )
    return rows[0] ? toEntry(rows[0]) : undefined
  }

  async setEvaluation(
    userId: string,
    id: string,
    evaluation: PriorArtEvaluation,
  ): Promise<PriorArtEntry | undefined> {
    const rows = await this.q<PriorArtRow>(
      `UPDATE prior_art SET evaluation = $3::jsonb
        WHERE user_id = $1 AND id = $2
        RETURNING *`,
      [userId, id, JSON.stringify(evaluation)],
    )
    return rows[0] ? toEntry(rows[0]) : undefined
  }

  async withEvaluationState(states: EvaluationState[]): Promise<PriorArtEntry[]> {
    if (states.length === 0) return []
    const rows = await this.q<PriorArtRow>(
      `SELECT * FROM prior_art WHERE evaluation->>'state' = ANY($1::text[]) ORDER BY added_at`,
      [states],
    )
    return rows.map(toEntry)
  }

  /** True when a row was removed, so a caller can 404 on a stale id. */
  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await this.q(`DELETE FROM prior_art WHERE user_id = $1 AND id = $2 RETURNING id`, [
      userId,
      id,
    ])
    return rows.length > 0
  }
}

interface PriorArtRow extends pg.QueryResultRow {
  id: string
  user_id: string
  repo: string
  url: string
  title: string
  claim: string
  status: string
  rationale: string
  not_taken: string | null
  kill_criterion: string | null
  source_revision: string | null
  evidence: unknown
  evaluation: unknown
  added_at: Date | string
  reviewed_at: Date | string
}

function toEntry(row: PriorArtRow): PriorArtEntry {
  return {
    id: row.id,
    userId: row.user_id,
    repo: row.repo,
    url: row.url,
    title: row.title,
    claim: row.claim,
    status: row.status as PriorArtStatus,
    rationale: row.rationale,
    notTaken: row.not_taken ?? undefined,
    killCriterion: row.kill_criterion ?? undefined,
    sourceRevision: row.source_revision ?? undefined,
    evidence: toEvidence(row.evidence),
    evaluation: toEvaluation(row.evaluation),
    addedAt: toIso(row.added_at),
    reviewedAt: toIso(row.reviewed_at),
  }
}

/**
 * jsonb round-trips through `unknown`, so the shape is re-established here rather
 * than trusted. A malformed row should degrade to "no evidence" — which the UI
 * shows as an unbacked claim — instead of throwing out of a list endpoint.
 */
function toEvidence(value: unknown): PriorArtEvidence[] {
  if (!Array.isArray(value)) return []
  const out: PriorArtEvidence[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.kind !== "string" || typeof record.ref !== "string") continue
    out.push({
      kind: record.kind as PriorArtEvidence["kind"],
      ref: record.ref,
      note: typeof record.note === "string" ? record.note : undefined,
    })
  }
  return out
}

/**
 * jsonb comes back as `unknown`, so the shape is re-established rather than
 * trusted. A malformed value degrades to "no evaluation" — the UI then offers the
 * button again — instead of throwing out of a list endpoint.
 */
function toEvaluation(value: unknown): PriorArtEvaluation {
  if (typeof value !== "object" || value === null) return { state: "none" }
  const record = value as Record<string, unknown>
  const state = typeof record.state === "string" ? record.state : "none"
  return { ...record, state } as PriorArtEvaluation
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString()
}
