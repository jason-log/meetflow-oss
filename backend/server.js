'use strict';
/**
 * MeetFlow v0.2 backend
 * - 회의 생성: 호스트 코드(HOST_ACCESS_CODE)를 아는 내부 담당자만 가능
 * - 참가: 초대 링크 + 회의 비밀번호(scrypt 검증) → LiveKit 참가 토큰 발급
 * - 호스트 제어: 잠금·비밀번호 변경·원격 음소거·내보내기·회의 종료 (X-Host-Key)
 * - 상태 저장: Redis(TTL) — 백엔드 재시작에도 회의 정보 유지
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

const scrypt = promisify(crypto.scrypt);

// ---------------------------------------------------------------- 설정
const env = process.env;
const IS_PROD = env.NODE_ENV === 'production';
const PORT = parseInt(env.PORT || '3000', 10);
const LIVEKIT_API_KEY = env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = env.LIVEKIT_API_SECRET || '';
const LIVEKIT_PUBLIC_URL = env.LIVEKIT_PUBLIC_URL || 'ws://localhost:7880';
const LIVEKIT_INTERNAL_URL = env.LIVEKIT_INTERNAL_URL || 'http://livekit:7880';
const REDIS_URL = env.REDIS_URL || 'redis://redis:6379';
const HOST_ACCESS_CODE = env.HOST_ACCESS_CODE || '';
const MAX_PARTICIPANTS = clampInt(env.MAX_PARTICIPANTS, 2, 50, 20);
const ROOM_TTL_SEC = clampInt(env.ROOM_TTL_HOURS, 1, 24 * 14, 24) * 3600;
const TRUST_PROXY = clampInt(env.TRUST_PROXY, 0, 5, 0);

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function fatal(msg) {
  console.error(`[MeetFlow] 설정 오류: ${msg}`);
  process.exit(1);
}

// 공개 저장소에 적힌 값(예전 기본값·시험 값)은 운영에서 거부한다
const KNOWN_WEAK = ['APImfDevKey2026', 'SecretMeetFlow2026SuperSecureKey998877', 'devkey', 'secret', 'changeme', 'APItestkey0001', 'x'.repeat(40), 'host-code-1234'];
if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) fatal('LIVEKIT_API_KEY / LIVEKIT_API_SECRET 가 비어 있습니다 (.env 확인, start 스크립트가 자동 생성).');
if (LIVEKIT_API_KEY.length < 8) fatal('LIVEKIT_API_KEY 는 8자 이상이어야 합니다(키 생성 실패 여부 확인).');
if (LIVEKIT_API_SECRET.length < 32) fatal('LIVEKIT_API_SECRET 은 32자 이상이어야 합니다.');
if (HOST_ACCESS_CODE.length < 8) fatal('HOST_ACCESS_CODE 는 8자 이상이어야 합니다.');
if (IS_PROD) {
  if ([LIVEKIT_API_KEY, LIVEKIT_API_SECRET, HOST_ACCESS_CODE].some((v) => KNOWN_WEAK.includes(v))) fatal('운영 모드에서 기본/공개/시험용 키·호스트 코드를 사용할 수 없습니다.');
  if (!LIVEKIT_PUBLIC_URL.startsWith('wss://')) fatal('운영 모드에서 LIVEKIT_PUBLIC_URL 은 wss:// 이어야 합니다.');
  if (TRUST_PROXY === 0) fatal('운영 모드(Caddy 뒤)에서는 TRUST_PROXY=1 이어야 합니다. 0이면 모든 접속자가 같은 IP로 보여 속도 제한이 회의 전체를 막습니다.');
}

// ---------------------------------------------------------------- 외부 연결
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
redis.on('error', (e) => console.error('[MeetFlow] Redis 오류:', e.message));
const roomService = new RoomServiceClient(LIVEKIT_INTERNAL_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// ---------------------------------------------------------------- 유틸
const ROOM_ID_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const ROOM_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'; // l 제외(1과 혼동)

function genRoomId() {
  const pick = (n) => Array.from(crypto.randomBytes(n), (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}
const roomKey = (id) => `mf:room:${id}`;
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

function safeEqualStr(a, b) {
  // 길이 노출 없이 비교: 양쪽을 SHA-256으로 고정 길이화 후 timingSafeEqual
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const dk = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: dk.toString('hex') };
}

async function verifyPassword(password, saltHex, hashHex) {
  const { hash } = await hashPassword(password, saltHex);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashHex, 'hex'));
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // 제어문자 제거 후 공백 정리
  // 제어문자 + 양방향 조작·폭 없는 문자 제거(다른 참석자 이름 흉내 방지)
  return v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').trim().slice(0, max);
}

function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 64;
}

async function loadRoom(id) {
  if (!ROOM_ID_RE.test(id)) return null;
  const raw = await redis.get(roomKey(id));
  return raw ? JSON.parse(raw) : null;
}

async function saveRoom(room) {
  // 남은 TTL 유지(갱신 시 만료 연장 없음). 그 사이 종료·만료된 회의는 되살리지 않는다(false)
  const ttl = await redis.ttl(roomKey(room.id));
  if (ttl <= 0) return false;
  await redis.set(roomKey(room.id), JSON.stringify(room), 'EX', ttl);
  return true;
}
const GONE = { error: '존재하지 않거나 만료된 회의입니다.' };

async function ensureLiveKitRoom(id) {
  // auto_create=false 이므로 백엔드가 방을 만든다. 이미 있으면 기존 방을 돌려준다(멱등).
  await roomService.createRoom({ name: id, emptyTimeout: 600, departureTimeout: 30, maxParticipants: MAX_PARTICIPANTS });
}

async function issueToken(roomId, name, role) {
  const identity = `${role === 'host' ? 'h' : 'g'}_${crypto.randomBytes(6).toString('hex')}`;
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name,
    // 최초 접속용으로 짧게 둔다. 단, 접속 중에는 LiveKit 서버가 갱신 토큰을 내려주므로
    // 내보낸 참가자가 개조한 클라이언트로 그 토큰을 써 재접속하는 것까지 막지는 못한다(README 「한계」)
    ttl: '2m',
    metadata: JSON.stringify({ role }),
  });
  at.addGrant({
    room: roomId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  return { token: await at.toJwt(), identity };
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- 앱
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

function wsToHttp(u) {
  return u.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}
const lkOrigin = (() => {
  try { return new URL(LIVEKIT_PUBLIC_URL).origin.replace(/^http/, 'ws'); } catch { return LIVEKIT_PUBLIC_URL; }
})();

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:', 'mediastream:'],
        'connect-src': ["'self'", lkOrigin, wsToHttp(lkOrigin)],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': IS_PROD ? [] : null,
      },
    },
    hsts: IS_PROD ? { maxAge: 15552000 } : false,
    referrerPolicy: { policy: 'no-referrer' },
  })
);
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  next();
});
app.use(express.json({ limit: '8kb' }));

// 프록시 뒤인데 TRUST_PROXY=0 이면 모든 접속자가 프록시 IP 하나로 보여 속도 제한이 회의 전체를 막는다 — 한 번 경고
let warnedProxy = false;
app.use((req, res, next) => {
  if (!warnedProxy && TRUST_PROXY === 0 && req.headers['x-forwarded-for']) {
    warnedProxy = true;
    console.warn('[MeetFlow] 경고: X-Forwarded-For 가 들어오는데 TRUST_PROXY=0 입니다. 리버스 프록시 뒤라면 MEETFLOW_ENV=production · TRUST_PROXY=1 로 설정하세요.');
  }
  next();
});

// 정적 파일: 앱 + livekit-client 번들(CDN 미사용)
// 화면 파일은 매번 재검증(ETag) — 배포 직후 이전 화면이 남지 않게 한다
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));
// 패키지 exports가 하위 경로 resolve를 막으므로 main(UMD) 경로를 직접 쓴다
const lkClientUmd = require.resolve('livekit-client');
app.get('/vendor/livekit-client.umd.js', (req, res) => res.sendFile(lkClientUmd));

// ---------------------------------------------------------------- 속도 제한
// IPv6 는 /64 단위로 묶는다(한 사용자가 주소를 바꿔 가며 제한을 피하지 못하게)
function ipKey(ip) {
  if (typeof ip !== 'string' || !ip) return 'unknown';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => (x || '0').toLowerCase()).join(':')}::/64`;
}
const createLimiter = rateLimit({
  keyGenerator: (req) => ipKey(req.ip),
  windowMs: 15 * 60 * 1000,
  limit: 10, // 실패(호스트 코드 오류 등)만 집계
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '회의 생성 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
});
const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10, // 실패한 시도만 집계(아래 skipSuccessfulRequests)
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKey(req.ip)}|${req.params.id}`,
  skip: (req) => typeof req.body?.hostKey === 'string' && req.body.hostKey.length > 0 && !req.body.password, // 호스트 재입장은 대입 집계 제외(키 오류는 아래에서 401)
  message: { error: '비밀번호 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.' },
});
const hostLimiter = rateLimit({
  keyGenerator: (req) => ipKey(req.ip),
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다.' },
});
const infoLimiter = rateLimit({ keyGenerator: (req) => ipKey(req.ip), windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

// ---------------------------------------------------------------- API
app.get('/api/health', ah(async (req, res) => {
  let redisOk = false;
  try { redisOk = (await redis.ping()) === 'PONG'; } catch { /* noop */ }
  res.status(redisOk ? 200 : 503).json({ status: redisOk ? 'ok' : 'degraded', redis: redisOk });
}));

// 회의 생성 (내부 담당자)
app.post('/api/rooms', createLimiter, ah(async (req, res) => {
  const { hostCode, password } = req.body || {};
  const title = cleanText(req.body?.title, 60) || '화상회의';
  if (typeof hostCode !== 'string' || !safeEqualStr(hostCode, HOST_ACCESS_CODE)) {
    return res.status(403).json({ error: '호스트 코드가 올바르지 않습니다.' });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: '회의 비밀번호는 6~64자로 정해 주세요.' });
  }

  let id;
  for (let i = 0; i < 5; i++) {
    id = genRoomId();
    if (!(await redis.exists(roomKey(id)))) break;
  }
  const hostKey = crypto.randomBytes(32).toString('base64url');
  const pw = await hashPassword(password);
  const room = {
    id,
    title,
    salt: pw.salt,
    pwHash: pw.hash,
    locked: false,
    waiting: req.body?.waiting !== false, // 대기실(호스트 승인 후 입장) 기본 사용
    hostKeyHash: sha256(hostKey).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  const ok = await redis.set(roomKey(id), JSON.stringify(room), 'EX', ROOM_TTL_SEC, 'NX');
  if (!ok) return res.status(503).json({ error: '회의 코드 생성에 실패했습니다. 다시 시도해 주세요.' });
  res.status(201).json({ roomId: id, title, hostKey, expiresInSec: ROOM_TTL_SEC });
}));

// 회의 공개 정보 (초대 링크 화면용)
app.get('/api/rooms/:id', infoLimiter, ah(async (req, res) => {
  const room = await loadRoom(req.params.id);
  if (!room) return res.status(404).json({ error: '존재하지 않거나 만료된 회의입니다.' });
  res.json({ roomId: room.id, title: room.title, locked: room.locked, waiting: room.waiting !== false, maxParticipants: MAX_PARTICIPANTS });
}));

function isHost(room, hostKey) {
  return typeof hostKey === 'string' && hostKey.length > 0 && safeEqualStr(sha256(hostKey).toString('hex'), room.hostKeyHash);
}

// 참가 → LiveKit 토큰 발급
app.post('/api/rooms/:id/join', joinLimiter, ah(async (req, res) => {
  const room = await loadRoom(req.params.id);
  if (!room) return res.status(404).json({ error: '존재하지 않거나 만료된 회의입니다.' });

  const name = cleanText(req.body?.name, 30);
  if (!name) return res.status(400).json({ error: '표시할 이름을 1~30자로 입력해 주세요.' });

  const host = isHost(room, req.body?.hostKey);
  if (!host) {
    if (room.locked) return res.status(423).json({ error: '호스트가 회의를 잠갔습니다. 호스트에게 잠금 해제를 요청하세요.' });
    const password = req.body?.password;
    if (typeof password !== 'string' || !password) return res.status(401).json({ error: '회의 비밀번호를 입력해 주세요.' });
    if (!(await verifyPassword(password, room.salt, room.pwHash))) {
      return res.status(401).json({ error: '회의 비밀번호가 일치하지 않습니다.' });
    }
  }

  await ensureLiveKitRoom(room.id);
  if (await roomFull(room.id)) return res.status(409).json({ error: `회의 정원(${MAX_PARTICIPANTS}명)이 찼습니다.` });

  // 대기실: 비밀번호가 맞아도 호스트가 승인해야 토큰을 받는다
  if (!host && room.waiting !== false) {
    const pending = await redis.scard(reqSetKey(room.id));
    if (pending >= MAX_PENDING) return res.status(429).json({ error: '입장 대기 인원이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    const reqId = `rq_${crypto.randomBytes(8).toString('hex')}`;
    const waitKey = crypto.randomBytes(24).toString('base64url');
    const rq = { id: reqId, name, status: 'pending', keyHash: sha256(waitKey).toString('hex'), createdAt: new Date().toISOString() };
    await redis.set(reqKey(room.id, reqId), JSON.stringify(rq), 'EX', REQ_TTL_SEC);
    await redis.sadd(reqSetKey(room.id), reqId);
    await redis.expire(reqSetKey(room.id), ROOM_TTL_SEC);
    return res.status(202).json({ status: 'waiting', reqId, waitKey, roomId: room.id, title: room.title });
  }

  const role = host ? 'host' : 'guest';
  const { token, identity } = await issueToken(room.id, name, role);
  res.json({ status: 'joined', token, livekitUrl: LIVEKIT_PUBLIC_URL, role, identity, roomId: room.id, title: room.title, locked: room.locked, waiting: room.waiting !== false });
}));

// ---------------------------------------------------------------- 대기실
const REQ_TTL_SEC = 15 * 60; // 승인 대기 최대 15분
const MAX_PENDING = 50;
const REQ_ID_RE = /^rq_[0-9a-f]{16}$/;
const reqKey = (roomId, reqId) => `mf:req:${roomId}:${reqId}`;
const reqSetKey = (roomId) => `mf:reqs:${roomId}`;

async function roomFull(roomId) {
  try {
    const participants = await roomService.listParticipants(roomId);
    return participants.length >= MAX_PARTICIPANTS;
  } catch { return false; /* 방이 막 생성된 경우 등 — LiveKit max_participants 가 최종 차단 */ }
}

async function loadReq(roomId, reqId) {
  if (!REQ_ID_RE.test(reqId || '')) return null;
  const raw = await redis.get(reqKey(roomId, reqId));
  return raw ? JSON.parse(raw) : null;
}

const pollLimiter = rateLimit({ keyGenerator: (req) => ipKey(req.ip), windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '요청이 너무 많습니다.' } });

// 참석자: 승인 여부 조회(2초 간격 폴링). 승인되면 이때 토큰을 발급한다(토큰 2분 수명 유지)
app.get('/api/rooms/:id/requests/:reqId', pollLimiter, ah(async (req, res) => {
  const room = await loadRoom(req.params.id);
  if (!room) return res.status(404).json({ status: 'gone', error: '회의가 종료되었거나 만료되었습니다.' });
  const rq = await loadReq(room.id, req.params.reqId);
  if (!rq) return res.status(404).json({ status: 'expired', error: '입장 대기 시간이 지났습니다. 다시 입장을 요청해 주세요.' });
  const key = req.get('x-wait-key');
  if (typeof key !== 'string' || !safeEqualStr(sha256(key).toString('hex'), rq.keyHash)) return res.status(403).json({ error: '권한이 없습니다.' });
  if (rq.status === 'denied') {
    await redis.del(reqKey(room.id, rq.id));
    await redis.srem(reqSetKey(room.id), rq.id);
    return res.status(403).json({ status: 'denied', error: '호스트가 입장을 거절했습니다.' });
  }
  if (rq.status !== 'approved') return res.json({ status: 'pending' });
  // 승인 뒤 호스트가 잠갔으면 입장시키지 않는다
  if (room.locked) return res.status(423).json({ status: 'locked', error: '호스트가 회의를 잠갔습니다. 호스트에게 잠금 해제를 요청하세요.' });
  await ensureLiveKitRoom(room.id);
  if (await roomFull(room.id)) return res.status(409).json({ status: 'full', error: `회의 정원(${MAX_PARTICIPANTS}명)이 찼습니다.` });
  // 승인 1건 = 토큰 1개: 동시 조회로 두 번 발급되지 않게 삭제에 성공한 요청만 발급
  const consumed = await redis.del(reqKey(room.id, rq.id));
  await redis.srem(reqSetKey(room.id), rq.id);
  if (consumed !== 1) return res.status(404).json({ status: 'expired', error: '입장 대기 시간이 지났습니다. 다시 입장을 요청해 주세요.' });
  const { token, identity } = await issueToken(room.id, rq.name, 'guest');
  res.json({ status: 'joined', token, livekitUrl: LIVEKIT_PUBLIC_URL, role: 'guest', identity, roomId: room.id, title: room.title, locked: room.locked, waiting: room.waiting !== false });
}));

// 참석자: 대기 취소
app.delete('/api/rooms/:id/requests/:reqId', pollLimiter, ah(async (req, res) => {
  const room = await loadRoom(req.params.id);
  if (!room) return res.json({ ok: true });
  const rq = await loadReq(room.id, req.params.reqId);
  const key = req.get('x-wait-key');
  if (rq && typeof key === 'string' && safeEqualStr(sha256(key).toString('hex'), rq.keyHash)) {
    await redis.del(reqKey(room.id, rq.id));
    await redis.srem(reqSetKey(room.id), rq.id);
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- 호스트 제어
const requireHost = ah(async (req, res, next) => {
  const room = await loadRoom(req.params.id);
  if (!room) return res.status(404).json({ error: '존재하지 않거나 만료된 회의입니다.' });
  if (!isHost(room, req.get('x-host-key'))) return res.status(403).json({ error: '호스트 권한이 없습니다.' });
  req.room = room;
  next();
});

const IDENTITY_RE = /^[hg]_[0-9a-f]{12}$/;

// 호스트: 대기 목록(만료된 항목은 정리)
app.get('/api/rooms/:id/requests', pollLimiter, requireHost, ah(async (req, res) => {
  const ids = await redis.smembers(reqSetKey(req.room.id));
  const list = [];
  for (const id of ids) {
    const rq = await loadReq(req.room.id, id);
    if (!rq) { await redis.srem(reqSetKey(req.room.id), id); continue; }
    if (rq.status === 'pending') list.push({ reqId: rq.id, name: rq.name, createdAt: rq.createdAt });
  }
  list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json({ waiting: req.room.waiting !== false, requests: list });
}));

// 호스트: 승인·거절
app.post('/api/rooms/:id/requests/:reqId', hostLimiter, requireHost, ah(async (req, res) => {
  const action = req.body?.action;
  if (action !== 'approve' && action !== 'deny') return res.status(400).json({ error: 'action 은 approve 또는 deny 입니다.' });
  const rq = await loadReq(req.room.id, req.params.reqId);
  if (!rq) return res.status(404).json({ error: '이미 처리됐거나 만료된 요청입니다.' });
  rq.status = action === 'approve' ? 'approved' : 'denied';
  await redis.set(reqKey(req.room.id, rq.id), JSON.stringify(rq), 'EX', 120); // 참석자가 2분 안에 결과를 받아 간다
  res.json({ ok: true, status: rq.status });
}));

// 호스트: 대기실 켜기·끄기
app.post('/api/rooms/:id/waiting', hostLimiter, requireHost, ah(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled(boolean)가 필요합니다.' });
  req.room.waiting = req.body.enabled;
  if (!(await saveRoom(req.room))) return res.status(404).json(GONE);
  res.json({ waiting: req.room.waiting });
}));

app.post('/api/rooms/:id/lock', hostLimiter, requireHost, ah(async (req, res) => {
  if (typeof req.body?.locked !== 'boolean') return res.status(400).json({ error: 'locked(boolean)가 필요합니다.' });
  req.room.locked = req.body.locked;
  if (!(await saveRoom(req.room))) return res.status(404).json(GONE);
  res.json({ locked: req.room.locked });
}));

app.post('/api/rooms/:id/password', hostLimiter, requireHost, ah(async (req, res) => {
  const { password } = req.body || {};
  if (!validPassword(password)) return res.status(400).json({ error: '회의 비밀번호는 6~64자로 정해 주세요.' });
  const pw = await hashPassword(password);
  req.room.salt = pw.salt;
  req.room.pwHash = pw.hash;
  if (!(await saveRoom(req.room))) return res.status(404).json(GONE);
  res.json({ ok: true });
}));

app.post('/api/rooms/:id/mute', hostLimiter, requireHost, ah(async (req, res) => {
  const { identity, trackSid } = req.body || {};
  if (!IDENTITY_RE.test(identity || '') || typeof trackSid !== 'string' || !/^TR_[A-Za-z0-9]{1,40}$/.test(trackSid)) {
    return res.status(400).json({ error: '잘못된 요청입니다.' });
  }
  await roomService.mutePublishedTrack(req.room.id, identity, trackSid, true);
  res.json({ ok: true });
}));

app.post('/api/rooms/:id/remove', hostLimiter, requireHost, ah(async (req, res) => {
  const { identity } = req.body || {};
  if (!IDENTITY_RE.test(identity || '')) return res.status(400).json({ error: '잘못된 요청입니다.' });
  await roomService.removeParticipant(req.room.id, identity);
  res.json({ ok: true });
}));

app.post('/api/rooms/:id/end', hostLimiter, requireHost, ah(async (req, res) => {
  try { await roomService.deleteRoom(req.room.id); } catch { /* 이미 비어 닫힌 방 */ }
  await redis.del(roomKey(req.room.id));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- 폴백·오류
app.use('/api', (req, res) => res.status(404).json({ error: '없는 API입니다.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(400).json({ error: '잘못된 요청 본문입니다.' });
  }
  console.error('[MeetFlow] 처리 오류:', err?.message || err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[MeetFlow] listening :${PORT} (${IS_PROD ? 'production' : 'development'})`);
    console.log(`[MeetFlow] LiveKit public URL: ${LIVEKIT_PUBLIC_URL}, max ${MAX_PARTICIPANTS}, room TTL ${ROOM_TTL_SEC / 3600}h`);
  });
}

module.exports = { app, redis, roomService, ipKey };
