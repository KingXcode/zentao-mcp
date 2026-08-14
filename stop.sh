#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER_PATH="$SCRIPT_DIR/server.mjs"
SERVER_PATTERN=$(printf '%s' "$SERVER_PATH" | sed 's/[][(){}.^$*+?|\\]/\\&/g')
MATCH_PATTERN="^([^[:space:]]*/)?[n]ode[[:space:]]+$SERVER_PATTERN$"

set +e
PIDS=$(/usr/bin/pgrep -f "$MATCH_PATTERN" 2>/dev/null)
PGREP_STATUS=$?
set -e

case "$PGREP_STATUS" in
  0) ;;
  1)
    echo "禅道 MCP 未运行。"
    exit 0
    ;;
  *)
    echo "无法查找禅道 MCP 进程。" >&2
    exit 1
    ;;
esac

STOPPED=0
for PID in $PIDS; do
  case "$PID" in
    ""|*[!0-9]*) continue ;;
  esac
  if kill -TERM "$PID" 2>/dev/null; then
    STOPPED=$((STOPPED + 1))
  fi
done

if [ "$STOPPED" -eq 0 ]; then
  echo "禅道 MCP 未运行。"
else
  echo "已向 $STOPPED 个禅道 MCP 实例发送停止信号。"
fi
