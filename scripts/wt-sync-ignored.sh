#!/usr/bin/env bash
# wt-sync-ignored.sh <worktree-path> [issue]
#   메인 repo의 gitignore된(추적 안 되는) 파일을 새 worktree로 복사한다.
#   [issue]: 특정 이슈 스코프의 .makdoong2-team/<issue>/ 디렉토리만 복사 (다른 이슈 디렉토리는 제외).
#   .env, .env.local, .idea/, .metals/, .bsp/ 등 로컬 셋업 파일이
#   worktree마다 수동 복사되지 않도록 자동화한다.
#
#   기본 제외: 빌드 산출물·캐시 디렉토리(target/, build/, .gradle/, node_modules/, .venv/, .bloop/ 등).
#   워크트리마다 독립 빌드를 권장하므로 빌드 산출물은 복사하지 않는다.
#   추가 제외가 필요하면 makdoong2-team.json 의 worktree.extra_exclude 에 ':' 구분으로 지정.
#     예: "worktree": { "extra_exclude": ".idea/:tmp/" }
set -euo pipefail

# shellcheck source=lib/git-exclude.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/git-exclude.sh"

# --reverse: worktree → main repo 역방향 동기화 (issue-scoped .makdoong2-team/<issue>/ 만)
REVERSE=false
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --reverse) REVERSE=true; shift ;;
    *) echo "[wt-sync-ignored] 알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

WT="${1:?usage: $0 [--reverse] <worktree-path> [issue]}"
ISSUE="${2:-}"
[ -d "$WT" ] || { echo "[wt-sync-ignored] worktree 경로 없음: $WT" >&2; exit 1; }

# 메인 repo 식별 (worktree 안/밖 어디서 실행해도 동일)
MAIN="$(git -C "$WT" worktree list --porcelain 2>/dev/null | sed -n 's|^worktree ||p' | head -1)"
{ [ -n "$MAIN" ] && [ -d "$MAIN" ]; } || { echo "[wt-sync-ignored] 메인 repo 식별 실패" >&2; exit 1; }
if [ "$WT" = "$MAIN" ]; then
  echo "[wt-sync-ignored] worktree와 메인이 동일 경로 — 종료"
  exit 0
fi

# ── reverse 모드: worktree → main repo (issue-scoped) ─────────────────────────
if $REVERSE; then
  if [ -z "$ISSUE" ]; then
    echo "[wt-sync-ignored] --reverse 는 issue 인자 필수" >&2; exit 1
  fi
  SRC_DIR="$WT/.makdoong2-team/$ISSUE"
  DST_DIR="$MAIN/.makdoong2-team/$ISSUE"
  if [ -d "$SRC_DIR" ]; then
    mkdir -p "$DST_DIR"
    cp -a "$SRC_DIR/." "$DST_DIR/"
    r_count=$(find "$SRC_DIR" -type f | wc -l | tr -d ' ')
    echo "[wt-sync-ignored] reverse sync +${r_count} files: $WT → $MAIN (issue=$ISSUE)"
  else
    echo "[wt-sync-ignored] reverse sync: source 없음: $SRC_DIR" >&2
  fi
  exit 0
fi
# ─────────────────────────────────────────────────────────────────────────────

# 기본 제외 (디렉토리는 '/' 끝)
DEFAULT_EXCLUDES=(
  "target/" "build/" "out/" "dist/"
  "node_modules/" ".gradle/" ".venv/"
  "__pycache__/" ".pytest_cache/" ".mypy_cache/"
  ".bloop/" "project/target/" "project/project/"
)
EXCLUDES=("${DEFAULT_EXCLUDES[@]}")
EXTRA_EXCLUDE="$("$(cd "$(dirname "$0")" && pwd)/config.sh" get worktree.extra_exclude "")"
if [ -n "$EXTRA_EXCLUDE" ]; then
  IFS=':' read -ra extra <<< "$EXTRA_EXCLUDE"
  EXCLUDES+=("${extra[@]}")
fi

# 제외 패턴 매치 함수: 경로 $1 이 EXCLUDES 어느 하나에 걸리면 0(true)
is_excluded() {
  local f="$1" ex
  if [ -n "$ISSUE" ] && [[ "$f" == ".makdoong2-team/"* ]]; then
    return 0
  fi
  for ex in "${EXCLUDES[@]}"; do
    if [[ "${ex: -1}" == "/" ]]; then
      # 디렉토리 패턴: prefix 매치
      [[ "$f" == "$ex"* || "$f" == "${ex%/}" ]] && return 0
    else
      # 파일 패턴: 정확 일치 또는 경로 하위
      [[ "$f" == "$ex" || "$f" == "$ex/"* ]] && return 0
    fi
  done
  return 1
}

# 메인 repo의 gitignore된 파일/디렉토리 목록 (null-delimited)
copied=0; skipped=0
while IFS= read -r -d '' f; do
  if is_excluded "$f"; then
    skipped=$((skipped+1))
    continue
  fi
  src="$MAIN/$f"
  dst="$WT/$f"
  # f가 디렉토리로 끝나면(/) 통째로, 아니면 파일로 복사
  if [[ "${f: -1}" == "/" ]]; then
    mkdir -p "$dst"
    cp -a "$src." "$dst" 2>/dev/null || cp -a "$src" "$(dirname "$dst")/"
  else
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
  fi
  copied=$((copied+1))
done < <(cd "$MAIN" && git ls-files --others --ignored --exclude-standard -z)

echo "[wt-sync-ignored] 복사 $copied / 제외 $skipped (제외 패턴: ${EXCLUDES[*]})"
echo "[wt-sync-ignored] 소스: $MAIN"
echo "[wt-sync-ignored] 대상: $WT"

# issue-scoped whitelist
if [ -n "$ISSUE" ]; then
  wl_copied=0
  SRC_DIR="$MAIN/.makdoong2-team/$ISSUE"
  DST_DIR="$WT/.makdoong2-team/$ISSUE"
  if [ -d "$SRC_DIR" ]; then
    mkdir -p "$DST_DIR"
    cp -a "$SRC_DIR/." "$DST_DIR/"
    wl_copied=$(find "$SRC_DIR" -type f | wc -l | tr -d ' ')
  fi
  echo "[wt-sync-ignored] whitelist +$wl_copied (issue=$ISSUE)"
else
  echo "[wt-sync-ignored] whitelist skipped (issue 인자 없음)"
fi

# Baseline .git/info/exclude template — 프로젝트 종류를 감지해 부산물 패턴을 추가한다.
# .gitignore 파일 대신 git 공통 디렉토리의 info/exclude 에 기록하므로
# 모든 linked worktree 에 자동 적용되며 저장소에 커밋되지 않는다.
# publisher 의 stage7 entry gate 가 pytest 결과물 (.coverage, .pytest_cache/) 이나
# node_modules 부산물 때문에 false-positive 로 차단되는 문제를 예방.
# 이미 존재하는 라인은 skip 하여 사용자 편집을 덮어쓰지 않는다.
ensure_baseline_gitexclude() {
  local wt=$1
  local -a lines=()

  # 공통 (모든 프로젝트)
  # 플러그인 자신의 상태 디렉터리를 맨 앞에 둔다 — 이게 빠져 있으면 analysis verifier 가
  # 항상 REJECTED 를 낸다 (issue #6-②). state.sh init 에서도 등록하지만, 이미 state.json 이
  # 있어 init 의 등록 경로를 타지 않은 기존 워크플로우는 여기서 뒤늦게 구제된다.
  lines+=("${MAKDOONG2_STATE_DIR_PATTERN}")
  lines+=(".DS_Store" "Thumbs.db" "*.log" "*.swp")

  # Python
  if [ -f "$wt/pyproject.toml" ] || [ -f "$wt/requirements.txt" ] || [ -f "$wt/setup.py" ] || [ -f "$wt/setup.cfg" ]; then
    lines+=("__pycache__/" "*.pyc" "*.pyo" ".coverage" ".coverage.*" "htmlcov/" ".pytest_cache/" ".mypy_cache/" ".ruff_cache/" ".tox/" "*.egg-info/" "dist/" "build/" ".venv/" "venv/")
  fi

  # Node
  if [ -f "$wt/package.json" ]; then
    lines+=("node_modules/" ".npm/" ".pnp.*" ".yarn/*" "!.yarn/patches" "!.yarn/releases" "!.yarn/plugins" "!.yarn/sdks" "!.yarn/versions" ".next/" ".nuxt/" ".turbo/" "coverage/" ".nyc_output/")
  fi

  # JVM (Gradle/Maven/sbt)
  if [ -f "$wt/build.gradle" ] || [ -f "$wt/build.gradle.kts" ] || [ -f "$wt/pom.xml" ] || [ -f "$wt/build.sbt" ]; then
    lines+=("target/" "build/" ".gradle/" ".idea/" "*.iml" ".bloop/" ".metals/" ".bsp/" "project/target/" "project/project/")
  fi

  # Rust
  if [ -f "$wt/Cargo.toml" ]; then
    lines+=("target/" "Cargo.lock.bak")
  fi

  # Go
  if [ -f "$wt/go.mod" ]; then
    lines+=("vendor/" "*.test" "*.out")
  fi

  # append 는 공용 헬퍼가 한다 (git-common-dir 해석·중복 검사 포함).
  local added
  added="$(ensure_git_exclude_lines "$wt" "${lines[@]}")"
  if [ "$added" -gt 0 ]; then
    echo "[wt-sync-ignored] baseline .git/info/exclude +$added lines (project-type detected)"
  fi
}

ensure_baseline_gitexclude "$WT"
