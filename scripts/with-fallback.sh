#!/usr/bin/env bash
# with-fallback.sh — production-grade model fallback wrapper (Track B).
#
# Wraps `opencode run` and retries with the next model in an agent's chain
# when the LLM call hits a rate limit / 5xx. Complements the in-plugin
# `next_model` tool by handling cases where the failure aborts the run
# before the agent can call the tool itself.
#
# Usage:
#   with-fallback.sh <agent-id> -- <opencode args>
#
# Example:
#   with-fallback.sh stage4-dev -- run --agent stage4-dev "Implement PROJ-12345"
#
# Reads model chain from the same model-router.ts via a tiny shim:
#   node $SCRIPT_DIR/../dist/model-chain-cli.js <agent-id>
# (the shim emits JSON: [{"id": "...", "variant": "..."}, ...])
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

AGENT="${1:?usage: with-fallback.sh <agent-id> -- <opencode args>}"
shift
[ "${1:-}" = "--" ] && shift || true

CHAIN_JSON="$(node "$SCRIPT_DIR/../dist/model-chain-cli.js" "$AGENT" 2>/dev/null || echo '[]')"
LEN=$(printf '%s' "$CHAIN_JSON" | jq 'length')

if [ "$LEN" -eq 0 ]; then
  echo "[with-fallback] no chain for $AGENT — running primary only" >&2
  exec opencode "$@"
fi

for i in $(seq 0 $((LEN - 1))); do
  MODEL=$(printf '%s' "$CHAIN_JSON" | jq -r ".[$i].id")
  echo "[with-fallback] attempt $((i+1))/$LEN with model=$MODEL" >&2

  # Inject --model. If user already passed --model, that wins (skip injection).
  if printf '%s\n' "$@" | grep -qE '^--model$|^--model='; then
    opencode "$@" && exit 0
  else
    opencode --model "$MODEL" "$@" && exit 0
  fi
  CODE=$?

  # Decide whether to retry. Treat 1 / 124 (timeout) / 137 (oom) as
  # retryable; SIGINT (130) and everything else as terminal so user cancel
  # or real errors are not masked.
  case "$CODE" in
    1|124|137) echo "[with-fallback] exit $CODE — trying next model" >&2 ;;
    *) echo "[with-fallback] exit $CODE — terminal, not retrying" >&2; exit "$CODE" ;;
  esac
done

echo "[with-fallback] chain exhausted for $AGENT" >&2
exit 1
