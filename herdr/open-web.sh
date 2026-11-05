#!/bin/sh
# open-web: open the live Runtime view for the focused agent's folder. If
# `skillmap --watch` already serves it, only the browser opens.
herdr_bin="${HERDR_BIN_PATH:-herdr}"
dir="$(cd "$(dirname "$0")" && pwd)"
port="${SKILLMAP_PORT:-4317}"

cwd="${SKILLMAP_CWD:-}"
if [ -z "$cwd" ]; then
  IFS="$(printf '\037')" read -r _agent _session cwd _tab _live <<EOF2
$("$herdr_bin" pane list 2>/dev/null | node "$dir/focused.mjs")
EOF2
fi
cwd="${cwd:-$PWD}"

running="$(curl -fsS --max-time 1 "http://127.0.0.1:$port/__skillmap" 2>/dev/null)"
case "$running" in
  *"\"root\":\"$cwd\""*)
    case "$(uname)" in Darwin) exec open "http://127.0.0.1:$port/" ;; *) exec xdg-open "http://127.0.0.1:$port/" ;; esac ;;
esac
exec "$herdr_bin" plugin pane open --plugin skillmap --entrypoint web --placement tab \
  --env "SKILLMAP_CWD=$cwd" --env "SKILLMAP_PORT=$port"
