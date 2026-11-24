#!/bin/sh
set -u

launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
# Finder and file managers may start without the terminal's PATH.
PATH="$PATH:$HOME/.local/bin:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin"
export PATH

code=1
if command -v node >/dev/null 2>&1; then
  node "$launcher_dir/tavern.mjs" "$1"
  code=$?
else
  printf '%s\n' '找不到 Node.js。请先安装 Node.js 22.19 或更新版本。' >&2
fi

if [ "${2:-}" = '--pause' ] && [ -t 0 ]; then
  printf '\n按回车键关闭此窗口…'
  IFS= read -r unused || :
fi
exit "$code"
