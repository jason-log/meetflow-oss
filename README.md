# MeetFlow _(meetflow-oss)_

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node 22](https://img.shields.io/badge/node-22-339933)
![LiveKit 1.13](https://img.shields.io/badge/LiveKit-1.13-1f2937)
![Status: PoC](https://img.shields.io/badge/status-PoC-orange)

**Self-hosted video meetings for small groups (up to 20 people).** Guests join with an invite link and a meeting password — no accounts, no app install. Try it on a laptop with one command, then deploy it to your own server with Docker Compose.

![Host view — a shared screen shown large, with participants and chat on the right](docs/screenshot-share.jpg)

> **Status: proof of concept.** Tested in real meetings with 10+ people joining at once, but not hardened for large-scale or long-term production use. Please read [Limitations](#limitations) first.
>
> **UI language:** the web interface is currently in **Korean only**. The docs and configuration are in English.

## Why MeetFlow

- **Guests need nothing but a browser.** Send a link and a password; external participants join from Chrome or Edge, on desktop or phone (phones need a real HTTPS certificate — see [Limitations](#limitations)).
- **Your media stays on your server.** Video, audio and chat go through your own LiveKit SFU. The server does not record or store meeting content.
- **Only your team can open meetings.** Creating a meeting requires a host code; guests wait in a lobby (on by default) until the host lets them in.
- **Small and readable.** One Node backend, three static frontend files with no build step, no external CDN.
- **Works without a domain.** Deploy to a server that has only a public IP and still get HTTPS (Let's Encrypt IP certificate).

**Good fit:** recurring meetings with outside guests, teams that want meeting media to stay on their own server, a self-hosted lab or test setup.
**Not a good fit:** large webinars, meetings above ~20 people, server-side recording, or anyone who needs a polished, supported product.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Security design](#security-design)
- [Limitations](#limitations)
- [Development and tests](#development-and-tests)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

## Features

| For | What you get |
|---|---|
| Participants | Join with link + password (no sign-up), device check before joining (camera, microphone, speaker test tone), mic/camera on/off, screen sharing (with audio), chat, raise hand, spotlight a tile |
| Host | Create meetings (host code required), admit or reject from the lobby, lock the meeting, change the password, mute a participant, stop their screen share, remove them, end the meeting for everyone |
| Recording | Saved on the host's PC only (meeting tab + everyone's audio, webm). While recording, everyone sees a "● Recording" badge |
| Layout | Tiles fit the window automatically (no scrolling); a shared screen is shown large; works on phones |
| Privacy | No server-side recording or chat storage; meeting data is deleted automatically after a set time (24 hours by default) |

![Participant view — three-person tile layout](docs/screenshot-grid.jpg)

## Quick start

You need Docker (Docker Desktop, or Docker Engine + Compose v2) and a recent Chrome or Edge. On macOS and Linux you also need `openssl`.

```bash
git clone https://github.com/jason-log/meetflow-oss.git && cd meetflow-oss && ./start.sh
```

On Windows, run `start.bat` instead.

1. On first run the script creates `.env`, fills the keys, secret and host code with random values, and prints the **host code**.
2. Open `http://localhost:3000`, enter a meeting title, your name, the host code and a meeting password you choose (6–64 characters), then click **회의 만들기** (Create meeting).
3. Open the invite link in another tab, enter a name and the meeting password, and click **입장하기** (Join). Back in the host tab, click **수락** (Admit) — the lobby is on by default.

The UI is in Korean for now; your browser's built-in page translation works well enough to find your way around.

Check status with `docker compose ps` or `curl http://localhost:3000/api/health`.

## How it works

```
Browser ──HTTPS/WSS──▶ Caddy ──▶ backend (meetings, passwords, tokens, host controls, serves the web app)
   │                      └──/rtc──▶ LiveKit (signaling)
   └──────── UDP 7882 / TCP 7881 (media) ────────▶ LiveKit SFU
                                       backend ──▶ Valkey (meeting data, TTL)
```

The diagram shows the IP-only server deployment. With a domain, LiveKit gets its own hostname (`LIVEKIT_DOMAIN`); when running locally there is no Caddy and the browser talks to ports 3000 and 7880 directly.

- **SFU** (Selective Forwarding Unit): each participant uploads their video once and the server forwards it to everyone else, so upload bandwidth per person barely grows as the meeting gets bigger.
- **TURN**: the server relays media for participants on networks that block UDP or non-standard ports. Optional — see [Deployment](#turntls-on-443-optional).
- **ICE**: the procedure by which the browser and server try the available paths (UDP, TCP, relay) and pick one that works.

| Service | Role | Publicly exposed ports |
|---|---|---|
| livekit (v1.13.8) | WebRTC SFU media server | 7881/tcp (ICE/TCP), 7882/udp (media) |
| redis (Valkey 8.1) | Stores meeting data with a TTL | none |
| backend (Node 22, Express) | Creates meetings, verifies passwords, issues tokens, host controls, serves the web app | none (127.0.0.1:3000) |
| caddy (`prod` profile) | Automatic HTTPS/WSS certificates and reverse proxy | 80/tcp, 443/tcp, 443/udp |

The frontend is three static files in `backend/public/` with no build step. Scripts and styles load only from your own server (`'self'`), and the page may connect only to your server and your LiveKit address (CSP).

## Configuration

Copy `.env.example` to `.env` (the start script does this for you). Never share `.env` through git, email or chat.

| Variable | Default | Description |
|---|---|---|
| `MEETFLOW_ENV` | `development` | Use `production` on a server — turns on safety checks (rejects weak keys, requires `wss://`, sends HSTS) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | generated | LiveKit key (8+ characters) and secret (32+ characters) |
| `HOST_ACCESS_CODE` | generated | Code your own staff use to create meetings (8+ characters). Do not give it to guests |
| `LIVEKIT_PUBLIC_URL` | `ws://localhost:7880` | LiveKit address the browser connects to. `wss://…` in production |
| `LIVEKIT_NODE_IP` | `127.0.0.1` | Media IP that LiveKit advertises to participants. The server's public IP in production |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy (Caddy) so rate limits apply to each visitor's real IP |
| `MAX_PARTICIPANTS` | `20` | Participants per meeting (2–50) |
| `ROOM_TTL_HOURS` | `24` | How long meeting data is kept (1–336) |
| `APP_DOMAIN` / `LIVEKIT_DOMAIN` | `meet.example.com` / `livekit.example.com` | Web and LiveKit hostnames for a domain deployment (required there) |
| `TURN_DOMAIN` / `TURN_CERT_DIR` | `turn.example.com` / Let's Encrypt path | Only for the TURN/TLS extension |

This table applies to local and domain deployments (`docker-compose.yml`). For the IP-only server deployment (`docker-compose.server.yml`), `scripts/init-server-env.sh` writes a separate `.env` with `PUBLIC_IP`, `TLS_MODE` and the keys; production mode, `wss://` and `TRUST_PROXY=1` are fixed in that Compose file.

## Deployment

### Server with a public IP only (no domain)

The web app, API and LiveKit signaling share port 443, split by path (`/rtc`). Everything is in `docker-compose.server.yml` + `Caddyfile.server`. `203.0.113.10` below is a documentation example — replace it with your server's public IP.

```bash
# first time
cd ~ && git clone https://github.com/jason-log/meetflow-oss.git && cd meetflow-oss && bash scripts/init-server-env.sh 203.0.113.10 internal
# deploy / update
cd ~/meetflow-oss && git pull origin main && docker compose -f docker-compose.server.yml up -d --build && docker compose -f docker-compose.server.yml ps
```

- `TLS_MODE=internal`: Caddy's self-signed certificate. Browsers show a warning once; meant for testing on an internal network.
- `TLS_MODE=public`: Let's Encrypt IP certificate (6-day lifetime, renewed automatically). Port 443/tcp must be reachable from the internet for issuance and renewal. After switching, run `docker compose -f docker-compose.server.yml up -d caddy`.
- Public ports are 443/tcp, 7881/tcp, 7882/udp and 3478/udp, all bound to `PUBLIC_IP` only. Port 80/tcp is not used, so it does not clash with other web services on the same server.
- Ports opened by Docker may bypass the host firewall (UFW etc.). Control exposure with your perimeter firewall or the `DOCKER-USER` chain.
- TURN/TLS on 443 is not possible with an IP address alone. If some participants are on networks that allow only web traffic (443), get a domain and use the setup below.

### Server with a domain

In `.env`, set `MEETFLOW_ENV=production`, `TRUST_PROXY=1`, `LIVEKIT_PUBLIC_URL=wss://livekit.<your-domain>`, `LIVEKIT_NODE_IP=<public IP>`, `APP_DOMAIN` and `LIVEKIT_DOMAIN`, then run:

```bash
docker compose --profile prod up -d --build
```

> [!WARNING]
> Without `MEETFLOW_ENV=production` the production safety checks are off. If `TRUST_PROXY=1` is also missing, every visitor appears to come from the proxy's single IP and the rate limit can block the whole meeting; the backend logs a one-time warning when it detects this. With `MEETFLOW_ENV=production` and `TRUST_PROXY=0`, the backend refuses to start.

### TURN/TLS on 443 (optional)

Relays media over TLS on 443/tcp for participants whose networks block UDP and 7881/tcp. An `edge` container (nginx stream) takes public port 443 and routes by SNI: `turn.<your-domain>` goes to LiveKit's built-in TURN server, everything else goes to Caddy (the real client IP is passed with the PROXY protocol). Add `TURN_DOMAIN` to `.env`, create the DNS record, then run the command below. Requires Docker Compose v2.24.4 or later.

```bash
docker compose -f docker-compose.yml -f docker-compose.turn.yml --profile prod up -d --build
```

- On first start, livekit restarts repeatedly until Caddy has obtained the TURN certificate (expected, 1–2 minutes).
- After each certificate renewal (about every 60 days), run `docker compose restart livekit`.
- To check which connection path is used, append `?relay=1` (force relay) or `?diag=1` to the meeting URL and run `await meetflowDiag()` in the browser console.

## Security design

- **Three levels of access**: creating a meeting needs the host code, joining needs the meeting password, and host controls need a per-meeting host key (32 random bytes). The server stores the password only as an scrypt hash and the host key only as a SHA-256 hash.
- **Brute-force protection**: 10 failed passwords per 10 minutes (per IP, per meeting) and 10 failed host codes per 15 minutes. IPv6 addresses are counted per /64. Meeting codes have about 9.5×10¹³ possible values.
- **Tokens**: LiveKit join tokens live for 2 minutes and carry no admin rights (`roomAdmin`). The participant's role is signed by the server, so a participant cannot pose as the host.
- **Web**: no external or inline scripts (CSP `script-src 'self'`, `frame-ancestors 'none'`, `no-referrer`). All on-screen text is set with `textContent`. Control characters and bidirectional-override characters are stripped from names on the server.
- **Production checks**: in production mode the backend refuses to start with publicly known default or test keys, a `ws://` address, or `TRUST_PROXY=0`.

Please do not report vulnerabilities in public issues — follow [SECURITY.md](SECURITY.md).

## Limitations

- **Removed participants can come back with a modified client**: while connected, the LiveKit server hands out refresh tokens, and a modified client could reuse one to rejoin. To be sure, lock the meeting or change the password after removing someone.
- **Host controls are not enforced**: after being muted or having a screen share stopped, a participant can turn it back on. Every participant can share their screen.
- **Recording badge**: "● Recording" is announced by the host's browser every 5 seconds; the server does not guarantee it. The operator is responsible for consent wording and retention periods.
- **Single instance**: rate-limit counters live in backend memory, so they reset on restart and are not shared if you run several backends.
- **Browsers**: tested on recent Chrome and Edge. With the self-signed certificate (`TLS_MODE=internal`) phones may fail to connect — use a real certificate (`TLS_MODE=public` or a domain) when inviting outside guests.
- **UI language**: the interface is Korean only for now.

## Development and tests

```bash
cd backend && npm install && npm test
```

24 API unit tests, with Redis replaced by ioredis-mock and LiveKit by a stub (Node 22; no Docker or LiveKit needed).

## Contributing

Questions and bug reports are welcome in [Issues](https://github.com/jason-log/meetflow-oss/issues). This is a PoC maintained by one person, so replies may be slow. For code changes, please open an issue first to agree on the direction, then send a pull request.

Background article (in Korean): [MeetFlow — self-hosted video meetings you join with a link and a password](https://jason-log.notion.site/MeetFlow-400b37d1f4498168b1cfca0913f40dae)

## Credits

MeetFlow was designed, built, tested and documented together with [Claude](https://www.anthropic.com/claude) (Anthropic) as an AI pair programmer — from the code and security review to this README. From this English release on, commits made with Claude carry a `Co-authored-by: Claude <noreply@anthropic.com>` trailer.

## License

[Apache-2.0](LICENSE) © 2026 The MeetFlow Authors

Built on: LiveKit Server and livekit-client (Apache-2.0), Valkey (BSD-3-Clause), Caddy (Apache-2.0), nginx (BSD-2-Clause).
