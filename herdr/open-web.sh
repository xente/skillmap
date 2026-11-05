#!/bin/sh
# open-web: open the live Runtime view for the focused agent's folder. Each
# folder has its own `skillmap --watch` server on the first free port from
# 4317; if one already serves this folder, only the browser opens.
herdr_bin="${HERDR_BIN_PATH:-herdr}"
dir="$(cd "$(dirname "$0")" && pwd)"

cwd="${SKILLMAP_CWD:-}"
if [ -z "$cwd" ]; then
  IFS="$(printf '\037')" read -r _agent _session cwd _tab _live <<EOF2
$("$herdr_bin" pane list 2>/dev/null | node "$dir/focused.mjs")
EOF2
fi
cwd="${cwd:-$PWD}"

# a pinned port is the only one looked at; otherwise the range the server may have moved through
first="${SKILLMAP_PORT:-4317}"
last="${SKILLMAP_PORT:-$((first + 19))}"
p="$first"
while [ "$p" -le "$last" ]; do
  running="$(curl -fsS --max-time 1 "http://127.0.0.1:$p/__skillmap" 2>/dev/null)"
  case "$running" in
    *"\"root\":\"$cwd\""*)
      case "$(uname)" in Darwin) exec open "http://127.0.0.1:$p/" ;; *) exec xdg-open "http://127.0.0.1:$p/" ;; esac ;;
  esac
  p=$((p + 1))
done

if [ -n "$SKILLMAP_PORT" ]; then
  exec "$herdr_bin" plugin pane open --plugin skillmap --entrypoint web --placement tab \
    --env "SKILLMAP_CWD=$cwd" --env "SKILLMAP_PORT=$SKILLMAP_PORT"
fi
exec "$herdr_bin" plugin pane open --plugin skillmap --entrypoint web --placement tab --env "SKILLMAP_CWD=$cwd"
