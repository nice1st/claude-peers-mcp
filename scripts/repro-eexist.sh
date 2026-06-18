#!/usr/bin/env bash
#
# repro-eexist.sh — claude-peers MCP 동시 기동 경합 재현 스크립트
#
# 증상: 한 머신에서 여러 Claude Code 세션을 동시에 띄우면 일부 세션에서
#       MCP 서버 기동 실패 (`error: Failed to link which: EEXIST`).
#
# 원인: 플러그인 start 스크립트가 매 기동마다 단일 공유 캐시에서 `bun install`을
#       실행한다. N개 세션이 동시에 같은 node_modules/.bin/ 심링크
#       (which 패키지의 node-which)를 생성하다 EEXIST 충돌이 난다.
#
# 이 스크립트는 그 경합을 재현하고, 직렬/번들 대조군과 비교한다.
#
# 사용: bash scripts/repro-eexist.sh [동시_프로세스_수]   (기본 10)
set -euo pipefail

N="${1:-10}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/peers-repro.XXXXXX)"
OUT="$WORK/out"
mkdir -p "$OUT"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "재현 작업 디렉토리: $WORK"
echo "동시 프로세스 수:   $N"
echo

# 실제 플러그인 캐시와 동일한 의존성 트리 구성 ---------------------------------
cat > "$WORK/package.json" <<'EOF'
{
  "name": "claude-peers-repro",
  "version": "0.0.0",
  "type": "module",
  "dependencies": { "@modelcontextprotocol/sdk": "^1.27.1" }
}
EOF

# lockfile 을 레포 것으로 복사해 실제와 트리 일치 (없으면 생략)
if [ -f "$REPO_ROOT/plugin/bun.lock" ]; then
  cp "$REPO_ROOT/plugin/bun.lock" "$WORK/bun.lock"
fi

# node_modules 를 미리 채운다 (= 캐시가 이미 워밍된 최선 상태에서 시작)
( cd "$WORK" && bun install --no-summary >/dev/null 2>&1 )
echo "node_modules 워밍 완료: $(ls "$WORK/node_modules" | wc -l | tr -d ' ') packages"
echo

count_eexist() {
  # $1: 출력 파일 디렉토리, 반환: EEXIST 가 난 프로세스 수
  # grep 은 매치 0건이면 종료코드 1 → set -e 회피 위해 || true
  { grep -l "EEXIST" "$1"/* 2>/dev/null || true; } | wc -l | tr -d ' '
}

run_concurrent() {
  # $1: 라벨, $2: bun install 추가 플래그
  local label="$1" flags="${2:-}"
  local dir="$OUT/$label"
  mkdir -p "$dir"
  local i
  for i in $(seq 1 "$N"); do
    ( cd "$WORK" && bun install --no-summary $flags >"$dir/$i" 2>&1 ) &
  done
  # 자식 install 일부가 EEXIST 로 죽어도(0 아닌 종료) 스크립트를 멈추지 않는다
  wait || true
  echo "$(count_eexist "$dir")"
}

# A) 동시 install (재현 본체) -------------------------------------------------
A_FAIL="$(run_concurrent concurrent || true)"

# B) 직렬 install (동시성 제거 대조군) ----------------------------------------
B_DIR="$OUT/serial"; mkdir -p "$B_DIR"
for i in $(seq 1 "$N"); do
  ( cd "$WORK" && bun install --no-summary >"$B_DIR/$i" 2>&1 ) || true
done
B_FAIL="$(count_eexist "$B_DIR")"

# C) 동시 install + --frozen-lockfile ----------------------------------------
C_FAIL="$(run_concurrent frozen --frozen-lockfile || true)"

# D) 현재 채택안: 번들 동시 기동 (install 없음) -------------------------------
# plugin/dist/server.js 를 node_modules 없는 격리 폴더에서 N개 동시 기동.
# install 이 안 도므로 EEXIST 가 0 이어야 한다 (회귀 검증).
D_FAIL="-"; D_ALIVE="-"
BUNDLE="$REPO_ROOT/plugin/dist/server.js"
if [ -f "$BUNDLE" ]; then
  BDIR="$WORK/bundle"; mkdir -p "$BDIR/dist"
  cp "$BUNDLE" "$BDIR/dist/server.js"
  D_FAIL=0; D_ALIVE=0
  for i in $(seq 1 "$N"); do
    ( cd "$BDIR" && bun dist/server.js >"$OUT/bundle_$i" 2>&1 & p=$!
      for _ in 1 2 3 4 5 6 7 8; do kill -0 $p 2>/dev/null && break; done
      if kill -0 $p 2>/dev/null; then echo ALIVE >"$OUT/bundle_stat_$i"; kill $p 2>/dev/null
      else echo DEAD >"$OUT/bundle_stat_$i"; fi ) &
  done
  wait || true
  for i in $(seq 1 "$N"); do
    grep -q ALIVE "$OUT/bundle_stat_$i" 2>/dev/null && D_ALIVE=$((D_ALIVE+1))
    grep -q EEXIST "$OUT/bundle_$i" 2>/dev/null && D_FAIL=$((D_FAIL+1))
  done
fi

echo "===== 결과 (EEXIST 발생 프로세스 / 전체 $N) ====="
printf "  A. 동시 install            : %s / %s\n" "$A_FAIL" "$N"
printf "  B. 직렬 install (대조군)   : %s / %s\n" "$B_FAIL" "$N"
printf "  C. 동시 + frozen-lockfile  : %s / %s\n" "$C_FAIL" "$N"
printf "  D. 번들 동시 기동 (채택안) : EEXIST %s / %s,  정상기동 %s / %s\n" "$D_FAIL" "$N" "$D_ALIVE" "$N"
echo
echo "해석:"
echo "  - B 가 0 이고 A 가 >0 이면, 동시성이 유일한 트리거임이 확인된다."
echo "  - C 가 여전히 >0 이면, lockfile 고정으로도 막을 수 없음을 뜻한다"
echo "    (install 이 도는 한 .bin 심링크 단계는 실행되므로)."
echo "  - D 가 0 이면, 기동 경로에서 install 을 제거한 번들 방식이 경합을 근절함을 뜻한다."
echo "  - 근본 해법은 기동 경로에서 bun install 을 제거하는 것 (번들링)."

# 비정상 종료 코드: A 에서 한 건도 재현 못 하면 환경 문제로 실패 처리
if [ "$A_FAIL" -eq 0 ]; then
  echo
  echo "경고: 동시 install 에서 EEXIST 를 재현하지 못했다. N 을 늘려 다시 시도해보라." >&2
  exit 1
fi
