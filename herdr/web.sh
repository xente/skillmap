#!/bin/sh
# The web pane: serve the report for SKILLMAP_CWD live and open the browser.
dir="$(cd "$(dirname "$0")" && pwd)"
node "$dir/../bin/skillmap.mjs" "${SKILLMAP_CWD:-$PWD}" --watch --open --port "${SKILLMAP_PORT:-4317}" || {
  printf '\nPress Enter to close.'
  read -r _
}
