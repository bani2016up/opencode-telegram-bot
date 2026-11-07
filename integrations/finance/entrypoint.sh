#!/usr/bin/env bash
set -uo pipefail

/opt/prfnv-finance/venv/bin/python /opt/prfnv-finance/finance.py worker &
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
