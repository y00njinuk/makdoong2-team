#!/usr/bin/env bash
# config.sh — shell-side reader for makdoong2-team.json (mirror of src/config.ts).
#
# All makdoong2-team settings live in ONE JSON file; gates/hooks read values
# from here instead of environment variables.
#
#   config.sh path                        # absolute path to makdoong2-team.json
#   config.sh dir                         # npm module root directory
#   config.sh get <dotted.key> [default]  # echo value (or default if missing/null)
#
# pkg_root() returns the npm module root by resolving the script's location.
# This ensures the script works correctly regardless of installation path.
#
# Note: `get` returns the default for null/false (jq `//`), so it is intended
# for scalar string/number keys (coverage.threshold, worktree.extra_exclude).
# Boolean toggles (tmux.enabled) are consumed by the TS plugin, not the shell.
#
# 의존: jq
set -euo pipefail

pkg_root() {
  # Resolve script location and return parent directory (npm module root)
  # Script is at <pkg>/scripts/config.sh, so dirname twice gives <pkg>
  dirname "$(dirname "$(readlink -f "$0")")"
}

config_dir() {
  pkg_root
}

CFG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/makdoong2-team.json"

cmd="${1:-}"; shift || true
case "$cmd" in
  dir)  config_dir ;;
  path) echo "$CFG" ;;
  get)
    KEY="${1:?usage: config.sh get <dotted.key> [default]}"; DEF="${2:-}"
    if [ -f "$CFG" ]; then
      v="$(jq -r ".$KEY // empty" "$CFG" 2>/dev/null || true)"
      if [ -n "$v" ]; then echo "$v"; else echo "$DEF"; fi
    else
      echo "$DEF"
    fi ;;
  *) echo "usage: config.sh {get <dotted.key> [default]|dir|path}" >&2; exit 64 ;;
esac
