#!/usr/bin/env bash
# release.sh - makdoong2-team npm 패키지 릴리스 자동화
#
# 사용법:
#   scripts/release.sh <patch|minor|major> [--yes]
#
# 워크플로우:
#   1. Pre-flight 체크 (git 상태, 브랜치, 원격 동기화)
#   2. 테스트 실행 (build + smoke + gate policy + install-lib)
#   3. 버전 bump 미리보기
#   4. **사용자 승인 게이트 #1** (버전 bump 확인)
#   5. npm version <bump> 실행 (커밋 + 태그 생성)
#   6. Publish 미리보기 (npm publish --dry-run)
#   7. **사용자 승인 게이트 #2** (npm 공개 배포 확인)
#   8. npm publish → public npm registry (registry.npmjs.org)
#   9. git push --follow-tags
#
# 옵션:
#   --yes: 모든 확인 프롬프트 자동 승인 (CI 전용, 대화형에서는 사용 금지)

set -euo pipefail

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
BLUE=$'\033[0;34m'
CYAN=$'\033[0;36m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

log()    { printf "%s[release]%s %s\n" "$CYAN" "$RESET" "$*"; }
info()   { printf "%s[info]%s    %s\n" "$BLUE" "$RESET" "$*"; }
ok()     { printf "%s[ok]%s      %s\n" "$GREEN" "$RESET" "$*"; }
warn()   { printf "%s[warn]%s    %s\n" "$YELLOW" "$RESET" "$*"; }
err()    { printf "%s[error]%s   %s\n" "$RED" "$RESET" "$*" >&2; }
prompt() { printf "%s[confirm]%s %s" "$BOLD" "$RESET" "$*"; }

# ---------- 인자 파싱 ----------
BUMP="${1:-}"
AUTO_YES=false

for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
  esac
done

if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  err "usage: $0 <patch|minor|major> [--yes]"
  err "  patch: 0.2.3 → 0.2.4 (버그 수정)"
  err "  minor: 0.2.3 → 0.3.0 (기능 추가, backward-compatible)"
  err "  major: 0.2.3 → 1.0.0 (breaking change)"
  exit 1
fi

# ---------- 프로젝트 루트 이동 ----------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

log "프로젝트 루트: $PROJECT_ROOT"
log "Bump 유형:    $BUMP"

# ---------- 사용자 확인 헬퍼 ----------
# confirm() 은 lib/confirm.sh 공용 구현을 쓴다. stdin 으로만 읽으므로 터미널이
# 없는 환경에서도 파이프로 승인을 전달할 수 있다:
#   printf 'y\ny\n' | npm run release:minor
# 반환값 2 는 "물어볼 수 없음" 으로, 거부(1)와 반드시 구별해서 처리한다.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/confirm.sh"

if [ "$AUTO_YES" = true ]; then
  CONFIRM_AUTO_YES=1
fi

# ---------- STEP 1: Pre-flight 체크 ----------
log "=========================================="
log "STEP 1: Pre-flight 체크"
log "=========================================="

# working tree clean 확인
if [ -n "$(git status --porcelain)" ]; then
  err "작업 디렉토리에 커밋되지 않은 변경사항이 있음:"
  git status --short
  err "먼저 변경사항을 커밋하거나 stash 하세요."
  exit 1
fi
ok "Working tree clean"

# 현재 브랜치 확인
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "master" ] && [ "$CURRENT_BRANCH" != "main" ]; then
  warn "현재 브랜치가 master/main이 아님: $CURRENT_BRANCH"
  _rc=0
  confirm "이 브랜치에서 릴리스를 진행하시겠습니까?" || _rc=$?
  case "${_rc}" in
    0) ;;
    2) confirm_unavailable "npm run release:${BUMP}"; exit 1 ;;
    *) err "사용자가 취소함"; exit 1 ;;
  esac
fi
ok "브랜치: $CURRENT_BRANCH"

# 원격과 동기화 확인
log "원격 저장소 fetch..."
git fetch origin --quiet
UPSTREAM="origin/$CURRENT_BRANCH"
if git rev-parse --verify "$UPSTREAM" >/dev/null 2>&1; then
  LOCAL="$(git rev-parse HEAD)"
  REMOTE="$(git rev-parse "$UPSTREAM")"
  BASE="$(git merge-base HEAD "$UPSTREAM")"

  if [ "$LOCAL" = "$REMOTE" ]; then
    ok "원격과 동기화됨"
  elif [ "$LOCAL" = "$BASE" ]; then
    err "로컬이 원격보다 뒤처져 있음. 먼저 pull 하세요."
    exit 1
  elif [ "$REMOTE" = "$BASE" ]; then
    info "로컬에 push되지 않은 커밋 있음 (release 후 함께 push됨)"
    git log --oneline "$UPSTREAM..HEAD"
  else
    err "로컬과 원격이 diverge됨. 먼저 정리하세요."
    exit 1
  fi
else
  warn "원격 브랜치 $UPSTREAM 없음 (새 브랜치)"
fi

# ---------- STEP 2: 테스트 실행 ----------
log "=========================================="
log "STEP 2: 전체 테스트 실행"
log "=========================================="
log "npm test 실행 중... (build + smoke + gate policy + install-lib)"

if ! npm test; then
  err "테스트 실패. 릴리스 중단."
  exit 1
fi
ok "모든 테스트 통과"

# ---------- STEP 3: 버전 bump 미리보기 ----------
log "=========================================="
log "STEP 3: 버전 bump 미리보기"
log "=========================================="

CURRENT_VERSION="$(node -p "require('./package.json').version")"
# 다음 버전 계산 (npm version --dry-run 대체)
NEXT_VERSION="$(node -e "
  const semver = '$CURRENT_VERSION'.split('.').map(Number);
  const bump = '$BUMP';
  if (bump === 'patch') semver[2]++;
  else if (bump === 'minor') { semver[1]++; semver[2] = 0; }
  else if (bump === 'major') { semver[0]++; semver[1] = 0; semver[2] = 0; }
  console.log(semver.join('.'));
")"

info "현재 버전: $CURRENT_VERSION"
info "다음 버전: $NEXT_VERSION"

# 변경 요약 출력
log "이번 릴리스에 포함될 커밋:"
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo '')"
if [ -n "$LAST_TAG" ]; then
  # `git log … | head -N` 을 쓰지 않는다. set -o pipefail 아래서 head 가 N 줄을
  # 읽고 먼저 종료하면 git 이 SIGPIPE(141)로 죽고, 그 코드가 파이프라인 전체의
  # 상태가 되어 errexit 가 **릴리스를 통째로 중단**시킨다. 커밋이 20개를 넘은
  # 적이 없어 지금까지 잠복해 있었고, 48개 릴리스에서 실제로 발화했다.
  # "1 파일 = 1 commit" 규약을 지키면 커밋 수는 앞으로도 쉽게 20을 넘는다.
  # 개수 제한은 git 에게 맡긴다 — 파이프가 없어지면 발화 조건 자체가 사라진다.
  COMMIT_TOTAL="$(git rev-list --count "${LAST_TAG}..HEAD")"
  git log --oneline -20 "${LAST_TAG}..HEAD"
  # `[ … ] && info …` 형태로 쓰지 않는다. 조건이 거짓이면 AND 리스트 전체가 1을
  # 반환하고 errexit 가 그 자리에서 스크립트를 끝낸다 (CLAUDE.md 게이트 사례와 동형).
  if [ "$COMMIT_TOTAL" -gt 20 ]; then
    info "... 외 $((COMMIT_TOTAL - 20))개 (총 ${COMMIT_TOTAL}개)"
  fi
else
  git log --oneline -10
fi

# ---------- STEP 4: 승인 게이트 #1 - 버전 bump ----------
log "=========================================="
log "STEP 4: 버전 bump 승인 (게이트 #1)"
log "=========================================="

_rc=0
confirm "${BOLD}${YELLOW}버전을 ${CURRENT_VERSION} → ${NEXT_VERSION} 로 올리시겠습니까?${RESET}" || _rc=$?
case "${_rc}" in
  0) ;;
  2) confirm_unavailable "npm run release:${BUMP}"; exit 1 ;;
  *) err "사용자가 버전 bump를 거부함. 릴리스 중단."; exit 1 ;;
esac

# ---------- STEP 5: 버전 bump 실행 ----------
log "=========================================="
log "STEP 5: npm version $BUMP 실행"
log "=========================================="

VERSION_OUTPUT="$(npm version "$BUMP")"
NEW_TAG="$VERSION_OUTPUT"
ok "버전 bump 완료: $NEW_TAG"
ok "커밋 및 태그 생성됨"

# rollback 함수 (publish 실패 시)
rollback_version() {
  err "롤백 중..."
  git tag -d "$NEW_TAG" 2>/dev/null || true
  git reset --hard HEAD~1
  warn "버전 bump 커밋 및 태그 롤백 완료. 현재 버전: $CURRENT_VERSION"
}

# ---------- STEP 6: Publish 미리보기 (dry-run) ----------
log "=========================================="
log "STEP 6: Publish 미리보기 (dry-run)"
log "=========================================="

info "npm publish --dry-run 실행..."
if ! npm publish --dry-run 2>&1 | tail -40; then
  err "Dry-run 실패. 롤백 필요."
  rollback_version
  exit 1
fi
ok "Dry-run 통과 - 패키지 구조 이상 없음"

# 패키지 크기 및 파일 수 표시
info "패키지 정보:"
node -e "
  const pkg = require('./package.json');
  console.log('  name:    ' + pkg.name);
  console.log('  version: ' + pkg.version);
  console.log('  target:  ' + (pkg.publishConfig?.registry || 'default'));
"

# ---------- STEP 7: 승인 게이트 #2 - npm 공개 배포 ----------
log "=========================================="
log "STEP 7: npm 공개 배포 승인 (게이트 #2)"
log "=========================================="

warn "이제 공개 npm registry (registry.npmjs.org) 에 $NEW_TAG 를 배포합니다."
warn "공개 배포이므로 누구나 설치할 수 있게 됩니다."
warn "배포 후에는 동일 버전 재-publish 가 registry에 의해 거부됩니다."
warn "돌이킬 수 없는 작업이므로 신중히 확인하세요."

_rc=0
confirm "${BOLD}${RED}공개 npm registry에 ${NEW_TAG} 를 배포하시겠습니까?${RESET}" || _rc=$?
if [ "${_rc}" -eq 2 ]; then
  # 버전 bump 는 이미 커밋·태그로 남아 있다. 여기서는 confirm_unavailable 의 일반
  # 안내(파이프로 승인 전달)를 쓰지 않는다 — 그 시점의 복구는 릴리스 재실행이 아니라
  # 이미 bump 된 버전을 배포하거나 되돌리는 것이고, npm publish 는 승인을 stdin 으로
  # 받지 않으므로 파이프 안내가 오히려 틀린 지시가 된다.
  err "최종 배포 승인을 받을 수 없다 — stdin 이 EOF 이거나 닫혀 있다."
  err "(거부당한 것이 아니라 물어볼 수단이 없었다)"
  warn "버전 bump는 유지됩니다 (${NEW_TAG})."
  info "배포하려면:   npm publish && git push origin HEAD --follow-tags"
  info "되돌리려면:   git tag -d ${NEW_TAG} && git reset --hard HEAD~1"
  info "처음부터 다시: 위에서 되돌린 뒤 printf 'y\\ny\\n' | npm run release:${BUMP}"
  exit 1
fi
if [ "${_rc}" -ne 0 ]; then
  warn "사용자가 배포를 거부함. 버전 bump는 유지됩니다."
  info "나중에 배포하려면: npm publish && git push origin HEAD --follow-tags"
  info "취소하려면: git tag -d ${NEW_TAG} && git reset --hard HEAD~1"
  exit 0
fi

# ---------- STEP 8: npm publish ----------
log "=========================================="
log "STEP 8: npm publish (공개 npm registry 배포)"
log "=========================================="

if ! npm publish; then
  err "npm publish 실패. 롤백 필요."
  err "수동 확인 필요:"
  err "  - npm 로그인 상태 (npm whoami)"
  err "  - 동일 버전 중복 배포 여부"
  err ""
  err "롤백 여부는 상황에 따라 결정하세요."
  err "  롤백:   git tag -d $NEW_TAG && git reset --hard HEAD~1"
  err "  재시도: npm publish"
  exit 1
fi
ok "npm 배포 완료: $NEW_TAG"

# ---------- STEP 9: git push ----------
log "=========================================="
log "STEP 9: git push --follow-tags"
log "=========================================="

if ! git push origin "$CURRENT_BRANCH" --follow-tags; then
  err "git push 실패. 수동으로 push 하세요:"
  err "  git push origin $CURRENT_BRANCH --follow-tags"
  exit 1
fi
ok "커밋 및 태그 원격 push 완료"

# ---------- 완료 ----------
log "=========================================="
ok "${BOLD}${GREEN}릴리스 완료: $NEW_TAG${RESET}"
log "=========================================="
info ""
info "다음 단계 (사용자 환경 업데이트):"
info "  npm install -g makdoong2-team@${NEXT_VERSION}"
info "  makdoong2-team install"
info ""
