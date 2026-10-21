#!/usr/bin/env sh
# MeetFlow v0.2 — run locally (macOS / Linux / WSL)
# On first run, create .env and fill the key, secret and host code with random values.
set -eu
umask 077 # .env is readable only by its owner from the moment it is created
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  KEY="API$(openssl rand -hex 6)"
  SECRET="$(openssl rand -hex 24)"
  HOSTCODE="$(openssl rand -hex 5)"
  # fill the three __GENERATE__ placeholders
  awk -v k="$KEY" -v s="$SECRET" -v h="$HOSTCODE" '
    /^LIVEKIT_API_KEY=__GENERATE__/    { print "LIVEKIT_API_KEY=" k; next }
    /^LIVEKIT_API_SECRET=__GENERATE__/ { print "LIVEKIT_API_SECRET=" s; next }
    /^HOST_ACCESS_CODE=__GENERATE__/   { print "HOST_ACCESS_CODE=" h; next }
    { print }' .env > .env.tmp && mv .env.tmp .env
  chmod 600 .env
  echo "[MeetFlow] .env created. Host code: $HOSTCODE  (enter it on the create-meeting screen)"
fi

docker compose up -d --build
echo "[MeetFlow] status: docker compose ps  /  curl http://localhost:3000/api/health"
echo "[MeetFlow] open in browser: http://localhost:3000"
