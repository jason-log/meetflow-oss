# MeetFlow v0.2 — 20인 이하 자체 호스팅 화상회의 (LiveKit SFU)

외부 참석자를 초대 링크 + 회의 비밀번호로 부르는 소규모(20인 이하) 자체 호스팅 화상회의. 빌드 단계 없는 정적 프런트(CSP `'self'`) + Express 백엔드 + LiveKit SFU 구성이다.

## 구성

| 서비스 | 역할 | 외부 공개 포트 |
|---|---|---|
| livekit (v1.13.8) | WebRTC SFU 미디어 서버 | 7881/tcp(ICE/TCP), 7882/udp(미디어) |
| redis (Valkey 8.1) | 회의 정보(TTL) 저장 | 없음 |
| backend (Node 22, Express) | 회의 생성·비밀번호 검증·토큰 발급·호스트 제어, 웹앱 제공 | 없음(127.0.0.1:3000) |
| caddy (prod 프로필) | HTTPS/WSS 인증서 자동 발급·프록시 | 80/tcp, 443/tcp, 443/udp |

## 기능

- 회의 만들기: 호스트 코드(`HOST_ACCESS_CODE`)를 아는 내부 담당자만. 회의 코드는 무작위(`abc-defg-hij`).
- 참가: 초대 링크 + 회의 비밀번호(scrypt 해시, 실패 10회/10분 제한). 대기실(호스트 승인 후 입장)은 기본 사용, 호스트가 켜고 끈다.
- 카메라·마이크(ON/OFF)·화면 공유(음성 포함, 시작 시 공유 화면을 크게 표시), 발화자 강조, 크게 보기(고정), 채팅, 손들기, 마이크·카메라·스피커 선택.
- 호스트: 회의 잠금, 비밀번호 변경, 입장 승인·거절, 참석자 음소거·화면 공유 중지·내보내기, 모두에게 회의 종료.
- 녹화: 호스트 PC에만 저장(탭 화면 + 전원 음성, webm). 녹화 중에는 전원에게 「● 녹화 중」 표시. 서버 녹화·서버 측 채팅 저장 없음.

## 로컬 실행 (같은 PC 브라우저로 시험)

Windows(Docker Desktop): `start.bat` / macOS·Linux: `./start.sh`
처음 실행 시 `.env`가 생성되고 호스트 코드가 출력된다. 브라우저에서 `http://localhost:3000`.

## 서버 배포 (도메인 없이 IP HTTPS)

공인 IP 하나만 있는 서버에 올린다(아래 예시의 `203.0.113.10`은 문서용 IP — 실제 공인 IP로 바꾼다). 설정은 `docker-compose.server.yml` + `Caddyfile.server` 하나로 끝나며, 웹·API·LiveKit 시그널링이 443 하나를 경로(`/rtc`)로 나눠 쓴다.

```
# 최초 1회
cd ~ && git clone https://github.com/<계정>/meetflow.git && cd meetflow && bash scripts/init-server-env.sh 203.0.113.10 internal
# 배포·갱신
cd ~/meetflow && git pull origin main && docker compose -f docker-compose.server.yml up -d --build && docker compose -f docker-compose.server.yml ps
```

- `TLS_MODE=internal`: Caddy 자체 인증서(접속 시 경고 1회) — 내부망 시험.
- `TLS_MODE=public`: Let's Encrypt IP 인증서(6일, 자동 갱신) — 443/tcp 외부 개방이 전제. 바꾼 뒤 `docker compose -f docker-compose.server.yml up -d caddy`.
- 공개 포트: 443/tcp, 7881/tcp, 7882/udp, 3478/udp (모두 PUBLIC_IP 에만 바인딩). 80/tcp 는 쓰지 않으므로 같은 서버의 다른 웹 서비스와 겹치지 않는다.
- 주의: Docker 가 연 포트는 호스트 방화벽(UFW 등)을 거치지 않을 수 있다. 노출 통제는 경계 방화벽이나 `DOCKER-USER` 체인으로 한다.
- IP 만으로는 TURN/TLS 443(웹만 허용하는 기관망 대응)을 쓸 수 없다 — 도메인이 생기면 `docker-compose.turn.yml` 방식으로 전환.

## 운영 배포 (도메인이 있을 때)

`.env`에서 `MEETFLOW_ENV=production`, `LIVEKIT_PUBLIC_URL=wss://livekit.<도메인>`, `LIVEKIT_NODE_IP=<공인 IP>`, `TRUST_PROXY=1`, `APP_DOMAIN`, `LIVEKIT_DOMAIN`을 채운 뒤:

```
docker compose --profile prod up -d --build
```

### TURN/TLS 443 확장 (기관망 대응, 선택)

UDP와 7881/tcp를 막는 망의 참가자를 위해 미디어를 443/tcp TLS로 중계한다. 공인 443은 `edge`(nginx stream)가 받아 SNI로 `turn.<도메인>` → LiveKit 내장 TURN, 나머지 → Caddy로 나눈다(PROXY protocol로 실제 IP 전달). `.env`에 `TURN_DOMAIN`을 넣고 DNS를 추가한 뒤:

```
docker compose -f docker-compose.yml -f docker-compose.turn.yml --profile prod up -d --build
```

첫 기동 시 Caddy가 TURN 인증서를 받기 전까지 livekit 이 재시작을 반복한다(정상, 1~2분). 인증서 갱신(약 60일 주기) 뒤에는 `docker compose restart livekit`이 필요하다. 접속 경로 점검은 `?relay=1`(중계 강제)·`?diag=1` 후 콘솔에서 `await meetflowDiag()`.

> 도메인 배포(`--profile prod`)는 `.env`의 `MEETFLOW_ENV=production`·`TRUST_PROXY=1`이 빠지면 운영 안전 점검(약한 키 거부·wss 강제·HSTS)이 꺼지고, 모든 접속이 프록시 IP 하나로 보여 속도 제한이 회의 전체를 막는다. 백엔드는 이 상태를 감지하면 로그에 경고를 남긴다.

## 한계 (알고 쓰기)

- 내보낸 참석자: 접속 중에는 LiveKit 서버가 갱신 토큰을 내려주므로, 내보낸 참석자가 개조한 클라이언트로 그 토큰을 써 재접속하는 것까지는 막지 못한다. 확실히 막으려면 내보낸 뒤 회의 잠금 또는 비밀번호 변경을 함께 한다(차단 목록 + LiveKit webhook 은 후속 과제).
- 호스트의 음소거·화면 공유 중지는 강제가 아니다. 참석자가 다시 켤 수 있고, 모든 참석자가 화면 공유를 할 수 있다.
- 녹화 표시(「● 녹화 중」)는 호스트 클라이언트가 5초마다 알리는 방식이다. 서버가 보증하지 않는다.
- 속도 제한 기록은 백엔드 메모리에 있어 재시작하면 초기화되고, 백엔드를 여러 대로 늘리면 공유되지 않는다(단일 컨테이너 전제).

## 시험

```
cd backend && npm install && npm test
```

Redis는 ioredis-mock, LiveKit은 스텁으로 대체한 API 단위 시험(24건, Node 22).

## 라이선스

Apache License 2.0 — [LICENSE](LICENSE). 사용 구성요소: LiveKit Server·livekit-client(Apache-2.0), Valkey(BSD-3-Clause), Caddy(Apache-2.0).
