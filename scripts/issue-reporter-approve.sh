#!/usr/bin/env bash
# issue-reporter-approve.sh — GitHub 게시 승인 (사용자 전용)
#
# makdoong2-issue-reporter 가 만든 payload 파일을 GitHub 에 게시하기 전에,
# 사용자가 게시될 "원문 전체"를 직접 확인하고 승인하는 스크립트다.
#
#   bash issue-reporter-approve.sh </absolute/path/issue-payload.json>
#
# 동작:
#   1. payload 원문 전체를 화면에 출력한다 (jq 가 있으면 title/labels/body 를
#      사람이 읽기 좋게 함께 렌더링하지만, 원문 전문 출력이 항상 우선한다).
#   2. stdin 으로 승인을 받는다 (scripts/lib/confirm.sh — /dev/tty 미사용).
#   3. 승인 시 payload 의 sha256 을 <payload>.approved 마커에 기록한다.
#
# 이 마커는 플러그인 tool.execute.before 훅의 게시 게이트가 검증한다:
#   - 마커 없음 / 해시 불일치(승인 후 내용 변경) → curl POST 차단
#   - 전송 실행 후 마커 자동 삭제 (승인은 1회용)
#
# 에이전트는 이 스크립트를 실행할 수 없다 (훅이 이름으로 차단). 반드시
# 사용자가 별도 셸 또는 세션의 shell 입력으로 직접 실행해야 한다.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/lib/confirm.sh"

err() { printf '[error] %s\n' "$*" >&2; }

PAYLOAD="${1:-}"
if [ -z "${PAYLOAD}" ]; then
  err "사용법: bash ${BASH_SOURCE[0]} </absolute/path/payload.json>"
  exit 1
fi
if [ ! -f "${PAYLOAD}" ]; then
  err "payload 파일이 없다: ${PAYLOAD}"
  exit 1
fi

MARKER="${PAYLOAD}.approved"

printf '\n'
printf '==================== 게시될 원문 (전문) ====================\n'
printf 'payload: %s\n' "${PAYLOAD}"
printf '%s\n' '------------------------------------------------------------'
cat -- "${PAYLOAD}"
printf '\n------------------------------------------------------------\n'

# jq 가 있고 JSON 이면 사람이 읽기 좋은 렌더링을 덧붙인다. 실패해도 무시 —
# 위의 원문 전문 출력이 승인 근거이고, 이 블록은 가독성 보조일 뿐이다.
if command -v jq >/dev/null 2>&1 && jq -e . "${PAYLOAD}" >/dev/null 2>&1; then
  if jq -e 'has("title") or has("body")' "${PAYLOAD}" >/dev/null 2>&1; then
    printf '읽기용 렌더링 (title / labels / body):\n'
    jq -r '"제목: \(.title // "<없음>")\n라벨: \((.labels // []) | join(", "))\n본문:\n\(.body // "<없음>")"' "${PAYLOAD}" 2>/dev/null || true
    printf '%s\n' '------------------------------------------------------------'
  fi
fi
printf '위 원문이 public GitHub 저장소에 그대로 게시된다.\n'
printf '사내 정보·자격 증명이 남아 있지 않은지 마지막으로 확인하라.\n\n'

_rc=0
confirm "이 원문 그대로 GitHub 에 게시하는 것을 승인하시겠습니까?" || _rc=$?
case "${_rc}" in
  0) ;;
  2)
    confirm_unavailable "bash ${BASH_SOURCE[0]} ${PAYLOAD}"
    exit 1
    ;;
  *)
    err "승인 거부됨. 마커를 만들지 않는다."
    exit 1
    ;;
esac

if command -v shasum >/dev/null 2>&1; then
  HASH="$(shasum -a 256 -- "${PAYLOAD}" | awk '{print $1}')"
else
  HASH="$(sha256sum -- "${PAYLOAD}" | awk '{print $1}')"
fi

{
  printf '%s\n' "${HASH}"
  printf '# approved-at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '# payload: %s\n' "${PAYLOAD}"
} > "${MARKER}"

printf '\n[ok] 승인 완료: %s\n' "${MARKER}"
printf '     이 승인은 1회용이며, payload 내용이 변경되면 무효가 된다.\n'
