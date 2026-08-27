#!/usr/bin/env bash
# lib/confirm.sh — 릴리스 승인 프롬프트 공용 구현 (release.sh / publish-if-changed.sh 공유).
#
# 왜 stdin 만 쓰는가:
#   이전 구현은 `read -r reply </dev/tty` 였다. git pre-push 훅은 stdin 으로 ref
#   정보를 받으므로 훅 안에서 프롬프트하려면 /dev/tty 가 필요했고, release.sh 가
#   그 패턴을 그대로 복사했다. 그런데 제어 터미널이 없는 환경(에이전트 셸,
#   컨테이너, CI)에서는 /dev/tty 열기 자체가 실패한다 — macOS 는 "Device not
#   configured", Linux 는 "No such device or address". 그 결과 릴리스가 그 환경에서
#   아예 불가능했다.
#
#   더 나쁜 것은 실패가 조용했다는 점이다. read 가 실패해도 reply 는 빈 값이라
#   case 가 `*` 로 떨어져 "거부" 로 처리됐고, 호출부는 "사용자가 거부함" 을 찍었다.
#   물어보지도 못한 것과 거부당한 것이 구별되지 않아 진짜 원인이 은폐됐다.
#
#   `[ ! -e /dev/tty ]` 가드도 틀렸다. 존재와 열 수 있음은 다르다 — macOS 에서는
#   /dev/tty 가 존재하지만 열리지 않으므로 가드를 통과한 뒤 똑같이 실패했다.
#
# 그래서 /dev/tty 를 버리고 stdin 으로 통일했다. 터미널에서는 stdin 이 곧 터미널이라
# 종전과 동일하게 동작하고, 터미널이 없으면 파이프로 승인을 전달할 수 있다:
#   printf 'y\ny\n' | npm run release:minor
#
# 반환값 (2 를 1 과 반드시 구별해서 처리할 것):
#   0  승인 (y / yes)
#   1  거부 (그 외 응답)
#   2  물어볼 수 없음 — stdin 이 EOF 이거나 닫혀 있다
#
# CONFIRM_AUTO_YES=1 이면 프롬프트 없이 승인한다 (CI 전용).

# 색상은 호출부가 정의했으면 그대로 쓰고, 아니면 빈 문자열로 둔다.
_confirm_bold="${BOLD:-}"
_confirm_reset="${RESET:-}"

_confirm_err() { printf "%s\n" "$*" >&2; }

# confirm <메시지>
confirm() {
  local message="$1"

  if [ "${CONFIRM_AUTO_YES:-0}" = "1" ]; then
    printf "%s[confirm]%s %s -> 자동 승인 (CONFIRM_AUTO_YES=1)\n" \
      "${_confirm_bold}" "${_confirm_reset}" "${message}"
    return 0
  fi

  local reply=""
  printf "%s[confirm]%s %s [y/N]: " "${_confirm_bold}" "${_confirm_reset}" "${message}"

  # read 실패 = EOF. 승인 거부(빈 응답)와 구별해야 하므로 종료 코드를 나눈다.
  if ! IFS= read -r reply; then
    printf "\n"
    return 2
  fi

  case "${reply}" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# confirm 이 2 를 반환했을 때 호출한다. 무엇이 막혔고 어떻게 푸는지 안내한다.
# <컨텍스트> 는 재실행할 명령 (예: "npm run release:minor").
confirm_unavailable() {
  local context="${1:-<명령>}"
  _confirm_err ""
  _confirm_err "[error]   승인 입력을 받을 수 없다 — stdin 이 EOF 이거나 닫혀 있다."
  _confirm_err "          (거부당한 것이 아니라 물어볼 수단이 없었다)"
  _confirm_err ""
  _confirm_err "  해결 방법:"
  _confirm_err "    1) 대화형 터미널에서 실행한다"
  _confirm_err "    2) 승인을 파이프로 전달한다:"
  _confirm_err "         printf 'y\\ny\\n' | ${context}"
  _confirm_err "    3) CI 라면 자동 승인을 명시한다 (CI 전용):"
  _confirm_err "         release.sh  -> --yes"
  _confirm_err "         pre-push 훅 -> AUTO_YES=1"
  _confirm_err ""
}
