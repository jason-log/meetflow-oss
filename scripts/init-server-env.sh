#!/usr/bin/env bash
# MeetFlow 운영 서버 .env 최초 생성 — 사용: bash scripts/init-server-env.sh <공인IP> [internal|public]
set -euo pipefail
cd "$(dirname "$0")/.."
IP="${1:?사용: bash scripts/init-server-env.sh <공인IP> [internal|public]}"
MODE="${2:-internal}"
if [ -f .env ]; then echo "[MeetFlow] .env 가 이미 있습니다. 바꾸려면 직접 편집하세요."; exit 0; fi
HOSTCODE="$(openssl rand -hex 5)"
umask 077
cat > .env <<ENV
# MeetFlow 운영 .env (git·메일·메신저 공유 금지)
PUBLIC_IP=${IP}
TLS_MODE=${MODE}
LIVEKIT_API_KEY=API$(openssl rand -hex 6)
LIVEKIT_API_SECRET=$(openssl rand -hex 24)
HOST_ACCESS_CODE=${HOSTCODE}
MAX_PARTICIPANTS=20
ROOM_TTL_HOURS=24
ENV
echo "[MeetFlow] .env 생성 완료 (TLS_MODE=${MODE}). 호스트 코드: ${HOSTCODE}"
