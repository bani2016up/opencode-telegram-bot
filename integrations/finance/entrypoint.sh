#!/usr/bin/env bash
set -uo pipefail

if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3) )); then
  echo "The finance entrypoint requires Bash 4.3 or newer." >&2
  exit 1
fi

: "${FINANCE_CONFIG:?Set FINANCE_CONFIG to your finance configuration file.}"
finance_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 1
finance_python="${FINANCE_PYTHON:-$finance_directory/.venv/bin/python}"
if ! command -v "$finance_python" >/dev/null 2>&1; then
  echo "Create the finance .venv or set FINANCE_PYTHON to a Python executable." >&2
  exit 1
fi

"$finance_python" "$finance_directory/finance.py" worker &
finance_pid=$!
opencode "$@" &
agent_pid=$!

stop_children() {
  kill -TERM "$finance_pid" "$agent_pid" 2>/dev/null || true
  wait "$finance_pid" "$agent_pid" 2>/dev/null || true
}
trap 'stop_children; exit 0' TERM INT
wait -n "$finance_pid" "$agent_pid"
result=$?
stop_children
# If either service exits, restart the pair through Docker's restart policy.
exit "$result"
