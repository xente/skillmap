#!/bin/sh
# open-live: open the skillmap live pane beside the focused agent, pinned to its
# session. If a live pane is already open in this tab, close it (toggle).
herdr_bin="${HERDR_BIN_PATH:-herdr}"
dir="$(cd "$(dirname "$0")" && pwd)"

IFS="$(printf '\037')" read -r agent session cwd tab live <<EOF2
$("$herdr_bin" pane list 2>/dev/null | node "$dir/focused.mjs")
EOF2

if [ -n "$live" ]; then
  exec "$herdr_bin" pane close "$live"
fi
# no agent focused: the pane follows herdr's focus instead
exec "$herdr_bin" plugin pane open --plugin skillmap --entrypoint live \
  --placement split --direction right --focus \
  --env "SKILLMAP_AGENT=$agent" --env "SKILLMAP_SESSION=$session" --env "SKILLMAP_CWD=$cwd"
