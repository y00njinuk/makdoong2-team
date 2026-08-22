#!/usr/bin/env bash
# publish-if-changed.sh - push 시점에 version 변경을 감지해 npm 공개 배포를 트리거
#
# 동작:
#   1. push 대상 커밋들 중 package.json version이 변경되었는지 확인
#   2. registry에 이미 해당 버전이 있으면 skip (release.sh 경유 push 재실행 대응)
#   3. 변경되었고 registry에 없으면 승인 게이트 2회 후 npm publish
#
# 호출 경로:
#   - .husky/pre-push 에서 stdin 으로 <local_ref> <local_sha> <remote_ref> <remote_sha> 4개씩 수신
#   - 직접 실행 시 HEAD~1..HEAD 범위로 검사
#
# 옵션:
#   HOOK_STDIN=1  stdin에서 git push ref 정보 읽기 (husky hook)
#   AUTO_YES=1    대화형 승인 스킵 (CI 전용)
#   SKIP_PUBLISH=1 감지 로직만 실행, publish 스킵 (테스트)

set -euo pipefail

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
BLUE=$'\033[0;34m'
CYAN=$'\033[0;36m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

log()    { printf "%s[auto-release]%s %s\n" "$CYAN" "$RESET" "$*"; }
info()   { printf "%s[info]%s          %s\n" "$BLUE" "$RESET" "$*"; }
ok()     { printf "%s[ok]%s            %s\n" "$GREEN" "$RESET" "$*"; }
warn()   { printf "%s[warn]%s          %s\n" "$YELLOW" "$RESET" "$*"; }
err()    { printf "%s[error]%s         %s\n" "$RED" "$RESET" "$*" >&2; }
prompt() { printf "%s[confirm]%s       %s" "$BOLD" "$RESET" "$*"; }

AUTO_YES="${AUTO_YES:-0}"
HOOK_STDIN="${HOOK_STDIN:-0}"
SKIP_PUBLISH="${SKIP_PUBLISH:-0}"

confirm() {
  local message="$1"
  if [ "$AUTO_YES" = "1" ]; then
    info "[AUTO_YES=1] 자동 승인: $message"
    return 0
  fi
  if [ ! -t 0 ] && [ ! -e /dev/tty ]; then
    err "TTY 없음 - 대화형 승인 불가. AUTO_YES=1 명시 필요."
    return 1
  fi
  local reply
  prompt "$message [y/N]: "
  read -r reply </dev/tty
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ---------- STEP 1: push 범위 파악 ----------
# husky pre-push는 stdin으로 4개 필드씩 여러 줄을 전달한다:
#   <local_ref> <local_sha> <remote_ref> <remote_sha>
# 새 브랜치의 경우 remote_sha가 0000...0000 (40 zeros)
push_ranges=()
if [ "$HOOK_STDIN" = "1" ]; then
  while IFS=' ' read -r local_ref local_sha remote_ref remote_sha; do
    [ -z "$local_sha" ] && continue
    [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue

    if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
      # 새 브랜치: 원격에 없는 모든 커밋
      range="$(git rev-list "$local_sha" --not --remotes | tr '\n' ' ')"
      [ -n "$range" ] && push_ranges+=("$remote_sha..$local_sha")
    else
      push_ranges+=("$remote_sha..$local_sha")
    fi
  done
else
  push_ranges+=("HEAD~1..HEAD")
fi

if [ ${#push_ranges[@]} -eq 0 ]; then
  info "push할 커밋 없음 - 릴리스 건너뜀"
  exit 0
fi

# ---------- STEP 2: version 변경 감지 ----------
version_changed=0
new_version=""
old_version=""

for range in "${push_ranges[@]}"; do
  # range 형식: <old_sha>..<new_sha>
  from_sha="${range%..*}"
  to_sha="${range#*..}"

  if ! git diff --name-only "$from_sha" "$to_sha" 2>/dev/null | grep -q '^package.json$'; then
    continue
  fi

  # package.json은 dependencies 변경으로도 diff에 잡히므로 version 필드만 별도 파싱하여 비교
  from_ver="$(git show "$from_sha:package.json" 2>/dev/null | node -e "
    let d=''; process.stdin.on('data', c=>d+=c).on('end', ()=>{
      try { console.log(JSON.parse(d).version || ''); } catch(e) { console.log(''); }
    });
  " 2>/dev/null || echo "")"
  to_ver="$(git show "$to_sha:package.json" 2>/dev/null | node -e "
    let d=''; process.stdin.on('data', c=>d+=c).on('end', ()=>{
      try { console.log(JSON.parse(d).version || ''); } catch(e) { console.log(''); }
    });
  " 2>/dev/null || echo "")"

  if [ -n "$to_ver" ] && [ "$from_ver" != "$to_ver" ]; then
    version_changed=1
    new_version="$to_ver"
    old_version="$from_ver"
    break
  fi
done

if [ "$version_changed" = "0" ]; then
  info "version 변경 없음 - 릴리스 건너뜀"
  exit 0
fi

log "=========================================="
log "버전 변경 감지: ${old_version:-<없음>} → $new_version"
log "=========================================="

# ---------- STEP 3: registry에 이미 배포되었는지 확인 ----------
# release.sh 로 이미 publish 후 push 하는 경우 중복 시도 방지
PACKAGE_NAME="$(node -p "require('./package.json').name")"
info "registry 확인 중: $PACKAGE_NAME@$new_version"

if npm view "${PACKAGE_NAME}@${new_version}" version >/dev/null 2>&1; then
  ok "registry에 이미 $new_version 존재 - 재-publish 건너뜀"
  info "(release.sh 로 이미 배포 후 push 하는 경우입니다)"
  exit 0
fi

info "registry에 $new_version 없음 - 배포 진행 필요"

# ---------- STEP 4: 승인 게이트 #1 (버전 확인) ----------
log "=========================================="
log "승인 게이트 #1: 버전 확인"
log "=========================================="

info "이 push에는 다음 버전 변경이 포함되어 있습니다:"
info "  ${old_version:-<없음>} → ${BOLD}${new_version}${RESET}"

if ! confirm "${BOLD}${YELLOW}이 버전을 공개 npm registry에 배포하시겠습니까?${RESET}"; then
  err "사용자가 배포를 거부함 - push 차단"
  err "이 버전을 배포하지 않으려면:"
  err "  1) package.json 의 version을 이전 값으로 되돌린 커밋을 추가"
  err "  2) 또는 git push --no-verify 로 hook 우회 (권장하지 않음)"
  exit 1
fi

# ---------- STEP 5: dry-run 검증 ----------
log "=========================================="
log "npm publish --dry-run 검증"
log "=========================================="

if ! npm publish --dry-run 2>&1 | tail -30; then
  err "Dry-run 실패 - 배포 중단, push 차단"
  exit 1
fi
ok "Dry-run 통과"

# ---------- STEP 6: 승인 게이트 #2 (돌이킬 수 없는 배포) ----------
log "=========================================="
log "승인 게이트 #2: npm 공개 배포 확인"
log "=========================================="

warn "이제 공개 npm registry (registry.npmjs.org) 에 $new_version 을(를) 배포합니다."
warn "배포 후에는 동일 버전 재-publish 가 registry에 의해 거부됩니다."
warn "돌이킬 수 없는 작업입니다."

if ! confirm "${BOLD}${RED}정말 공개 npm registry에 $new_version 을(를) 배포하시겠습니까?${RESET}"; then
  err "사용자가 최종 배포를 거부함 - push 차단"
  err "다시 시도하려면 git push 를 재실행하세요."
  exit 1
fi

# ---------- STEP 7: 실제 publish ----------
if [ "$SKIP_PUBLISH" = "1" ]; then
  warn "[SKIP_PUBLISH=1] publish 건너뜀 (테스트 모드)"
  exit 0
fi

log "=========================================="
log "npm publish 실행 → public npm registry"
log "=========================================="

if ! npm publish; then
  err "npm publish 실패 - push 차단"
  err "수동 확인 필요:"
  err "  - npm 로그인 상태 (npm whoami)"
  err "  - 동일 버전 중복 배포 여부"
  err "  - 문제 해결 후 git push 재실행"
  exit 1
fi

ok "${BOLD}${GREEN}npm 배포 완료: ${PACKAGE_NAME}@${new_version}${RESET}"
info "push를 계속 진행합니다..."
