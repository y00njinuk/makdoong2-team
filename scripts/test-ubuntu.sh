#!/usr/bin/env bash
# test-ubuntu.sh — run the test suite inside the Ubuntu image the plugin targets.
#
# 사용법:
#   scripts/test-ubuntu.sh                 # npm test 전체 실행
#   scripts/test-ubuntu.sh npm run build   # 임의 명령 실행
#   scripts/test-ubuntu.sh bash            # 컨테이너 셸 진입 (디버깅)
#
# 왜 필요한가:
#   플러그인은 Ubuntu 에서 개발·운영되지만 테스트는 macOS 에서도 자주 돌린다.
#   두 환경은 libc ctype 테이블, /var 심볼릭 링크, bash 3.2 vs 5.x 에서 갈리며
#   실제로 이 세 가지가 모두 테스트 실패로 나타난 적이 있다. 이 스크립트는
#   Linux 쪽 결과를 어느 호스트에서든 재현할 수 있게 한다.
#
# 동작:
#   - 저장소를 /w 에 bind-mount 한다.
#   - node_modules 는 호스트의 .docker-test/node_modules 를 겹쳐 mount 한다.
#     (macOS 용 node_modules 를 덮어쓰지 않기 위함 — 네이티브 바이너리가 다르다)
#   - 호스트 uid 를 담은 /etc/passwd 를 만들어 넣는다. 이게 없으면 os.homedir()
#     가 HOME 미설정 시 getpwuid 폴백에서 ENOENT 로 죽어 실제 Ubuntu 장비에서는
#     나지 않는 실패가 발생한다 (test/config-dir-home-fallback.test.mjs).
#   - package-lock.json 이 바뀐 경우에만 npm ci 를 다시 돌린다.
#   - 호스트 uid/gid 로 실행해 root 소유 파일이 생기지 않게 한다.
#
# 정리(cleanup):
#   - 컨테이너는 `docker run --rm` 으로 종료 즉시 제거된다.
#   - docker 데몬(OrbStack/colima VM)이 꺼져 있어서 이 스크립트가 직접 기동한
#     경우에만 끝날 때 다시 끈다. 이미 떠 있었다면 사용자의 다른 작업을 끊지
#     않도록 그대로 둔다. MAKDOONG2_KEEP_DOCKER=1 로 자동 종료를 끌 수 있다.
#
# 주의: dist/ 는 mount 된 저장소 안에 다시 빌드된다. tsc 산출물은 플랫폼
#       독립적이므로 macOS 빌드와 내용이 같다.
set -euo pipefail

IMAGE="${MAKDOONG2_TEST_IMAGE:-makdoong2-team-test:ubuntu-24.04}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="$ROOT/.docker-test"
MODULES="$WORKDIR/node_modules"
PASSWD="$WORKDIR/passwd"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; CYAN=$'\033[0;36m'; RESET=$'\033[0m'
log()  { printf "%s[test-ubuntu]%s %s\n" "$CYAN" "$RESET" "$*"; }
warn() { printf "%s[warn]%s        %s\n" "$YELLOW" "$RESET" "$*"; }
err()  { printf "%s[error]%s       %s\n" "$RED" "$RESET" "$*" >&2; }

# ---------- docker 데몬 준비 ----------
STARTED_DAEMON=0
DAEMON_KIND=""

wait_for_daemon() {
  local i
  for i in $(seq 1 40); do
    docker info >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

cleanup() {
  local status=$?
  # 컨테이너는 --rm 이 이미 지웠다. 여기서는 "우리가 켠 것"만 되돌린다.
  if [ "$STARTED_DAEMON" = "1" ]; then
    if [ "${MAKDOONG2_KEEP_DOCKER:-0}" = "1" ]; then
      log "MAKDOONG2_KEEP_DOCKER=1 — $DAEMON_KIND 를 켠 채로 둔다"
    else
      log "$DAEMON_KIND 종료 (이 스크립트가 기동했으므로 원상복구)"
      case "$DAEMON_KIND" in
        orbstack) orb stop    >/dev/null 2>&1 || warn "orb stop 실패 — 수동으로 'orb stop'" ;;
        colima)   colima stop >/dev/null 2>&1 || warn "colima stop 실패 — 수동으로 'colima stop'" ;;
      esac
    fi
  fi
  return "$status"
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  err "docker 를 찾을 수 없다. Docker / OrbStack / colima 중 하나가 필요하다."
  exit 1
fi

if docker info >/dev/null 2>&1; then
  log "docker 데몬 이미 실행 중 — 종료하지 않고 그대로 둔다"
else
  if command -v orb >/dev/null 2>&1; then
    DAEMON_KIND="orbstack"; log "docker 데몬이 꺼져 있다 — OrbStack 기동"; orb start >/dev/null 2>&1 || true
  elif command -v colima >/dev/null 2>&1; then
    DAEMON_KIND="colima";   log "docker 데몬이 꺼져 있다 — colima 기동";   colima start >/dev/null 2>&1 || true
  else
    err "docker 데몬에 연결할 수 없고 자동 기동 수단(orb/colima)도 없다. Docker Desktop 을 먼저 실행하라."
    exit 1
  fi

  wait_for_daemon
  if ! docker info >/dev/null 2>&1; then
    err "$DAEMON_KIND 기동 후에도 docker 데몬에 연결할 수 없다."
    exit 1
  fi
  STARTED_DAEMON=1        # 여기서부터 cleanup 이 되돌릴 책임을 진다
  log "$DAEMON_KIND 기동 완료 — 테스트 종료 시 자동으로 다시 끈다"
fi

# ---------- 이미지 + 마운트 준비 ----------
log "이미지 빌드: $IMAGE"
docker build --quiet -f "$ROOT/Dockerfile.test" -t "$IMAGE" "$ROOT" >/dev/null

mkdir -p "$MODULES"

# 컨테이너 안에서 호스트 uid 가 실재하는 사용자로 보이도록 최소 passwd 를 만든다.
{
  echo "root:x:0:0:root:/root:/bin/bash"
  echo "tester:x:$(id -u):$(id -g):tester:/tmp:/bin/bash"
} > "$PASSWD"

# 컨테이너 안에서 실행할 명령. 인자가 없으면 전체 테스트.
if [ "$#" -eq 0 ]; then
  INNER_CMD="npm test"
else
  INNER_CMD="$(printf '%q ' "$@")"
fi

# ---------- 실행 ----------
# 데몬이 기동/종료 전환 중이면 docker info 가 일시적으로 성공한 뒤 컨테이너가
# SIGKILL(137) 로 죽을 수 있다. 이 스크립트가 끝날 때 데몬을 끄므로 연속 실행에서
# 실제로 걸릴 수 있는 경로다. 전환 계열 종료코드에 한해 1회만 재시도한다.
run_container() {
  docker run --rm -t \
  -v "$ROOT:/w" \
  -v "$MODULES:/w/node_modules" \
  -v "$PASSWD:/etc/passwd:ro" \
  -w /w \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e npm_config_cache=/tmp/.npm \
  -e npm_config_update_notifier=false \
  -e CI=true \
  -e MAKDOONG2_IN_TEST_CONTAINER=1 \
  "$IMAGE" \
  bash -euo pipefail -c '
    git config --global --add safe.directory /w
    git config --global user.email "test@makdoong2.local"
    git config --global user.name  "makdoong2 test"

    # package-lock.json 이 바뀌었을 때만 npm ci. 해시를 node_modules 안에 남긴다.
    LOCK_HASH="$(sha256sum package-lock.json | cut -d" " -f1)"
    STAMP="node_modules/.lock-hash"
    if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$LOCK_HASH" ]; then
      echo "[test-ubuntu] npm ci (lockfile 변경 감지)"
      npm ci --no-audit --no-fund
      printf "%s" "$LOCK_HASH" > "$STAMP"
    else
      echo "[test-ubuntu] node_modules 재사용 (lockfile 변경 없음)"
    fi

    echo "[test-ubuntu] node $(node -v) | bash $(bash --version | head -1 | sed "s/.*version //;s/ .*//") | tmux $(tmux -V | cut -d" " -f2) | LANG=$LANG"
    '"$INNER_CMD"'
  '
}

log "실행: $INNER_CMD"
STATUS=0
run_container || STATUS=$?

if { [ "$STATUS" -eq 137 ] || [ "$STATUS" -eq 125 ]; }; then
  warn "컨테이너가 exit $STATUS 로 종료됐다 (docker 데몬 전환 중일 가능성). 준비 상태 재확인 후 1회 재시도."
  if wait_for_daemon; then
    STATUS=0
    run_container || STATUS=$?
  else
    err "docker 데몬에 다시 연결할 수 없다."
  fi
fi

if [ "$STATUS" -eq 0 ]; then
  printf "%s[test-ubuntu]%s %sUbuntu 실행 성공%s\n" "$CYAN" "$RESET" "$GREEN" "$RESET"
else
  err "Ubuntu 실행 실패 (exit $STATUS)"
fi
exit "$STATUS"
