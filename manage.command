#!/bin/sh
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '请先安装 Node.js 20 或更新版本：https://nodejs.org/'
  if [ -t 0 ]; then printf '%s' '按回车关闭。'; read -r zentao_input; fi
  exit 1
fi
node "$SCRIPT_DIR/scripts/manage-agents.mjs" "$@"
zentao_exit=$?
if [ "$zentao_exit" -ne 0 ] && [ -t 0 ]; then
  printf '%s' '启动失败，按回车关闭。'
  read -r zentao_input
fi
exit "$zentao_exit"
