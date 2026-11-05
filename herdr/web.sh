#!/bin/sh
# The web pane: serve the report for SKILLMAP_CWD live and open the browser.
# The port is the first free one from 4317 unless SKILLMAP_PORT pins it.
dir="$(cd "$(dirname "$0")" && pwd)"
node "$dir/../bin/skillmap.mjs" "${SKILLMAP_CWD:-$PWD}" --watch --open ${SKILLMAP_PORT:+--port "$SKILLMAP_PORT"} || {
  printf '\nPress Enter to close.'
  read -r _
}
