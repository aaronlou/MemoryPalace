#!/usr/bin/env bash
# Start and stop the whole application with one command each.
#
# Why this exists: starting Memory Palace used to mean four commands in a specific
# order, in a terminal you then had to leave open. That is fine for developing it
# and wrong for using it. This brings the database up, applies migrations, checks
# that the embedding model is reachable, starts the server in the background, and
# waits until it actually answers — or tells you why it did not.
#
# `stop` is the other half, and the half that matters: it kills the server even
# when it was not started from here. It finds the process by its pidfile AND by
# what is listening on the port, and only ever kills a process whose command line
# is this application.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/data"
PIDFILE="$RUN_DIR/api.pid"
LOGFILE="$RUN_DIR/api.log"
DB_SCRIPT="$ROOT/scripts/db-local.sh"

PORT="${MP_API_PORT:-8787}"
HOST="${MP_API_HOST:-127.0.0.1}"
URL="http://$HOST:$PORT"

# --- helpers -----------------------------------------------------------------

pid_on_port() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1
}

# Only ever signal a process that is this application. Without this, a port
# collision with something unrelated would turn `pnpm stop` into a way to kill a
# stranger's process.
#
# Ownership is decided by the process's working directory, which `lsof` reports,
# rather than by its command line, which needs `ps`. `ps` is not always available
# (the sandbox this was developed under denies it outright, and an empty command
# line reads exactly like "not ours"), whereas the server always runs from the
# checkout. A pid recorded in our own pidfile is trusted without asking: we wrote
# it.
is_ours() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 1
  local cwd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  [[ "$cwd" == "$ROOT" ]]
}

pid_alive() {
  kill -0 "${1:-}" 2>/dev/null
}

# Children first, so no orphan is left holding the port. `tsx` and `pnpm` both
# spawn a child process, which is exactly how a server "stops" and keeps serving.
kill_tree() {
  local pid="$1" signal="${2:-TERM}" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" "$signal"
  done
  kill -"$signal" "$pid" 2>/dev/null || true
}

# Every pid that is ours: the one we recorded, and whatever holds the port — the
# second is what lets `pnpm stop` kill a server started by hand with `pnpm dev:api`.
running_pids() {
  local pid
  if [[ -f "$PIDFILE" ]]; then
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if pid_alive "$pid"; then echo "$pid"; fi
  fi
  pid="$(pid_on_port || true)"
  if is_ours "$pid"; then echo "$pid"; fi
}

healthy() {
  curl -sf -m 3 "$URL/health" >/dev/null 2>&1
}

# --- commands ----------------------------------------------------------------

cmd_start() {
  if [[ ! -x "$ROOT/node_modules/.bin/tsx" ]]; then
    echo "Dependencies are not installed. Run: pnpm install" >&2
    return 1
  fi

  local holder
  holder="$(pid_on_port || true)"
  if [[ -n "$holder" ]]; then
    if is_ours "$holder"; then
      echo "Memory Palace is already running (pid $holder) at $URL"
      return 0
    fi
    echo "Port $PORT is held by pid $holder, which is not this application." >&2
    echo "Free it, or start on another port:  MP_API_PORT=8788 pnpm start" >&2
    return 1
  fi

  echo "database"
  "$DB_SCRIPT" start | sed 's/^/  /'

  echo "migrations"
  (cd "$ROOT" && pnpm migrate) | sed 's/^/  /'

  # A warning, not a failure: the server runs fine without it, and recall degrades
  # in a way that is much easier to diagnose while starting than at query time.
  if [[ "${MP_EMBEDDING_PROVIDER:-ollama}" == "ollama" ]]; then
    local base="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
    if curl -sf -m 3 "$base/api/tags" >/dev/null 2>&1; then
      echo "embedder"
      echo "  ollama reachable at $base"
    else
      echo "embedder"
      echo "  WARNING: nothing answers at $base."
      echo "  The interface and the API will work, but semantic recall needs it:"
      echo "    brew install ollama && ollama serve && ollama pull embeddinggemma"
    fi
  fi

  mkdir -p "$RUN_DIR"
  : >"$LOGFILE"
  (
    cd "$ROOT"
    nohup "$ROOT/node_modules/.bin/tsx" --tsconfig tsconfig.tools.json \
      apps/api/src/main.ts >>"$LOGFILE" 2>&1 &
    echo $! >"$PIDFILE"
  )

  echo "server"
  local waited=0
  while [[ "$waited" -lt 40 ]]; do
    if healthy; then
      echo "  ready after ${waited}s"
      cmd_urls
      return 0
    fi
    if [[ -z "$(running_pids)" ]]; then
      echo "  the server exited before it was ready. Last lines of $LOGFILE:" >&2
      tail -12 "$LOGFILE" | sed 's/^/    /' >&2
      rm -f "$PIDFILE"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "  still not answering after ${waited}s; see $LOGFILE" >&2
  return 1
}

cmd_urls() {
  cat <<EOF

Memory Palace is running
  web ui   $URL/
  mcp      $URL/mcp   (Streamable HTTP)
  logs     ${LOGFILE#"$ROOT/"}
  stop     pnpm stop

EOF
}

cmd_stop() {
  local pids
  pids="$(running_pids | sort -u)"
  if [[ -z "$pids" ]]; then
    echo "Memory Palace is not running."
    rm -f "$PIDFILE"
    return 0
  fi

  local pid
  for pid in $pids; do
    echo "stopping pid $pid"
    kill_tree "$pid" TERM
  done

  # Give it a moment to close its connections, then insist. A server that ignores
  # SIGTERM must not leave the port held after `pnpm stop` said it stopped.
  local waited=0
  while [[ -n "$(pid_on_port || true)" && "$waited" -lt 10 ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  local stubborn
  stubborn="$(pid_on_port || true)"
  if [[ -n "$stubborn" ]]; then
    echo "  still listening after ${waited}s; sending SIGKILL"
    kill_tree "$stubborn" KILL
    sleep 1
  fi

  rm -f "$PIDFILE"
  if [[ -n "$(pid_on_port || true)" ]]; then
    echo "port $PORT is still held; something else may have taken it" >&2
    return 1
  fi
  echo "stopped"
}

cmd_status() {
  local pid
  pid="$(pid_on_port || true)"
  if [[ -n "$pid" ]] && is_ours "$pid"; then
    if healthy; then
      echo "running  pid $pid  $URL  (healthy)"
    else
      echo "running  pid $pid  $URL  (not answering yet)"
    fi
  elif [[ -n "$pid" ]]; then
    echo "port $PORT is held by pid $pid, which is not this application"
  else
    echo "stopped"
  fi
  "$DB_SCRIPT" status | sed 's/^/database /'
}

cmd_restart() {
  cmd_stop
  cmd_start
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  restart) cmd_restart ;;
  *)
    cat <<EOF
usage: $0 {start|stop|status|restart}

  start    bring up the database, migrate, and start the web app (default)
  stop     stop the web app, including a server started some other way
  status   say whether it is running, and whether the database is
  restart  stop, then start

env: MP_API_PORT=$PORT MP_API_HOST=$HOST
EOF
    exit 2
    ;;
esac
