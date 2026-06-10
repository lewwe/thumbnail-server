#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
LOG_FILE="${TMPDIR:-/tmp}/thumbnail-server.log"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js saknas. Installera Node och prova igen."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm saknas. Installera Node/npm och prova igen."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installerar dependencies..."
  npm install
fi

echo "Startar thumbnail-server pa port ${PORT}..."
npm start >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "Vantar pa att servern startar..."
for _ in {1..80}; do
  if curl -fsS "$URL" >/dev/null 2>&1; then
    echo "Oppnar UI: $URL"
    open "$URL"
    break
  fi

  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "Servern stoppades innan den hann starta."
    echo "--- Senaste logg ---"
    tail -n 40 "$LOG_FILE" || true
    exit 1
  fi

  sleep 0.25
done

if ! curl -fsS "$URL" >/dev/null 2>&1; then
  echo "Kunde inte bekrafta server pa $URL inom tidsgransen."
  echo "Du kan oppna sidan manuellt nar den ar redo."
fi

echo "Servern kor. Loggfil: $LOG_FILE"
echo "Tryck Ctrl+C for att stoppa servern."
wait "$SERVER_PID"
