import pg from "pg"

const { Pool } = pg

/**
 * Postgres access.
 *
 * Deliberately thin: the temporal and hybrid-retrieval queries this system
 * depends on cannot be expressed through a query builder anyway, so raw SQL is
 * the honest choice. A query builder would only add a layer to work around.
 */
export class PgDatabase {
  private readonly pool: pg.Pool

  constructor(connectionString: string, maxConnections = 10) {
    this.pool = new Pool({
      connectionString,
      max: maxConnections,
      // A local single-user system should surface a broken connection quickly
      // rather than hang a tool call.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    })
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, params as never[])
  }

  /**
   * Run `fn` inside a transaction on a single connection.
   *
   * This is the primitive that makes "insert the new memory, close the old
   * one's validity, write the relation edge, update the status projection"
   * atomic — the guarantee the whole evolution stage rests on.
   */
  async withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await fn(client)
      await client.query("COMMIT")
      return result
    } catch (error) {
      try {
        await client.query("ROLLBACK")
      } catch {
        // A failed rollback means the connection is unusable; releasing it below
        // still returns the socket to the pool, where it will be discarded.
      }
      throw error
    } finally {
      client.release()
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1")
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/**
 * Render a JS number array as a pgvector literal.
 *
 * Sent as text rather than a parameter array because `pg` would otherwise try to
 * encode a JS array as a Postgres array, which a `vector` column rejects. Doing
 * the formatting here avoids taking a dependency on `pgvector`'s type
 * registration when we only ever write vectors and let SQL compute distances.
 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`
}

/** Postgres returns `count(*)` as bigint, which node-postgres surfaces as string. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") return Number.parseInt(value, 10)
  return 0
}
