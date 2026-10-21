#!/usr/bin/env bash
# Create the server .env on first run — usage: bash scripts/init-server-env.sh <public-ip> [internal|public]
set -euo pipefail
cd "$(dirname "$0")/.."
IP="${1:?usage: bash scripts/init-server-env.sh <public-ip> [internal|public]}"
MODE="${2:-internal}"
if [ -f .env ]; then echo "[MeetFlow] .env already exists. Edit it directly to change values."; exit 0; fi
HOSTCODE="$(openssl rand -hex 5)"
umask 077
cat > .env <<ENV
# MeetFlow server .env (never share via git, email or chat)
PUBLIC_IP=${IP}
TLS_MODE=${MODE}
LIVEKIT_API_KEY=API$(openssl rand -hex 6)
LIVEKIT_API_SECRET=$(openssl rand -hex 24)
HOST_ACCESS_CODE=${HOSTCODE}
MAX_PARTICIPANTS=20
ROOM_TTL_HOURS=24
ENV
echo "[MeetFlow] .env created (TLS_MODE=${MODE}). Host code: ${HOSTCODE}"
