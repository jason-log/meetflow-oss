#!/usr/bin/env sh
# MeetFlow v0.2 — 로컬 실행 (macOS / Linux / WSL)
# 처음 실행 시 .env 를 만들고 키·시크릿·호스트 코드를 난수로 채운다.
set -eu
umask 077 # .env 가 만들어지는 순간부터 소유자만 읽게
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  KEY="API$(openssl rand -hex 6)"
  SECRET="$(openssl rand -hex 24)"
  HOSTCODE="$(openssl rand -hex 5)"
  # 순서대로 __GENERATE__ 세 자리를 채운다
  awk -v k="$KEY" -v s="$SECRET" -v h="$HOSTCODE" '
    /^LIVEKIT_API_KEY=__GENERATE__/    { print "LIVEKIT_API_KEY=" k; next }
    /^LIVEKIT_API_SECRET=__GENERATE__/ { print "LIVEKIT_API_SECRET=" s; next }
    /^HOST_ACCESS_CODE=__GENERATE__/   { print "HOST_ACCESS_CODE=" h; next }
    { print }' .env > .env.tmp && mv .env.tmp .env
  chmod 600 .env
  echo "[MeetFlow] .env 생성 완료. 호스트 코드: $HOSTCODE  (회의 만들기 화면에서 사용)"
fi

docker compose up -d --build
echo "[MeetFlow] 상태 확인: docker compose ps  /  curl http://localhost:3000/api/health"
echo "[MeetFlow] 브라우저: http://localhost:3000"
