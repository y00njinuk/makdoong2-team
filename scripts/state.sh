#!/usr/bin/env bash
# state.sh — makdoong2-team workflow 상태 파일(state.json) read/write 헬퍼.
# 상태 파일 경로: <현재 컨텍스트 git toplevel>/.makdoong2-team/<issue>/state.json
# (main repo에서 호출: main repo, worktree에서 호출: worktree — 실행 컨텍스트 local)
#
# 사용:
#   state.sh root                                  # 현재 컨텍스트의 git toplevel 출력 (worktree-local)
#   state.sh issue                                 # 현재 브랜치에서 이슈키 추출 (없으면 빈 값)
#   state.sh init    <issue> [worktree]            # state.json 최초 생성 (이미 있으면 auto-migrate)
#   state.sh status  <issue>                       # 존재/유효성/스키마 진단 (읽기 전용, exit 0=정상)
#   state.sh get     <issue> <jq-path>             # 값 조회. 예: '.stages."3_delivery".substages."commit".done'
#   state.sh set     <issue> <jq-path> <json-value># 값 설정. 문자열은 '"pass"' 형태로 전달
#   state.sh append  <issue> <jq-path> <json-value># 배열 끝에 항목 추가 (없으면 [] 로 시작)
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

# 플러그인 자기 상태 디렉터리를 git exclude 에 등록하기 위한 공용 헬퍼 (issue #6-②).
# shellcheck source=lib/git-exclude.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/git-exclude.sh"

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
# 이슈 키는 경로에 그대로 들어간다. LLM 이 만든 값이 올 수 있으므로 디렉터리
# 구분자와 상위 참조를 거부한다 — 종전에는 검증이 없어 `state.sh set '../../x' …`
# 으로 저장소 밖에 쓰거나 읽을 수 있었다.
validate_issue() {
  case "$1" in
    ""|*/*|*\\*) echo "state.sh: 이슈 키에 경로 구분자를 쓸 수 없다: '$1'" >&2; exit 65 ;;
    .|..|*..*)   echo "state.sh: 이슈 키에 상위 디렉터리 참조를 쓸 수 없다: '$1'" >&2; exit 65 ;;
  esac
}

sp()    { validate_issue "$1"; echo "$(root)/.makdoong2-team/$1/state.json"; }

# ── 사본 불일치 경고 ────────────────────────────────────────────────────────
# state.json 사본은 cwd(git toplevel)마다 하나씩이다. 전용 worktree 가 이미 있는데
# main repo cwd 에서 `set` 을 실행하면, 갱신되는 것은 main 사본이고 dispatch_stage /
# 게이트가 보는 것은 worktree 사본이다 — 쓴 사람은 반영됐다고 믿는데 파이프라인은
# 옛 값을 본다. 실제로 REJECTED 재작업 규약(`.done=false` 재설정)이 이 경로에서
# 두 번 연속 `already_done: true` 오차단으로 되돌아왔고, 오류 문구도 원인을 알려주지
# 않아 같은 실수가 반복됐다 (issue #11).
#
# 쓰기 자체는 막지 않는다 — main 사본을 고치는 것이 옳은 상황도 있다. 어느 사본을
# 건드렸는지 stderr 로 알리기만 한다 (stdout 계약·종료 코드 불변).
norm_path() { if [ -d "$1" ]; then (cd "$1" && pwd -P); else printf '%s' "$1"; fi; }

warn_if_copy_split() {
  local file="$1" here there
  [ -f "${file}" ] || return 0
  there="$(jq -r '.worktree // ""' "${file}" 2>/dev/null || true)"
  { [ -n "${there}" ] && [ "${there}" != "null" ] && [ -d "${there}" ]; } || return 0
  here="$(norm_path "$(root)")"
  there="$(norm_path "${there}")"
  [ "${here}" != "${there}" ] || return 0
  cat >&2 <<WARN
[state.sh] 경고: 지금 갱신한 것은 이 cwd 의 사본이지, 이 이슈의 전용 worktree 사본이 아니다.
  갱신한 사본 : ${here}
  worktree    : ${there}
  state.json 사본은 cwd(git toplevel)마다 하나씩이고, dispatch_stage 와 dev 이후 게이트는
  worktree 사본을 본다. 자동 동기화(wt-sync-ignored.sh)는 서브에이전트 세션 앞뒤에서만 돌므로
  이 쓰기는 다음 dispatch 까지 worktree 사본에 반영되지 않을 수 있다.
  의도한 것이 worktree 사본이면 그 경로를 cwd 로 하여 다시 실행한다.
WARN
}

# usage_die <시그니처> [부연 설명...]
# `${2:?}` 가 뱉는 raw bash 에러(`line 127: 2: parameter null or not set`)는 복구
# 작업 중인 에이전트에게 아무것도 알려주지 못한다. 대신 무엇을 어떻게 부를지 적는다.
usage_die() {
  echo "usage: state.sh $1" >&2
  shift
  local line
  for line in "$@"; do echo "  ${line}" >&2; done
  exit 64
}

# ── 원자적 JSON 쓰기 ────────────────────────────────────────────────────────
# write_json_atomic <대상경로> <설명> <jq 인자...>
#
# 왜 헬퍼인가: 종전 세 곳(set/append/migrate)이 전부 아래 형태였다.
#
#     tmp="$(mktemp)"; jq "$Q = $V" "$P" > "$tmp" && mv "$tmp" "$P"
#     echo "state[$ISSUE] $Q = $V"
#
# 이것은 두 가지로 조용히 실패한다.
#
#  1) **jq 실패가 은폐된다.** `set -e` 는 `&&` 리스트의 왼쪽 피연산자 실패를
#     면제하므로, state.json 이 없거나 $V 가 잘못된 JSON 이면 jq 가 죽어도
#     스크립트는 계속 진행해 **성공 메시지를 찍고 exit 0** 한다. 호출자(게이트·
#     서브에이전트)는 마커가 기록됐다고 믿고 다음 단계로 넘어가지만 파일은
#     그대로다 — issue #6-① 이 정확히 이 부류의 정지였다.
#  2) **mv 가 원자적이지 않을 수 있다.** `mktemp` 는 $TMPDIR(보통 /tmp)에
#     만드는데, Ubuntu 24.04+ 는 /tmp 가 tmpfs 이고 WSL2 는 저장소가 /mnt/c 일
#     수 있다. 파일시스템이 다르면 `mv` 는 rename(2) 가 아니라 copy+unlink 라
#     중간에 죽으면 state.json 이 잘린 채 남는다.
#
# 그래서 (a) 대상 파일 존재·JSON 유효성을 먼저 확인하고, (b) 임시 파일을
# **대상과 같은 디렉터리**에 만들고, (c) jq 종료코드를 명시적으로 검사하고,
# (d) 결과가 비어 있지 않은 유효 JSON 일 때만 교체한다.
write_json_atomic() {
  local target="$1"; shift
  local what="$1"; shift

  if [ ! -f "${target}" ]; then
    echo "state.sh: state.json 없음: ${target}" >&2
    echo "  복구: bash <SCRIPTS_DIR>/state.sh init <이슈키>" >&2
    return 1
  fi
  if ! jq -e . "${target}" >/dev/null 2>&1; then
    echo "state.sh: state.json 이 유효한 JSON 이 아니다: ${target}" >&2
    echo "  파일 부재가 아니라 손상이다 — 자동 복구하지 않는다. 사용자에게 에스컬레이션하라." >&2
    return 1
  fi

  # 임시 파일을 대상과 같은 디렉터리에 만들어 mv 가 같은 파일시스템 안의
  # rename(2) 이 되게 한다.
  local dir tmp rc
  dir="$(dirname "${target}")"
  tmp="$(mktemp "${dir}/.state.json.XXXXXX")" || {
    echo "state.sh: 임시 파일 생성 실패 (${dir})" >&2
    return 1
  }

  rc=0
  jq "$@" "${target}" > "${tmp}" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    rm -f "${tmp}"
    echo "state.sh: ${what} 실패 — jq exit ${rc} (state.json 은 변경되지 않았다)" >&2
    return 1
  fi
  if [ ! -s "${tmp}" ] || ! jq -e . "${tmp}" >/dev/null 2>&1; then
    rm -f "${tmp}"
    echo "state.sh: ${what} 실패 — jq 결과가 비었거나 유효한 JSON 이 아니다 (state.json 은 변경되지 않았다)" >&2
    return 1
  fi

  mv "${tmp}" "${target}"
}

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
    # 상태 디렉터리를 만드는 바로 그 자리에서 git exclude 에 등록한다. 여기서 하지
    # 않으면 `git status` 가 플러그인 자신의 파일을 보고하고, "git status 청결" 을
    # 요구하는 2_implementation.analysis verifier 가 항상 REJECTED 를 낸다 (issue #6-②).
    # 이 시점(main repo)은 worktree 생성 전이라 wt-sync-ignored.sh 가 아직 돌지 않는다.
    ADDED_EXCLUDE="$(ensure_git_exclude_lines "$(root)" "${MAKDOONG2_STATE_DIR_PATTERN}")"
    [ "${ADDED_EXCLUDE}" = "0" ] || echo "[state.sh] .git/info/exclude += ${MAKDOONG2_STATE_DIR_PATTERN}" >&2
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
        "requirements": {"done": false, "approved_by_user": false}
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
  status)
    # 승인된 읽기 전용 진단. state_unreadable 복구 절차의 1단계다 (ARCHITECTURE.md §5.5).
    # stdout 은 key=value 한 줄씩 — 에이전트가 파싱하기 쉽고 사람이 읽을 수도 있다.
    # exit 0 = 존재 && 판독 가능, exit 1 = 그 외 (어느 쪽인지는 exists/readable 이 말한다).
    ISSUE="${1:-}"
    [ -n "${ISSUE}" ] || usage_die "status <issue>" \
      "예: state.sh status PROJ-12345" \
      "출력: path / exists / readable / issue / worktree / phantom_keys / next"
    SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
    P="$(sp "${ISSUE}")"
    echo "path=${P}"
    if [ ! -f "${P}" ]; then
      echo "exists=false"
      echo "readable=false"
      echo "next=bash ${SELF_DIR}/wt-sync-ignored.sh $(root) ${ISSUE}  # worktree 동기화 누락이면"
      echo "next=bash ${SELF_DIR}/state.sh init ${ISSUE} $(root)  # 신규 생성이면"
      exit 1
    fi
    echo "exists=true"
    if ! jq empty "${P}" 2>/dev/null; then
      echo "readable=false"
      echo "next=JSON 이 손상되었습니다. 자동 복구하지 말고 사용자에게 에스컬레이션하세요."
      exit 1
    fi
    echo "readable=true"
    echo "issue=$(jq -r '.issue // "null"' "${P}")"
    echo "worktree=$(jq -r '.worktree // "null"' "${P}")"
    echo "stages=$(jq -r '(.stages // {}) | keys | join(",") // "none"' "${P}")"
    PHANTOM="$(jq -r '[(.stages // {}) | keys[] | select(test("\\."))] | join(",")' "${P}")"
    echo "phantom_keys=${PHANTOM:-none}"
    if [ -n "${PHANTOM}" ]; then
      echo "next=bash ${SELF_DIR}/state.sh migrate ${ISSUE}  # flat/phantom 키 정규화"
    fi
    ;;
  get)
    ISSUE="${1:-}"; Q="${2:-}"
    [ -n "${ISSUE}" ] && [ -n "${Q}" ] || usage_die "get <issue> <jq-path>" \
      "예: state.sh get PROJ-1 '.stages.\"1_planning\".substages.\"jira\".done'" \
      "파일 존재·유효성 확인은 state.sh status <issue> 를 쓴다."
    P="$(sp "${ISSUE}")"
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
      # stdout 계약(정확히 한 줄 "null" + exit 1)은 그대로 두고, 원인만 stderr 로
      # 알린다. 종전에는 "파일 부재" 와 "jq 경로 오류" 가 똑같이 null 로만 보여서
      # 복구 작업 중인 에이전트가 어느 쪽인지 알 수 없었다.
      if [ ! -f "${P}" ]; then
        echo "[state.sh] state.json 없음: ${P} — 'state.sh status ${ISSUE}' 로 확인하세요." >&2
      else
        echo "[state.sh] jq 평가 실패 (경로 오류 또는 JSON 손상): ${Q}" >&2
      fi
      echo "null"; exit 1
    fi
    ;;
  set)
    ISSUE="${1:-}"; Q="${2:-}"; V="${3:-}"
    [ -n "${ISSUE}" ] && [ -n "${Q}" ] && [ -n "${V}" ] || usage_die "set <issue> <jq-path> <json-value>" \
      "예: state.sh set PROJ-1 '.stages.\"1_planning\".substages.\"jira\".done' true" \
      "문자열 값은 '\"pass\"' 처럼 JSON 리터럴로 전달한다."
    P="$(sp "${ISSUE}")"
    check_flat_stage_notation "$Q"
    write_json_atomic "$P" "set ${Q}" "$Q = $V"
    warn_if_copy_split "$P"
    echo "state[$ISSUE] $Q = $V" ;;
  append)
    ISSUE="${1:-}"; Q="${2:-}"; V="${3:-}"
    [ -n "${ISSUE}" ] && [ -n "${Q}" ] && [ -n "${V}" ] || usage_die "append <issue> <jq-path> <json-value>" \
      "예: state.sh append PROJ-1 '.stages.\"2_implementation\".substages.\"dev\".hang_history' '{\"at\":\"…\"}'"
    P="$(sp "${ISSUE}")"
    check_flat_stage_notation "$Q"
    write_json_atomic "$P" "append ${Q}" --argjson entry "$V" "$Q = ((($Q) // []) + [\$entry])"
    echo "state[$ISSUE] $Q += $V" ;;
  migrate)
    ISSUE="${1:?issue required}"; P="$(sp "$ISSUE")"
    [ -f "$P" ] || { echo "state.json not found: $P" >&2; exit 1; }
    write_json_atomic "$P" "migrate" '
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

      # scope substage 흡수 (범위 확정 → requirements).
      # 진행 중이던 워크플로우가 남긴 scope 마커를 버리지 않고 requirements 로
      # 접는다. done / approved_by_user 는 **AND** 로 접는다 — scope 가 아직
      # 끝나지 않았는데 requirements 만 보고 통과시키면, 흡수 전이라면 막혔을
      # 지점을 마이그레이션이 열어주는 셈이 된다. 접은 뒤 scope 키는 지운다.
      | (if (.stages."1_planning".substages? // {} | has("scope")) then
             .stages."1_planning".substages.requirements =
               ((.stages."1_planning".substages.requirements // {})
                 + {"done": ((.stages."1_planning".substages.requirements.done // false)
                             and (.stages."1_planning".substages.scope.done // false)),
                    "approved_by_user":
                      ((.stages."1_planning".substages.requirements.approved_by_user // false)
                       and (.stages."1_planning".substages.scope.approved_by_user // false))})
           | del(.stages."1_planning".substages.scope)
         else . end)
      # auto_approve 는 flat 표기를 유지하는 유일한 예외라 여기서 같이 옮긴다.
      | (if (.policy.auto_approve? // {} | has("1_planning.scope")) then
             .policy.auto_approve = (.policy.auto_approve
               | ."1_planning.requirements" =
                   ((."1_planning.requirements" // false) and ."1_planning.scope")
               | del(."1_planning.scope"))
         else . end)
    '
    echo "migrated[$ISSUE] $P" ;;
  *) echo "usage: state.sh {root|issue|init|status|get|set|append|migrate} ..." >&2; exit 64 ;;
esac
