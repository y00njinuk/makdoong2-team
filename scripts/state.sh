#!/usr/bin/env bash
# state.sh — makdoong2-team workflow 상태 파일(state.json) read/write 헬퍼.
# 상태 파일 경로: <현재 컨텍스트 git toplevel>/.makdoong2-team/<issue>/state.json
# (main repo에서 호출: main repo, worktree에서 호출: worktree — 실행 컨텍스트 local)
#
# 사용:
#   state.sh root                                  # 현재 컨텍스트의 git toplevel 출력 (worktree-local)
#   state.sh issue                                 # 현재 브랜치에서 이슈키 추출 (없으면 빈 값)
#   state.sh init    <issue> [worktree]            # state.json 최초 생성 (이미 있으면 auto-migrate)
#   state.sh get     <issue> <jq-path>             # 값 조회. 예: '.stages."3_delivery".substages."commit".done'
#   state.sh set     <issue> <jq-path> <json-value># 값 설정. 문자열은 '"pass"' 형태로 전달
#   state.sh migrate <issue>                       # legacy stage key → 계층형 substages 이관 (idempotent)
#
# ── 스키마 규약 (hardrule) ──
# state.json 은 hierarchical 스키마다:
#   .stages."<PHASE>".substages."<SUBSTAGE>".<field>
# 예: .stages."1_planning".substages."requirements".done
#
# flat 표기 `.stages."<PHASE>.<SUBSTAGE>"` (예: `.stages."1_planning.requirements"`) 는
# phantom 키를 생성하여 verifier / auto_advance_stage 를 무력화한다. `set` 및 `get`
# 명령이 flat 표기를 감지하면 정확한 hierarchical 대체 경로를 안내하며 exit 65 로
# 즉시 중단한다. 예외: `.policy.*` 하위 딕셔너리 키는 flat 형태 (auto_approve.
# "1_planning.requirements": true) 를 유지한다 — opencode-plugin.ts 의 STAGE_ORDER
# 상수가 flat 스타일 stage-id 로 정의되어 있기 때문.
#
# 의존: jq
set -euo pipefail

root()  {
  # 호출 컨텍스트의 git toplevel 을 반환한다.
  # - main repo에서 호출: main repo 경로
  # - worktree에서 호출: 해당 worktree 경로
  # 각 실행 컨텍스트가 자신의 state.json 사본을 사용하므로
  # external-directory guard 가 발동하지 않는다.
  # sub-agent 세션 시작 전 wt-sync-ignored.sh 가 이미 .makdoong2-team/<issue>/
  # 를 worktree로 복사하고, 완료 후 --reverse 로 main repo에 병합한다.
  git rev-parse --show-toplevel 2>/dev/null \
    || pwd
}
issue() {
  # 현재 브랜치명에서 이슈키 추출. worktree(feature/PROJ-123) 컨텍스트에서만 신뢰성 있음.
  # main repo(branch=main)에서 호출하면 빈 문자열 반환 — hooks/guards 는 이 함수 대신
  # `root()` + `git worktree list --porcelain` 조합으로 ISSUE를 추출해야 한다.
  git rev-parse --abbrev-ref HEAD 2>/dev/null | grep -oE '[A-Z]+-[0-9]+' | head -n1 || true
}
sp()    { echo "$(root)/.makdoong2-team/$1/state.json"; }

# ── phantom-key guard ──
# jq path 안에 `.stages."<PHASE>.<SUBSTAGE>"` 형태 (dot 포함 stage-id 를 단일 키로
# 지정) 가 나타나면 flat 표기로 판정한다. hierarchical 표기는 dot 이 phase 밖으로
# 벗어나 있으므로 (`.stages."1_planning".substages."jira"`) 이 패턴에 매칭되지
# 않는다.
#
# 매칭되면 정확한 대체 경로를 안내하고 exit 65 로 즉시 실패한다.
check_flat_stage_notation() {
  local q="$1"
  if [[ "$q" =~ \.stages\.\"([0-9]+_[a-z_]+)\.([a-z]+)\" ]]; then
    local phase="${BASH_REMATCH[1]}"
    local sub="${BASH_REMATCH[2]}"
    local suggested=".stages.\"${phase}\".substages.\"${sub}\""
    cat >&2 <<ERR
[state.sh] flat stage notation detected — refusing to touch state.json.
  jq path : $q
  problem : ".stages.\"${phase}.${sub}\"" creates a phantom key that
            verifier / auto_advance_stage never read (they use hierarchical).
  fix     : replace with hierarchical form:
            $suggested
  legacy  : if you have existing flat/phantom nodes, run 'state.sh migrate <issue>'
            to normalize them into the hierarchical tree.
ERR
    exit 65
  fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  root)  root ;;
  issue) issue ;;
  init)
    ISSUE="${1:?issue required}"; WT="${2:-$(root)}"
    P="$(sp "$ISSUE")"; mkdir -p "$(dirname "$P")"
    if [ ! -f "$P" ]; then
      cat > "$P" <<JSON
{
  "issue": "$ISSUE",
  "worktree": "$WT",
  "stages": {
    "1_planning": {
      "done": false,
      "substages": {
        "jira":         {"done": false},
        "requirements": {"done": false, "approved_by_user": false},
        "scope":        {"done": false, "approved_by_user": false}
      }
    },
    "2_implementation": {
      "done": false,
      "substages": {
        "analysis": {
          "done": false,
          "skipped": false,
          "skip_reason": null,
          "artifact_path": null,
          "self_check": {}
        },
        "dev":  {"done": false},
        "test": {"done": false, "unit": "none", "integration": "none", "coverage": "none"}
      }
    },
    "3_delivery": {
      "done": false,
      "substages": {
        "commit": {"done": false},
        "pr":     {"draft_url": null},
        "review": {"comments": 0, "comments_per_commit": {}, "plan_path": null, "all_comments_inline": false}
      }
    }
  },
  "policy": null
}
JSON
    else
      "$0" migrate "$ISSUE" >/dev/null 2>&1 || true
    fi
    echo "$P" ;;
  get)
    ISSUE="${1:?}"; Q="${2:?}"; P="$(sp "$ISSUE")"
    check_flat_stage_notation "$Q"
    # Semantics contract (rely on this in all gate scripts):
    #   * always print exactly one line = the value (jq -r style: null/false/0/{}/"str")
    #   * exit 0 for any value that jq successfully evaluated, including null and false
    #   * exit 1 only when jq errored (bad expression, corrupt JSON) or file missing
    #
    # Rationale: the historical implementation used `jq -er` which conflates
    # "value is null/false" with "path missing" and emits both jq's own "null"
    # AND a fallback "null" (producing "null\nnull" for null values). Downstream
    # gates then wrap with `|| echo "__MISSING__"` and check `[ "$U" = "null" ]`
    # or `[ "$U" = "__MISSING__" ]`. Multi-line output breaks every such check.
    # Using `jq -r` (no -e) gives clean one-line output and success exit; the
    # `if` form suppresses `set -e` on parse errors so we can emit "null" as
    # missing-marker without doubling.
    if OUT="$(jq -r "$Q" "$P" 2>/dev/null)"; then
      printf '%s\n' "$OUT"
    else
      echo "null"; exit 1
    fi
    ;;
  set)
    ISSUE="${1:?}"; Q="${2:?}"; V="${3:?}"; P="$(sp "$ISSUE")"
    check_flat_stage_notation "$Q"
    tmp="$(mktemp)"; jq "$Q = $V" "$P" > "$tmp" && mv "$tmp" "$P"
    echo "state[$ISSUE] $Q = $V" ;;
  append)
    ISSUE="${1:?}"; Q="${2:?}"; V="${3:?}"; P="$(sp "$ISSUE")"
    check_flat_stage_notation "$Q"
    tmp="$(mktemp)"
    jq --argjson entry "$V" "$Q = ((($Q) // []) + [\$entry])" "$P" > "$tmp" && mv "$tmp" "$P"
    echo "state[$ISSUE] $Q += $V" ;;
  migrate)
    ISSUE="${1:?issue required}"; P="$(sp "$ISSUE")"
    [ -f "$P" ] || { echo "state.json not found: $P" >&2; exit 1; }
    tmp="$(mktemp)"
    jq '
      def move($legacy; $phase; $sub):
        if has("stages") and (.stages | has($legacy)) then
          .stages[$phase] = (.stages[$phase] // {"done": false, "substages": {}})
          | .stages[$phase].substages = (.stages[$phase].substages // {})
          | .stages[$phase].substages[$sub] =
              ((.stages[$phase].substages[$sub] // {}) * .stages[$legacy])
          | del(.stages[$legacy])
        else . end;

      move("1_jira";          "1_planning";       "jira")
      | move("2_requirements"; "1_planning";       "requirements")
      | move("3_scope";        "1_planning";       "scope")
      | move("4_dev";          "2_implementation"; "dev")
      | move("5_test";         "2_implementation"; "test")
      | move("6_commit";       "3_delivery";       "commit")
      | move("7_pr";           "3_delivery";       "pr")
      | move("8_review";       "3_delivery";       "review")
      | move("2_implementation.dev";  "2_implementation"; "dev")
      | move("2_implementation.test"; "2_implementation"; "test")
      | move("1_planning.jira";         "1_planning"; "jira")
      | move("1_planning.requirements"; "1_planning"; "requirements")
      | move("1_planning.scope";        "1_planning"; "scope")
      | move("3_delivery.commit";       "3_delivery"; "commit")
      | move("3_delivery.pr";           "3_delivery"; "pr")
      | move("3_delivery.review";       "3_delivery"; "review")
    ' "$P" > "$tmp" && mv "$tmp" "$P"
    echo "migrated[$ISSUE] $P" ;;
  *) echo "usage: state.sh {root|issue|init|get|set|append|migrate} ..." >&2; exit 64 ;;
esac
