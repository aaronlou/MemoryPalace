#!/usr/bin/env bash
# Manages a self-contained PostgreSQL 18 + pgvector cluster for Memory Palace.
#
# Why a repo-local cluster instead of the system Postgres or Docker?
#   - no system state is touched (no `brew services`, no global data dir)
#   - no Docker daemon required
#   - the same command works on a fresh machine and in CI
#   - `db:reset` is a safe one-liner because the data dir lives under .local-pg/
#
# Requires PostgreSQL 18 binaries with the pgvector extension available.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGROOT="$ROOT/.local-pg"
PGDATA="$PGROOT/data"
PGLOG="$PGROOT/postgres.log"
PORT="${MP_PGPORT:-55432}"
DBNAME="${MP_DB:-memory_palace}"
DBUSER="${MP_USER:-mp}"

# --- locate PostgreSQL 18 binaries -------------------------------------------------
find_pg_bin() {
  if [[ -n "${MP_PG_BIN:-}" ]]; then echo "$MP_PG_BIN"; return; fi
  for candidate in \
    /opt/homebrew/opt/postgresql@18/bin \
    /usr/local/opt/postgresql@18/bin \
    /opt/homebrew/opt/postgresql/bin \
    /usr/lib/postgresql/18/bin
  do
    [[ -x "$candidate/initdb" ]] && { echo "$candidate"; return; }
  done
  # fall back to whatever is on PATH, but verify the major version
  if command -v initdb >/dev/null 2>&1; then
    local v; v="$(initdb --version | grep -oE '[0-9]+' | head -1)"
    if [[ "$v" == "18" ]]; then echo "$(dirname "$(command -v initdb)")"; return; fi
  fi
  return 1
}

if ! PG_BIN="$(find_pg_bin)"; then
  cat >&2 <<'EOF'
ERROR: could not find PostgreSQL 18 binaries.

Install them with one of:
  brew install postgresql@18 pgvector
  apt-get install postgresql-18 postgresql-18-pgvector

Or point MP_PG_BIN at the directory containing initdb/pg_ctl/psql.
EOF
  exit 1
fi

export PATH="$PG_BIN:$PATH"
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U "$DBUSER" -d "$DBNAME" -v ON_ERROR_STOP=1)

is_running() { pg_ctl -D "$PGDATA" status >/dev/null 2>&1; }

cmd_init() {
  if [[ -f "$PGDATA/PG_VERSION" ]]; then
    echo "cluster already initialised at $PGDATA"
  else
    mkdir -p "$PGROOT"
    echo "initialising cluster at $PGDATA ..."
    initdb -D "$PGDATA" -U "$DBUSER" --auth=trust --encoding=UTF8 --locale=C >/dev/null
  fi

}

cmd_start() {
  [[ -f "$PGDATA/PG_VERSION" ]] || cmd_init
  if is_running; then echo "already running on port $PORT"; return; fi
  echo "starting postgres on 127.0.0.1:$PORT ..."
  pg_ctl -D "$PGDATA" -l "$PGLOG" \
    -o "-p $PORT -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
    start >/dev/null
  for _ in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p "$PORT" -q && break
    sleep 0.5
  done

  if ! psql -h 127.0.0.1 -p "$PORT" -U "$DBUSER" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='$DBNAME'" | grep -q 1; then
    createdb -h 127.0.0.1 -p "$PORT" -U "$DBUSER" "$DBNAME"
    echo "created database $DBNAME"
  fi

  # Let Postgres be the authority on whether pgvector is present: probing the
  # filesystem for vector.control produces false alarms depending on how the
  # extension was packaged.
  if ! "${PSQL[@]}" -q -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null; then
    echo "ERROR: could not enable the pgvector extension." >&2
    echo "       Install it (brew install pgvector / postgresql-18-pgvector), then rerun: $0 start" >&2
    exit 1
  fi
  "${PSQL[@]}" -q -c "CREATE EXTENSION IF NOT EXISTS btree_gist;" >/dev/null
  local ver; ver="$("${PSQL[@]}" -tAc "SELECT extversion FROM pg_extension WHERE extname='vector'")"
  echo "ready: postgresql on 127.0.0.1:$PORT, pgvector $ver, database $DBNAME"
}

cmd_stop() {
  if is_running; then pg_ctl -D "$PGDATA" stop -m fast >/dev/null; echo "stopped"; else echo "not running"; fi
}

cmd_status() {
  if is_running; then
    echo "running on 127.0.0.1:$PORT"
    "${PSQL[@]}" -tAc "SELECT 'pgvector ' || extversion FROM pg_extension WHERE extname='vector'" 2>/dev/null || true
  else
    echo "not running (data dir: $PGDATA)"
  fi
}

cmd_reset() {
  cmd_stop || true
  rm -rf "$PGROOT"
  cmd_init
  cmd_start
}

# The database the test suite runs against when DATABASE_URL is not set. Kept
# separate from the development one because tests truncate every table.
TESTDB="${MP_TEST_DB:-memory_palace_test}"

cmd_testdb() {
  is_running || { echo "postgres is not running; run: $0 start" >&2; exit 1; }
  if psql -h 127.0.0.1 -p "$PORT" -U "$DBUSER" -d postgres -tAc \
       "SELECT 1 FROM pg_database WHERE datname='$TESTDB'" | grep -q 1; then
    echo "test database already exists: $TESTDB"
  else
    createdb -h 127.0.0.1 -p "$PORT" -U "$DBUSER" "$TESTDB"
    echo "created test database: $TESTDB"
  fi
  # The schema is the test database's own business, so migrate it here rather than
  # leaving the first `pnpm test` to fail on a missing table.
  DATABASE_URL="postgresql://$DBUSER@127.0.0.1:$PORT/$TESTDB" \
    pnpm migrate >/dev/null 2>&1 && echo "migrated $TESTDB"
  echo "run tests against it with: DATABASE_URL=postgresql://$DBUSER@127.0.0.1:$PORT/$TESTDB pnpm test"
}

case "${1:-}" in
  testdb) cmd_testdb ;;
  init)   cmd_init ;;
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  reset)  cmd_reset ;;
  psql)   shift; "${PSQL[@]}" "$@" ;;
  url)    echo "postgresql://$DBUSER@127.0.0.1:$PORT/$DBNAME" ;;
  *)
    cat <<EOF
usage: $0 {init|start|stop|status|reset|psql|url|testdb}

  init    initialise the cluster if missing
  start   start postgres, create the database and enable extensions
  stop    stop postgres
  status  show whether postgres is running
  reset   destroy and recreate the cluster (DESTROYS ALL MEMORY DATA)
  psql    open a psql shell (extra args are forwarded)
  url     print the DATABASE_URL for this cluster
  testdb  create the separate database the test suite uses

env: MP_PGPORT=$PORT MP_DB=$DBNAME MP_USER=$DBUSER MP_PG_BIN=${MP_PG_BIN:-auto}
EOF
    ;;
esac
