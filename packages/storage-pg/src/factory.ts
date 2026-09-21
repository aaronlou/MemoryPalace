import type { MemorySearch, MemoryStore } from "@memory-palace/core"
import type { Config } from "@memory-palace/shared"
import { PgDatabase } from "./client.js"
import { PgMemorySearch } from "./search.js"
import { PgMemoryStore } from "./store.js"

export interface StorageBundle {
  db: PgDatabase
  store: MemoryStore
  search: MemorySearch
  close(): Promise<void>
}

/** Wire up Postgres storage from configuration. */
export function createStorage(config: Config, maxConnections = 10): StorageBundle {
  const db = new PgDatabase(config.databaseUrl, maxConnections)
  return {
    db,
    store: new PgMemoryStore(db),
    search: new PgMemorySearch(db),
    close: () => db.close(),
  }
}
