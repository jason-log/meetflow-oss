'use strict';
// 백엔드 API 단위 시험: Redis 는 ioredis-mock, LiveKit RoomService 는 스텁으로 대체한다.
// 실행: npm install && npm test   (Docker·LiveKit 불필요)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const RedisMock = require('ioredis-mock');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'ioredis') return RedisMock;
  return origLoad.call(this, req, ...rest);
};

process.env.LIVEKIT_API_KEY = 'APItestkey0001';
process.env.LIVEKIT_API_SECRET = 'x'.repeat(40);
process.env.HOST_ACCESS_CODE = 'host-code-1234';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { app, roomService, ipKey } = require('../server');

const calls = [];
let participants = [];
roomService.createRoom = async (o) => { calls.push(['create', o.name]); return {}; };
roomService.listParticipants = async () => participants;
roomService.mutePublishedTrack = async (...a) => { calls.push(['mute', ...a]); };
roomService.removeParticipant = async (...a) => { calls.push(['remove', ...a]); };
roomService.deleteRoom = async (...a) => { calls.push(['delete', ...a]); };

function decodeJwt(t) { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); }

let roomId, hostKey;

test('health', async () => {
  const r = await request(app).get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('보안 헤더(CSP·frame-ancestors)', async () => {
  const r = await request(app).get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(r.headers['content-security-policy'], /connect-src 'self' ws:\/\/localhost:7880 http:\/\/localhost:7880/);
  assert.ok(!/upgrade-insecure-requests/.test(r.headers['content-security-policy']));
});

test('livekit-client 번들 제공', async () => {
  const r = await request(app).get('/vendor/livekit-client.umd.js');
  assert.equal(r.status, 200);
  assert.ok(r.text.length > 100000);
});

test('호스트 코드 틀리면 생성 거부', async () => {
  const r = await request(app).post('/api/rooms').send({ title: 't', hostCode: 'wrong', password: '123456' });
  assert.equal(r.status, 403);
});

test('짧은 비밀번호 거부', async () => {
  const r = await request(app).post('/api/rooms').send({ title: 't', hostCode: 'host-code-1234', password: '123' });
  assert.equal(r.status, 400);
});

test('회의 생성', async () => {
  const r = await request(app).post('/api/rooms').send({ title: '주간 회의 <b>2차</b>', hostCode: 'host-code-1234', password: 'pw-778899', waiting: false });
  assert.equal(r.status, 201);
  assert.match(r.body.roomId, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  assert.ok(r.body.hostKey.length >= 40);
  roomId = r.body.roomId; hostKey = r.body.hostKey;
});

test('회의 정보: 비밀번호·키 미노출', async () => {
  const r = await request(app).get(`/api/rooms/${roomId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['locked', 'maxParticipants', 'roomId', 'title', 'waiting']);
});

test('없는 회의 404', async () => {
  assert.equal((await request(app).get('/api/rooms/abc-defg-hij')).status, 404);
  assert.equal((await request(app).get('/api/rooms/ABC')).status, 404);
});

test('틀린 비밀번호 401', async () => {
  const r = await request(app).post(`/api/rooms/${roomId}/join`).send({ name: '참석자', password: 'nope' });
  assert.equal(r.status, 401);
});

test('맞는 비밀번호 → guest 토큰(관리 권한 없음)', async () => {
  const r = await request(app).post(`/api/rooms/${roomId}/join`).send({ name: '참석자 A', password: 'pw-778899' });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'guest');
  const c = decodeJwt(r.body.token);
  assert.equal(c.video.room, roomId);
  assert.equal(c.video.roomJoin, true);
  assert.ok(!c.video.roomAdmin);
  assert.equal(JSON.parse(c.metadata).role, 'guest');
  assert.ok(c.exp - Math.floor(Date.now() / 1000) <= 120 + 5);
  assert.ok(calls.some((x) => x[0] === 'create' && x[1] === roomId));
});

test('호스트 키로 입장 → host (비밀번호 불필요)', async () => {
  const r = await request(app).post(`/api/rooms/${roomId}/join`).send({ name: '담당자', hostKey });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'host');
});

test('호스트 제어: 키 없으면 403', async () => {
  const r = await request(app).post(`/api/rooms/${roomId}/lock`).send({ locked: true });
  assert.equal(r.status, 403);
});

test('잠금 → guest 423, host 는 입장 가능', async () => {
  let r = await request(app).post(`/api/rooms/${roomId}/lock`).set('X-Host-Key', hostKey).send({ locked: true });
  assert.equal(r.status, 200); assert.equal(r.body.locked, true);
  r = await request(app).post(`/api/rooms/${roomId}/join`).send({ name: 'B', password: 'pw-778899' });
  assert.equal(r.status, 423);
  r = await request(app).post(`/api/rooms/${roomId}/join`).send({ name: '담당자', hostKey });
  assert.equal(r.status, 200);
  await request(app).post(`/api/rooms/${roomId}/lock`).set('X-Host-Key', hostKey).send({ locked: false });
});

test('정원 초과 409', async () => {
  participants = new Array(20).fill({});
  const r = await request(app).post(`/api/rooms/${roomId}/join`).send({ name: 'C', password: 'pw-778899' });
  assert.equal(r.status, 409);
  participants = [];
});

test('비밀번호 변경 후 구 비밀번호 거부', async () => {
  let r = await request(app).post(`/api/rooms/${roomId}/password`).set('X-Host-Key', hostKey).send({ password: 'new-pass-1' });
  assert.equal(r.status, 200);
  r = await request(app).post(`/api/rooms/${roomId}/join`).send({ name: 'D', password: 'pw-778899' });
  assert.equal(r.status, 401);
  r = await request(app).post(`/api/rooms/${roomId}/join`).send({ name: 'D', password: 'new-pass-1' });
  assert.equal(r.status, 200);
});

test('음소거·내보내기 입력 검증', async () => {
  let r = await request(app).post(`/api/rooms/${roomId}/mute`).set('X-Host-Key', hostKey).send({ identity: 'bad', trackSid: 'TR_x' });
  assert.equal(r.status, 400);
  r = await request(app).post(`/api/rooms/${roomId}/mute`).set('X-Host-Key', hostKey).send({ identity: 'g_0123456789ab', trackSid: 'TR_AbC123' });
  assert.equal(r.status, 200);
  r = await request(app).post(`/api/rooms/${roomId}/remove`).set('X-Host-Key', hostKey).send({ identity: 'g_0123456789ab' });
  assert.equal(r.status, 200);
});

test('비밀번호 대입 속도 제한 (실패 10회 후 429)', async () => {
  const cr = await request(app).post('/api/rooms').send({ title: 'rl', hostCode: 'host-code-1234', password: 'secret-99' });
  const id = cr.body.roomId;
  let last;
  for (let i = 0; i < 11; i++) last = await request(app).post(`/api/rooms/${id}/join`).send({ name: 'x', password: `bad${i}` });
  assert.equal(last.status, 429);
});

test('대기실: 비밀번호 맞아도 202 대기 → 호스트 승인 후 토큰', async () => {
  const cr = await request(app).post('/api/rooms').send({ title: 'wait', hostCode: 'host-code-1234', password: 'wait-pass-1' });
  assert.equal(cr.status, 201);
  const id = cr.body.roomId, hk = cr.body.hostKey;
  assert.equal((await request(app).get(`/api/rooms/${id}`)).body.waiting, true);
  // 틀린 비번은 대기열에도 못 들어감
  assert.equal((await request(app).post(`/api/rooms/${id}/join`).send({ name: 'x', password: 'nope' })).status, 401);
  const j = await request(app).post(`/api/rooms/${id}/join`).send({ name: '참석자 <i>K</i>', password: 'wait-pass-1' });
  assert.equal(j.status, 202);
  assert.equal(j.body.status, 'waiting');
  assert.ok(!j.body.token);
  const { reqId, waitKey } = j.body;
  // 키 없이 조회 403, 키로 조회 pending
  assert.equal((await request(app).get(`/api/rooms/${id}/requests/${reqId}`)).status, 403);
  assert.equal((await request(app).get(`/api/rooms/${id}/requests/${reqId}`).set('X-Wait-Key', waitKey)).body.status, 'pending');
  // 호스트 목록: 키 없으면 403, 있으면 1건(이름 원문 그대로, 비밀값 미포함)
  assert.equal((await request(app).get(`/api/rooms/${id}/requests`)).status, 403);
  const list = await request(app).get(`/api/rooms/${id}/requests`).set('X-Host-Key', hk);
  assert.equal(list.body.requests.length, 1);
  assert.deepEqual(Object.keys(list.body.requests[0]).sort(), ['createdAt', 'name', 'reqId']);
  // 게스트가 스스로 승인 불가
  assert.equal((await request(app).post(`/api/rooms/${id}/requests/${reqId}`).set('X-Wait-Key', waitKey).send({ action: 'approve' })).status, 403);
  assert.equal((await request(app).post(`/api/rooms/${id}/requests/${reqId}`).set('X-Host-Key', hk).send({ action: 'approve' })).status, 200);
  const ok = await request(app).get(`/api/rooms/${id}/requests/${reqId}`).set('X-Wait-Key', waitKey);
  assert.equal(ok.body.status, 'joined');
  assert.ok(ok.body.token);
  assert.equal(JSON.parse(Buffer.from(ok.body.token.split('.')[1], 'base64url').toString()).metadata.includes('guest'), true);
  // 토큰은 한 번만: 다시 조회하면 만료
  assert.equal((await request(app).get(`/api/rooms/${id}/requests/${reqId}`).set('X-Wait-Key', waitKey)).status, 404);
});

test('대기실: 거절·취소·끄기', async () => {
  const cr = await request(app).post('/api/rooms').send({ title: 'wait2', hostCode: 'host-code-1234', password: 'wait-pass-2' });
  const id = cr.body.roomId, hk = cr.body.hostKey;
  const j = await request(app).post(`/api/rooms/${id}/join`).send({ name: 'A', password: 'wait-pass-2' });
  await request(app).post(`/api/rooms/${id}/requests/${j.body.reqId}`).set('X-Host-Key', hk).send({ action: 'deny' });
  const d = await request(app).get(`/api/rooms/${id}/requests/${j.body.reqId}`).set('X-Wait-Key', j.body.waitKey);
  assert.equal(d.status, 403); assert.equal(d.body.status, 'denied');
  const j2 = await request(app).post(`/api/rooms/${id}/join`).send({ name: 'B', password: 'wait-pass-2' });
  await request(app).delete(`/api/rooms/${id}/requests/${j2.body.reqId}`).set('X-Wait-Key', j2.body.waitKey);
  assert.equal((await request(app).get(`/api/rooms/${id}/requests`).set('X-Host-Key', hk)).body.requests.length, 0);
  // 호스트는 대기 없이 입장
  assert.equal((await request(app).post(`/api/rooms/${id}/join`).send({ name: 'H', hostKey: hk })).body.status, 'joined');
  // 대기실 끄면 바로 입장
  assert.equal((await request(app).post(`/api/rooms/${id}/waiting`).set('X-Host-Key', hk).send({ enabled: false })).body.waiting, false);
  const j3 = await request(app).post(`/api/rooms/${id}/join`).send({ name: 'C', password: 'wait-pass-2' });
  assert.equal(j3.status, 200); assert.ok(j3.body.token);
});

test('대기실: 승인 뒤 호스트가 잠그면 토큰 미발급(423)', async () => {
  const cr = await request(app).post('/api/rooms').send({ title: 'wait3', hostCode: 'host-code-1234', password: 'wait-pass-3' });
  const id = cr.body.roomId, hk = cr.body.hostKey;
  const j = await request(app).post(`/api/rooms/${id}/join`).send({ name: 'A', password: 'wait-pass-3' });
  await request(app).post(`/api/rooms/${id}/requests/${j.body.reqId}`).set('X-Host-Key', hk).send({ action: 'approve' });
  await request(app).post(`/api/rooms/${id}/lock`).set('X-Host-Key', hk).send({ locked: true });
  const r = await request(app).get(`/api/rooms/${id}/requests/${j.body.reqId}`).set('X-Wait-Key', j.body.waitKey);
  assert.equal(r.status, 423);
  assert.ok(!r.body.token);
});

test('이름: 양방향 조작·폭 없는 문자 제거', async () => {
  const cr = await request(app).post('/api/rooms').send({ title: 'nm', hostCode: 'host-code-1234', password: 'name-pass-1', waiting: false });
  const r = await request(app).post(`/api/rooms/${cr.body.roomId}/join`).send({ name: '‮참석자​A⁦', password: 'name-pass-1' });
  assert.equal(r.status, 200);
  assert.equal(decodeJwt(r.body.token).name, '참석자A');
});

test('속도 제한 키: IPv6 는 /64 로 묶음', () => {
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8::5'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
});

test('회의 종료 → 이후 404, 종료된 회의는 호스트 제어로 되살아나지 않음', async () => {
  let r = await request(app).post(`/api/rooms/${roomId}/end`).set('X-Host-Key', hostKey).send({});
  assert.equal(r.status, 200);
  r = await request(app).get(`/api/rooms/${roomId}`);
  assert.equal(r.status, 404);
  r = await request(app).post(`/api/rooms/${roomId}/lock`).set('X-Host-Key', hostKey).send({ locked: true });
  assert.equal(r.status, 404);
  assert.equal((await request(app).get(`/api/rooms/${roomId}`)).status, 404);
});

test('잘못된 JSON 400', async () => {
  const r = await request(app).post('/api/rooms').set('Content-Type', 'application/json').send('{bad');
  assert.equal(r.status, 400);
});

test.after(() => setTimeout(() => process.exit(0), 50));
