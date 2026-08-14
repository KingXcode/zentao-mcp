#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "缺少 $SCRIPT_DIR/.env，请复制 .env.example 后填写配置。" >&2
  exit 1
fi

set -a
. "$SCRIPT_DIR/.env"
set +a

exec node "$SCRIPT_DIR/server.mjs"
