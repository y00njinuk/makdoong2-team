# git-exclude.sh — `.git/info/exclude` 에 패턴을 등록하는 공용 헬퍼.
# source 전용 (직접 실행하지 않는다).
#
# ── 배경 (issue #6-②) ──
# 플러그인은 자기 상태를 작업 트리 안(`.makdoong2-team/`)에 만들면서 git exclude 에는
# 등록하지 않았다. 그래서 그 패턴이 `.gitignore` 에도 `.git/info/exclude` 에도 없는
# 저장소에서는 `git status --porcelain` 이 항상 `?? .makdoong2-team/` 를 보고했고,
# "git status 청결" 을 요구하는 `2_implementation.analysis` verifier 가 **항상
# REJECTED** 를 냈다 (산출물·마커는 전부 정상인데도).
#
# 더 나쁜 것은 그 시점에 exclude 를 고칠 권한을 가진 역할이 파이프라인에 없다는 점이다:
#   - analyzer  : write 권한이 산출물 1개로 제한
#   - team-leader: 하드룰 2 훅이 bash 파일 쓰기를 차단
#   - engineer  : `2_implementation.dev` 단계라 analysis 를 통과해야 도달
# 결국 동일 사유 REJECTED 가 무한 반복되고 사용자가 직접 한 줄을 넣어야 풀렸다.
#
# ── 왜 wt-sync-ignored.sh 의 ensure_baseline_gitexclude() 만으로는 부족한가 ──
# 그 함수는 **worktree 생성(= dev 진입) 시점에만** 돈다. plugin 의 wt-sync 호출은
# 전부 `DEV_OR_LATER_STAGES` / `worktree !== cwd` 로 가드되어 있다. analysis 는
# 그보다 앞선 main repo 단계라 그때는 한 번도 실행되지 않았다. 그래서 상태 디렉터리를
# **처음 만드는** `state.sh init` 에서도 등록한다.
#
# `.git/info/exclude` 는 커밋되지 않는 로컬 파일이라 대상 저장소의 이력을 건드리지 않는다.
# worktree 의 `--git-common-dir` 은 main repo 의 `.git` 을 가리키므로 한 번 등록하면
# main repo 와 모든 worktree 가 함께 적용받는다.

# 플러그인이 작업 트리 안에 만드는 자기 상태 디렉터리. 이 상수가 유일한 출처다.
MAKDOONG2_STATE_DIR_PATTERN=".makdoong2-team/"

# ensure_git_exclude_lines <repo-dir> <pattern>...
#   없는 라인만 append 한다. 추가한 개수를 stdout 으로 출력한다.
#   git 저장소가 아니거나 파일을 쓸 수 없으면 0 을 출력하고 **성공으로 끝낸다** —
#   호출부(state.sh init 등)는 `set -e` 아래에서 돌고, exclude 등록 실패가
#   워크플로우 시작 자체를 막아서는 안 된다.
ensure_git_exclude_lines() {
  local dir=$1
  shift || true
  [ "$#" -gt 0 ] || { echo 0; return 0; }

  local common
  common="$(git -C "${dir}" rev-parse --git-common-dir 2>/dev/null)" || { echo 0; return 0; }
  [ -n "${common}" ] || { echo 0; return 0; }
  if [[ "${common}" != /* ]]; then
    common="$(cd "${dir}/${common}" 2>/dev/null && pwd -P)" || { echo 0; return 0; }
    [ -n "${common}" ] || { echo 0; return 0; }
  fi

  local file="${common}/info/exclude"
  mkdir -p "${common}/info" 2>/dev/null || { echo 0; return 0; }
  touch "${file}" 2>/dev/null || { echo 0; return 0; }

  local added=0 ln
  for ln in "$@"; do
    [ -n "${ln}" ] || continue
    if ! grep -qxF -- "${ln}" "${file}" 2>/dev/null; then
      printf '%s\n' "${ln}" >> "${file}" 2>/dev/null && added=$((added + 1))
    fi
  done
  echo "${added}"
}
