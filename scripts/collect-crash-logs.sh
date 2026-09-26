#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# Collects the logs of the newest VS Code session on macOS into one file on the Desktop, to find out why an extension
# host crashed (for example while connecting to a container). Run it right after the crash, before VS Code restarts:
#   bash scripts/collect-crash-logs.sh
# The file can contain repository names and local paths; look through it before you share it.
set -u

logs="$HOME/Library/Application Support/Code/logs"
if [ ! -d "$logs" ]; then
  echo "No VS Code logs folder at $logs" >&2
  exit 1
fi
session="$logs/$(ls -t "$logs" | head -n 1)"
out="$HOME/Desktop/devenv-crash-$(date +%Y%m%d-%H%M%S).txt"

section() {
  local title="$1" file="$2" lines="$3"
  echo "== $title"
  if [ -f "$file" ]; then tail -n "$lines" "$file"; else echo "(missing)"; fi
  echo
}

{
  echo "== session: $session"
  echo
  section "main.log" "$session/main.log" 80
  for window in "$session"/window*; do
    [ -d "$window" ] || continue
    name="$(basename "$window")"
    section "$name/renderer.log" "$window/renderer.log" 80
    section "$name/exthost/exthost.log" "$window/exthost/exthost.log" 150
    find "$window" -name '*Dev Environments*.log' -print0 | while IFS= read -r -d '' file; do
      section "${file#"$session"/}" "$file" 150
    done
    find "$window" -name '*Dev Containers*.log' -print0 | while IFS= read -r -d '' file; do
      section "${file#"$session"/}" "$file" 80
    done
  done
  echo "== crash reports of Code Helper (last 24 hours)"
  find "$HOME/Library/Logs/DiagnosticReports" -name 'Code Helper*' -mtime -1 -print0 2>/dev/null |
    while IFS= read -r -d '' file; do
      section "$(basename "$file")" "$file" 60
    done
} > "$out" 2>&1

echo "written: $out"
