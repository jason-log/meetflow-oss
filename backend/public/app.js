/* MeetFlow v0.2 — LiveKit 실송수신 클라이언트 (빌드 단계 없음, CSP 'self' 전용) */
(() => {
  'use strict';

  const LK = window.LivekitClient;
  const { Room, RoomEvent, Track, DisconnectReason, VideoPresets } = LK || {};
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const state = {
    roomId: '',
    title: '',
    role: 'guest',
    hostKey: null,
    locked: false,
    room: null,
    joinedName: '',
    preStream: null,
    preMic: true,
    preCam: true,
    micId: '',
    camId: '',
    spkId: '',
    handRaised: false,
    hands: new Set(),
    speaking: new Set(),
    pinned: null,
    lastScreens: new Set(),
    panel: null,
    unread: 0,
    tiles: new Map(),
    leaving: false,
    connected: false,
  };

  // ------------------------------------------------------------ 공통
  function show(view) {
    for (const v of ['view-create', 'view-join', 'view-meeting', 'view-ended']) $(v).hidden = v !== view;
    const inMeeting = view === 'view-meeting';
    $('topbar-room').hidden = !inMeeting;
    $('topbar-actions').hidden = !inMeeting;
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.className = isError ? 'toast toast-error' : 'toast';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function banner(msg) {
    const el = $('banner');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  async function api(path, { method = 'GET', body, host = false, headers: extra } = {}) {
    const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
    if (host && state.hostKey) headers['X-Host-Key'] = state.hostKey;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let data = {};
    try { data = await res.json(); } catch { /* 빈 응답 */ }
    if (!res.ok) {
      const err = new Error(data.error || `요청 실패 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* noop */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* noop */ } },
  };
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* noop */ } },
  };

  function inviteUrl() {
    return `${location.origin}/?room=${encodeURIComponent(state.roomId)}`;
  }

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}을(를) 복사했습니다.`);
    } catch {
      window.prompt('아래 내용을 복사하세요.', text);
    }
  }

  function roleOf(p) {
    try { return JSON.parse(p.metadata || '{}').role === 'host' ? 'host' : 'guest'; } catch { return 'guest'; }
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ------------------------------------------------------------ 회의 만들기
  function initCreate() {
    show('view-create');
    $('form-create').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = $('btn-create');
      btn.disabled = true;
      try {
        const password = $('c-password').value;
        const data = await api('/api/rooms', {
          method: 'POST',
          body: { title: $('c-title').value, hostCode: $('c-hostcode').value, password, waiting: $('c-waiting').checked },
        });
        state.roomId = data.roomId;
        state.title = data.title;
        state.hostKey = data.hostKey;
        ss.set(`mf_host_${data.roomId}`, data.hostKey);
        ls.set('mf_name', $('c-name').value.trim());
        history.replaceState(null, '', `/?room=${data.roomId}`);
        $('invite-url').textContent = inviteUrl();
        $('invite-pw').textContent = password;
        $('invite-card').hidden = false;
        $('form-create').hidden = true;
        $('c-hostcode').value = '';
        const hours = Math.round(data.expiresInSec / 3600);
        $('btn-copy-invite-text').onclick = () => copy(
          `[화상회의 초대] ${data.title}\n접속 링크: ${inviteUrl()}\n회의 비밀번호: ${password}\n(크롬·엣지 최신 버전 권장, 링크는 ${hours}시간 동안 유효)`,
          '초대 문구'
        );
        $('btn-go-join').onclick = () => { $('invite-pw').textContent = ''; initJoin(); };
      } catch (e) {
        toast(e.message, true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------ 입장 대기실
  async function initJoin() {
    show('view-join');
    state.hostKey = ss.get(`mf_host_${state.roomId}`);
    let info;
    try {
      info = await api(`/api/rooms/${encodeURIComponent(state.roomId)}`);
    } catch (e) {
      $('join-title').textContent = '입장할 수 없습니다';
      $('join-sub').textContent = e.message;
      $('form-join').hidden = true;
      return;
    }
    state.title = info.title;
    state.locked = info.locked;
    document.title = `${info.title} — MeetFlow`;
    $('join-title').textContent = info.title;
    $('join-sub').textContent = state.hostKey
      ? '호스트로 입장합니다.'
      : info.locked ? '호스트가 회의를 잠가 두었습니다. 잠금이 풀리면 입장할 수 있습니다.' : '이름과 회의 비밀번호를 입력하고 입장하세요.';
    $('j-password-wrap').hidden = !!state.hostKey;
    $('j-name').value = ls.get('mf_name') || '';

    // 권한 팝업을 기다리는 동안에도 입장 버튼이 동작하도록 미리보기는 기다리지 않는다
    startPreview();
    if (navigator.mediaDevices) navigator.mediaDevices.ondevicechange = () => (state.room ? fillMeetingDevices() : fillPreDevices());

    $('btn-pre-mic').onclick = () => { state.preMic = !state.preMic; syncPreButtons(); };
    $('btn-pre-cam').onclick = async () => { state.preCam = !state.preCam; syncPreButtons(); await startPreview(); };
    $('sel-mic').onchange = () => { state.micId = $('sel-mic').value; startPreview(); };
    $('sel-cam').onchange = () => { state.camId = $('sel-cam').value; startPreview(); };
    $('sel-spk').onchange = () => setSpeaker($('sel-spk').value);
    $('btn-pre-spk-test').onclick = playTestTone;
    $('form-join').onsubmit = onJoinSubmit;
    syncPreButtons();
  }

  // ON/OFF 토글 표시(현재 상태를 보여 준다 — 누르면 반대로 바뀐다)
  function setToggle(id, on) {
    const b = $(id);
    if (!b) return;
    b.classList.toggle('on', !!on);
    b.classList.toggle('off', !on);
    b.setAttribute('aria-pressed', String(!!on));
    const st = b.querySelector('.st');
    if (st) st.textContent = on ? 'ON' : 'OFF';
    const lbl = b.querySelector('.lbl');
    b.title = `${lbl ? lbl.textContent : ''} ${on ? '켜짐 — 누르면 끕니다' : '꺼짐 — 누르면 켭니다'}`;
  }

  function syncPreButtons() {
    setToggle('btn-pre-mic', state.preMic);
    setToggle('btn-pre-cam', state.preCam);
  }

  let previewGen = 0;
  function stopPreview() {
    previewGen++;
    if (state.preStream) state.preStream.getTracks().forEach((t) => t.stop());
    state.preStream = null;
    $('preview-video').srcObject = null;
  }

  async function startPreview() {
    stopPreview();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('preview-off').textContent = '이 브라우저(또는 http 접속)에서는 카메라를 쓸 수 없습니다. https 주소인지 확인하세요.';
      $('preview-off').hidden = false;
      return;
    }
    const gen = previewGen;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: state.micId ? { deviceId: { exact: state.micId } } : true,
        video: state.preCam ? (state.camId ? { deviceId: { exact: state.camId } } : true) : false,
      });
      if (gen !== previewGen || state.room) { stream.getTracks().forEach((t) => t.stop()); return; } // 그 사이 입장·재시작됨
      state.preStream = stream;
      $('preview-video').srcObject = state.preCam ? state.preStream : null;
      $('preview-off').textContent = '카메라 꺼짐';
      $('preview-off').hidden = state.preCam;
    } catch (e) {
      $('preview-off').textContent = '카메라·마이크 권한이 없거나 장치를 찾지 못했습니다. 권한 없이도 입장해 보고 듣기는 가능합니다.';
      $('preview-off').hidden = false;
    }
    await fillPreDevices();
  }

  async function listDevices(kind) {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === kind);
    } catch { return []; }
  }

  function fillSelect(sel, devices, current) {
    sel.replaceChildren();
    devices.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `장치 ${i + 1}`;
      sel.appendChild(o);
    });
    if (current && devices.some((d) => d.deviceId === current)) sel.value = current;
  }

  async function fillPreDevices() {
    fillSelect($('sel-mic'), await listDevices('audioinput'), state.micId);
    fillSelect($('sel-cam'), await listDevices('videoinput'), state.camId);
    fillSelect($('sel-spk'), await listDevices('audiooutput'), state.spkId);
  }

  // ------------------------------------------------------------ 스피커(출력 장치)
  // Windows 는 모니터 내장 오디오(HDMI/DP)가 '기본값'인 경우가 많아, 출력 장치를 직접 고르고 시험음으로 확인하게 한다.
  const CAN_PICK_SPEAKER = typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function';

  function setSpeaker(id) {
    state.spkId = id || '';
    ls.set('mf_spk', state.spkId);
    document.querySelectorAll('#audio-sink audio').forEach(applySpeaker);
    if (state.room && state.spkId) state.room.switchActiveDevice('audiooutput', state.spkId).catch(() => {});
  }

  async function playTestTone() {
    try {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const dst = ac.createMediaStreamDestination();
      osc.frequency.value = 660;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(dst);
      const a = new Audio();
      a.srcObject = dst.stream;
      if (state.spkId && CAN_PICK_SPEAKER) await a.setSinkId(state.spkId);
      osc.start();
      await a.play();
      setTimeout(() => { osc.stop(); a.pause(); a.srcObject = null; ac.close(); }, 800);
      const sel = $('sel-spk-in').options.length ? $('sel-spk-in') : $('sel-spk');
      const label = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '기본 장치';
      toast(`시험음을 '${label}' 으로 냈습니다.`);
    } catch (e) {
      toast(`시험음 재생 실패: ${e.message}`, true);
    }
  }

  async function onJoinSubmit(ev) {
    ev.preventDefault();
    const name = $('j-name').value.trim();
    if (!name) return toast('이름을 입력해 주세요.', true);
    const btn = $('btn-join');
    btn.disabled = true;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/join`, {
        method: 'POST',
        body: { name, password: $('j-password').value, hostKey: state.hostKey || undefined },
      });
      ls.set('mf_name', name);
      state.joinedName = name;
      if (data.status === 'waiting') { enterWaiting(data); return; }
      await afterJoin(data);
    } catch (e) {
      toast(e.message, true);
      if (!state.room) await startPreview();
    } finally {
      btn.disabled = false;
    }
  }

  async function afterJoin(data) {
    state.role = data.role;
    state.locked = data.locked;
    state.title = data.title;
    state.waitingOn = data.waiting !== false;
    if (data.role !== 'host') { state.hostKey = null; ss.del(`mf_host_${state.roomId}`); }
    stopPreview();
    await connectRoom(data.livekitUrl, data.token);
  }

  // ------------------------------------------------------------ 대기실 — 참석자 쪽(승인 대기)
  const wait = { reqId: null, key: null, timer: null };

  function setJoinFormLocked(locked) {
    ['j-name', 'j-password', 'btn-pre-mic', 'btn-pre-cam', 'sel-mic', 'sel-cam', 'sel-spk'].forEach((id) => { if ($(id)) $(id).disabled = locked; });
    $('btn-join').hidden = locked;
    $('waiting-box').hidden = !locked;
  }

  function enterWaiting(data) {
    wait.reqId = data.reqId;
    wait.key = data.waitKey;
    setJoinFormLocked(true);
    clearInterval(wait.timer);
    wait.timer = setInterval(pollWaiting, 2000);
    pollWaiting();
  }

  function stopWaiting() {
    clearInterval(wait.timer);
    wait.timer = null;
    wait.reqId = null;
    wait.key = null;
    setJoinFormLocked(false);
  }

  let waitBusy = false;
  async function pollWaiting() {
    if (!wait.reqId || waitBusy) return;
    waitBusy = true;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/requests/${wait.reqId}`, { headers: { 'X-Wait-Key': wait.key } });
      if (data.status === 'joined') {
        stopWaiting();
        toast('호스트가 입장을 수락했습니다.');
        await afterJoin(data);
      }
    } catch (e) {
      if (e.status === 403 || e.status === 404 || e.status === 409) {
        stopWaiting();
        toast(e.message, true);
      } // 그 밖(일시적 네트워크 오류)은 다음 주기에 다시 시도
    } finally {
      waitBusy = false;
    }
  }

  // ------------------------------------------------------------ 대기실 — 호스트 쪽(승인)
  const hostWait = { timer: null, list: [], seen: new Set() };

  function startHostPoll() {
    stopHostPoll();
    hostWait.seen = new Set();
    hostWait.timer = setInterval(pollRequests, 2500);
    pollRequests();
  }
  function stopHostPoll() {
    clearInterval(hostWait.timer);
    hostWait.timer = null;
    hostWait.list = [];
    renderWaiting();
  }

  async function pollRequests() {
    if (state.role !== 'host' || !state.room) return;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/requests`, { host: true });
      state.waitingOn = data.waiting;
      setToggle('set-waiting', state.waitingOn);
      hostWait.list = data.requests || [];
      for (const r of hostWait.list) {
        if (!hostWait.seen.has(r.reqId)) {
          hostWait.seen.add(r.reqId);
          toast(`${r.name} 님이 입장을 요청했습니다. [참석자]에서 수락하세요.`);
          sysMsg(`${r.name} 님이 입장을 기다리고 있습니다.`);
        }
      }
      renderWaiting();
    } catch { /* 다음 주기 */ }
  }

  function renderWaiting() {
    const list = hostWait.list;
    $('waiting-section').hidden = !(state.role === 'host' && list.length);
    $('people-badge').hidden = !(state.role === 'host' && list.length);
    $('waiting-count').textContent = list.length ? `(${list.length})` : '';
    const box = $('waiting-list');
    box.replaceChildren();
    for (const r of list) {
      const row = el('div', 'person');
      const info = el('div', 'person-info');
      const mins = Math.max(0, Math.round((Date.now() - new Date(r.createdAt).getTime()) / 60000));
      info.append(el('span', 'person-name', r.name), el('span', 'person-tags muted small', mins ? `${mins}분째 대기` : '방금 요청'));
      const actions = el('div', 'person-actions');
      const ok = el('button', 'btn btn-small btn-primary', '수락');
      ok.type = 'button';
      ok.onclick = () => decide(r, 'approve');
      const no = el('button', 'btn btn-small btn-danger', '거절');
      no.type = 'button';
      no.onclick = () => decide(r, 'deny');
      actions.append(ok, no);
      row.append(info, actions);
      box.append(row);
    }
  }

  async function decide(r, action) {
    try {
      await api(`/api/rooms/${encodeURIComponent(state.roomId)}/requests/${r.reqId}`, { method: 'POST', body: { action }, host: true });
      hostWait.list = hostWait.list.filter((x) => x.reqId !== r.reqId);
      renderWaiting();
      if (action === 'approve') sysMsg(`${r.name} 님의 입장을 수락했습니다.`);
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ 진단 (?relay=1 중계 강제, ?diag=1 연결 경로 조회)
  const qs = new URLSearchParams(location.search);
  const RELAY_ONLY = qs.get('relay') === '1';
  if (qs.get('diag') === '1' || RELAY_ONLY) {
    // 선택된 ICE 후보쌍(host/srflx/relay, udp/tcp/tls)을 돌려준다 — 기관망 접속 점검용
    window.meetflowDiag = async () => {
      const room = state.room;
      if (!room) return null;
      const out = [];
      const tracks = [];
      room.localParticipant.trackPublications.forEach((p) => p.track && tracks.push(['local', p.source, p.track]));
      room.remoteParticipants.forEach((rp) => rp.trackPublications.forEach((p) => p.track && tracks.push([rp.name, p.source, p.track])));
      for (const [who, source, track] of tracks) {
        if (typeof track.getRTCStatsReport !== 'function') continue;
        const rep = await track.getRTCStatsReport();
        if (!rep) continue;
        const byId = new Map();
        rep.forEach((s) => byId.set(s.id, s));
        rep.forEach((s) => {
          if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') {
            const l = byId.get(s.localCandidateId) || {};
            const r = byId.get(s.remoteCandidateId) || {};
            out.push({ who, source, local: `${l.candidateType}/${l.protocol}${l.relayProtocol ? '/' + l.relayProtocol : ''}`, remote: `${r.candidateType}/${r.protocol}`, rttMs: s.currentRoundTripTime != null ? Math.round(s.currentRoundTripTime * 1000) : null });
          }
        });
      }
      return out;
    };
  }

  // ------------------------------------------------------------ 회의 연결
  async function connectRoom(url, token) {
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      publishDefaults: { simulcast: true },
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution, deviceId: state.camId || undefined },
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: state.micId || undefined },
    });
    state.room = room;
    state.leaving = false;
    state.connected = false;
    state.hands.clear();
    state.handRaised = false;
    state.lastScreens = new Set();

    room
      .on(RoomEvent.ParticipantConnected, (p) => {
        sysMsg(`${p.name || p.identity} 님이 입장했습니다.`);
        if (state.handRaised) sendHand();
        if (rec.on) sendRecState();
        render();
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        sysMsg(`${p.name || p.identity} 님이 나갔습니다.`);
        state.hands.delete(p.identity);
        if (state.recBy && roleOf(p) === 'host' && state.recBy === (p.name || p.identity)) { state.recBy = null; syncRecUi(); }
        if (state.pinned && state.pinned.startsWith(`${p.identity}:`)) state.pinned = null;
        render();
      })
      .on(RoomEvent.TrackSubscribed, (track, pub) => {
        if (track.kind === Track.Kind.Audio) {
          const a = track.attach();
          $('audio-sink').appendChild(a);
          applySpeaker(a);
          if (pub) recMixAdd(pub.trackSid, track.mediaStreamTrack);
        }
        render();
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub) => {
        if (track.kind === Track.Kind.Audio) track.detach().forEach((e) => e.remove());
        if (pub) recMixRemove(pub.trackSid);
        render();
      })
      .on(RoomEvent.TrackPublished, render)
      .on(RoomEvent.TrackUnpublished, render)
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.source === Track.Source.Microphone && pub.track) recMixAdd(`local:${pub.trackSid}`, pub.track.mediaStreamTrack);
        render();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) toast('화면 공유를 종료했습니다.');
        render();
      })
      .on(RoomEvent.TrackMuted, (pub, p) => {
        if (p === room.localParticipant) {
          if (pub.source === Track.Source.Microphone && state.role !== 'host' && Date.now() - (state.selfMicAt || 0) > 3000) toast('호스트가 마이크를 음소거했습니다.');
          if (pub.source === Track.Source.ScreenShare) {
            // 호스트가 화면 공유를 중지시킨 경우: 음소거가 아니라 공유 자체를 끝낸다
            room.localParticipant.setScreenShareEnabled(false).catch(() => {});
            toast('호스트가 화면 공유를 중지했습니다.');
          }
        }
        render();
      })
      .on(RoomEvent.TrackUnmuted, render)
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        state.speaking = new Set(speakers.map((s) => s.identity));
        updateSpeaking();
      })
      .on(RoomEvent.DataReceived, onData)
      .on(RoomEvent.Reconnecting, () => banner('연결이 불안정합니다. 다시 연결하는 중입니다…'))
      .on(RoomEvent.Reconnected, () => banner(null))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => { $('btn-audio-unlock').hidden = room.canPlaybackAudio; })
      .on(RoomEvent.MediaDevicesError, (e) => toast(`장치 오류: ${e.message}`, true))
      .on(RoomEvent.Disconnected, onDisconnected);

    banner('회의에 연결하는 중입니다…');
    try {
      await room.connect(url, token, RELAY_ONLY ? { rtcConfig: { iceTransportPolicy: 'relay' } } : undefined);
      if (RELAY_ONLY) toast('진단 모드: 모든 미디어를 TURN 중계로만 연결합니다.');
      state.connected = true;
    } catch (e) {
      banner(null);
      state.room = null;
      room.removeAllListeners();
      throw new Error(`미디어 서버 연결 실패: ${e.message || e}. 방화벽(UDP 7882·TCP 7881) 또는 서버 주소 설정을 확인하세요.`);
    }
    banner(null);

    show('view-meeting');
    $('meeting-title').textContent = state.title;
    $('meeting-code').textContent = state.roomId;
    document.querySelectorAll('.host-only').forEach((n) => { n.hidden = state.role !== 'host'; });
    $('role-badge').hidden = state.role !== 'host';
    syncLockUi();
    $('btn-screen').hidden = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    $('chat-list').replaceChildren();
    sysMsg('회의에 입장했습니다. 채팅은 서버에 저장되지 않습니다.');

    const lp = room.localParticipant;
    try { await lp.setMicrophoneEnabled(state.preMic); } catch (e) { toast(`마이크를 켜지 못했습니다: ${e.message}`, true); }
    try { await lp.setCameraEnabled(state.preCam); } catch (e) { toast(`카메라를 켜지 못했습니다: ${e.message}`, true); }
    $('btn-audio-unlock').hidden = room.canPlaybackAudio;
    if (state.spkId) room.switchActiveDevice('audiooutput', state.spkId).catch(() => {});
    if (state.role === 'host') { setToggle('set-waiting', state.waitingOn); startHostPoll(); }
    render();
    fillMeetingDevices();
  }

  function onDisconnected(reason) {
    if (!state.connected) return; // 최초 연결 실패는 connectRoom 의 catch 가 처리(대기실 유지)
    state.connected = false;
    stopHostPoll();
    stopRecording(); // 연결이 끊겨도 그때까지의 녹화는 저장
    state.recBy = null;
    syncRecUi();
    const room = state.room;
    state.room = null;
    banner(null);
    clearTiles();
    $('audio-sink').replaceChildren();
    let title = '회의에서 나왔습니다';
    let sub = '';
    if (reason === DisconnectReason.PARTICIPANT_REMOVED) { title = '호스트가 회의에서 내보냈습니다'; }
    else if (reason === DisconnectReason.ROOM_DELETED) { title = '회의가 종료되었습니다'; sub = '호스트가 회의를 종료했습니다.'; }
    else if (!state.leaving) { title = '연결이 끊어졌습니다'; sub = '네트워크를 확인한 뒤 다시 입장해 주세요.'; }
    $('ended-title').textContent = title;
    $('ended-sub').textContent = sub;
    $('btn-rejoin').hidden = reason === DisconnectReason.ROOM_DELETED;
    show('view-ended');
    if (room) room.removeAllListeners();
  }

  // ------------------------------------------------------------ 타일 렌더링
  function clearTiles() {
    for (const t of state.tiles.values()) {
      if (t.track) t.track.detach(t.video);
      t.root.remove();
    }
    state.tiles.clear();
  }

  function makeTile(key, p, source) {
    const root = el('div', 'tile');
    root.dataset.key = key;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // 오디오는 audio-sink 에서 재생
    const avatar = el('div', 'avatar');
    const label = el('div', 'label');
    const nameEl = el('span', 'name');
    const micEl = el('span', 'mic-off', '음소거');
    const handEl = el('span', 'hand', '손듦');
    label.append(handEl, nameEl, micEl);
    const pin = el('button', 'pin', '크게 보기');
    pin.type = 'button';
    pin.addEventListener('click', () => {
      state.pinned = state.pinned === key ? null : key;
      render();
    });
    root.append(video, avatar, label, pin);
    root.addEventListener('dblclick', () => pin.click());
    const t = { root, video, avatar, nameEl, micEl, handEl, pin, track: null, identity: p.identity, source };
    state.tiles.set(key, t);
    return t;
  }

  function render() {
    const room = state.room;
    if (!room) return;
    const people = [room.localParticipant, ...room.remoteParticipants.values()];
    const wanted = new Map();
    const screenKeys = [];

    for (const p of people) {
      wanted.set(`${p.identity}:camera`, { p, source: Track.Source.Camera });
      const sp = p.getTrackPublication(Track.Source.ScreenShare);
      if (sp && sp.track && !sp.isMuted) {
        const k = `${p.identity}:screen`;
        wanted.set(k, { p, source: Track.Source.ScreenShare });
        screenKeys.push(k);
      }
    }

    for (const [k, t] of state.tiles) {
      if (!wanted.has(k)) {
        if (t.track) t.track.detach(t.video);
        t.root.remove();
        state.tiles.delete(k);
      }
    }

    // 새 화면 공유(내 것 포함)가 시작되면 기존 '크게 보기' 고정을 풀고 그 화면을 크게 띄운다
    const fresh = screenKeys.filter((k) => !state.lastScreens.has(k));
    if (fresh.length) state.pinned = fresh[fresh.length - 1];
    state.lastScreens = new Set(screenKeys);

    if (state.pinned && !wanted.has(state.pinned)) state.pinned = null;
    const stageKey = state.pinned || screenKeys[0] || null;
    const stage = $('stage');
    const grid = $('grid');
    stage.hidden = !stageKey;
    $('view-meeting').classList.toggle('has-stage', !!stageKey);

    let gridCount = 0;
    for (const [k, { p, source }] of wanted) {
      const t = state.tiles.get(k) || makeTile(k, p, source);
      const pub = p.getTrackPublication(source);
      const track = pub && pub.track && !pub.isMuted ? pub.track : null;
      if (t.track !== track) {
        if (t.track) t.track.detach(t.video);
        if (track) track.attach(t.video);
        t.track = track;
      }
      const isLocal = p === room.localParticipant;
      const displayName = p.name || p.identity;
      t.nameEl.textContent = source === Track.Source.ScreenShare
        ? (isLocal ? '내가 공유 중인 화면' : `${displayName} 님의 화면`)
        : `${displayName}${isLocal ? ' (나)' : ''}${roleOf(p) === 'host' ? ' · 호스트' : ''}`;
      t.avatar.textContent = displayName.slice(0, 1);
      t.root.classList.toggle('no-video', !track);
      t.root.classList.toggle('mirror', isLocal && source === Track.Source.Camera);
      t.root.classList.toggle('screen', source === Track.Source.ScreenShare);
      t.micEl.hidden = source !== Track.Source.Camera || p.isMicrophoneEnabled;
      t.handEl.hidden = source !== Track.Source.Camera || !(isLocal ? state.handRaised : state.hands.has(p.identity));
      t.pin.textContent = state.pinned === k ? '크게 보기 해제' : '크게 보기';

      const parent = k === stageKey ? stage : grid;
      if (t.root.parentElement !== parent) {
        parent.appendChild(t.root);
        if (track) t.video.play().catch(() => {});
      }
      if (parent === grid) gridCount++;
    }
    grid.dataset.count = String(gridCount);
    fitGrid();
    updateSpeaking();
    renderControls();
    renderPeople();
  }

  // 타일 격자를 화면(브라우저 창) 안에 맞춘다 — 16:9 타일이 가장 커지는 열 수를 고르고 스크롤이 생기지 않게 한다
  function fitGrid() {
    const grid = $('grid');
    if (!grid) return;
    if ($('view-meeting').classList.contains('has-stage')) {
      grid.style.setProperty('--cols', '1');
      grid.style.removeProperty('--tile-w');
      return;
    }
    const n = Math.max(1, Number(grid.dataset.count) || 1);
    const W = grid.clientWidth;
    const H = grid.clientHeight;
    if (!W || !H) return;
    const gap = 8;
    let best = { cols: 1, w: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9);
      if (w > best.w) best = { cols, w };
    }
    grid.style.setProperty('--cols', String(best.cols));
    grid.style.setProperty('--tile-w', `${Math.max(80, Math.floor(best.w) - 1)}px`);
  }
  if (typeof ResizeObserver === 'function') {
    const g = $('grid');
    if (g) new ResizeObserver(() => fitGrid()).observe(g);
  } else {
    window.addEventListener('resize', () => fitGrid());
  }

  function updateSpeaking() {
    for (const t of state.tiles.values()) {
      t.root.classList.toggle('speaking', t.source === Track.Source.Camera && state.speaking.has(t.identity));
    }
  }

  function renderControls() {
    const lp = state.room && state.room.localParticipant;
    if (!lp) return;
    setToggle('btn-mic', lp.isMicrophoneEnabled);
    setToggle('btn-cam', lp.isCameraEnabled);
    setToggle('set-mic', lp.isMicrophoneEnabled);
    setToggle('set-cam', lp.isCameraEnabled);
    const sharing = lp.isScreenShareEnabled;
    $('btn-screen').textContent = sharing ? '공유 중지' : '화면 공유';
    $('btn-screen').classList.toggle('active', sharing);
    $('btn-hand').textContent = state.handRaised ? '손 내리기' : '손들기';
    $('btn-hand').classList.toggle('active', state.handRaised);
  }

  // ------------------------------------------------------------ 참석자 패널
  function renderPeople() {
    const room = state.room;
    if (!room) return;
    const people = [room.localParticipant, ...room.remoteParticipants.values()];
    $('people-count').textContent = `(${people.length})`;
    const list = $('people-list');
    list.replaceChildren();
    for (const p of people) {
      const isLocal = p === room.localParticipant;
      const row = el('div', 'person');
      const info = el('div', 'person-info');
      info.append(el('span', 'person-name', `${p.name || p.identity}${isLocal ? ' (나)' : ''}`));
      const tags = [];
      if (roleOf(p) === 'host') tags.push('호스트');
      if (!p.isMicrophoneEnabled) tags.push('음소거');
      if (isLocal ? state.handRaised : state.hands.has(p.identity)) tags.push('손듦');
      const ssPub = p.getTrackPublication(Track.Source.ScreenShare);
      if (ssPub && !ssPub.isMuted) tags.push('화면 공유 중');
      info.append(el('span', 'person-tags muted small', tags.join(' · ')));
      row.append(info);

      if (state.role === 'host' && !isLocal) {
        const actions = el('div', 'person-actions');
        const micPub = p.getTrackPublication(Track.Source.Microphone);
        if (micPub && !micPub.isMuted) {
          const m = el('button', 'btn btn-small', '음소거');
          m.type = 'button';
          m.onclick = () => hostAction('mute', { identity: p.identity, trackSid: micPub.trackSid }, `${p.name} 님을 음소거했습니다.`);
          actions.append(m);
        }
        const sp = p.getTrackPublication(Track.Source.ScreenShare);
        if (sp && !sp.isMuted) {
          const s = el('button', 'btn btn-small', '공유 중지');
          s.type = 'button';
          s.onclick = () => hostAction('mute', { identity: p.identity, trackSid: sp.trackSid }, `${p.name} 님의 화면 공유를 중지했습니다.`);
          actions.append(s);
        }
        const r = el('button', 'btn btn-small btn-danger', '내보내기');
        r.type = 'button';
        r.onclick = () => {
          if (window.confirm(`${p.name} 님을 회의에서 내보낼까요? 재입장을 막으려면 회의를 잠그거나 비밀번호를 바꾸세요.`)) {
            hostAction('remove', { identity: p.identity }, `${p.name} 님을 내보냈습니다.`);
          }
        };
        actions.append(r);
        row.append(actions);
      }
      list.append(row);
    }
  }

  async function hostAction(kind, body, okMsg) {
    try {
      await api(`/api/rooms/${encodeURIComponent(state.roomId)}/${kind}`, { method: 'POST', body, host: true });
      if (okMsg) toast(okMsg);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function syncLockUi() {
    $('lock-badge').hidden = !state.locked;
    $('btn-lock').textContent = state.locked ? '잠금 해제' : '회의 잠금';
  }

  // ------------------------------------------------------------ 채팅·손들기 (DataChannel)
  function publish(topic, obj) {
    if (!state.room) return Promise.resolve();
    return state.room.localParticipant.publishData(enc.encode(JSON.stringify(obj)), { reliable: true, topic });
  }

  function sendHand() {
    publish('hand', { raised: state.handRaised }).catch(() => {});
  }

  function onData(payload, participant, _kind, topic) {
    if (!participant) return; // 서버 발신 데이터는 무시
    let msg;
    try { msg = JSON.parse(dec.decode(payload)); } catch { return; }
    if (topic === 'chat' && msg && typeof msg.text === 'string') {
      addChat(participant.name || participant.identity, msg.text.slice(0, 1000), false);
      if (state.panel !== 'chat') {
        state.unread++;
        $('chat-badge').hidden = false;
      }
    } else if (topic === 'rec' && msg && typeof msg.on === 'boolean') {
      if (roleOf(participant) !== 'host') return; // 호스트만 녹화 상태를 알릴 수 있다
      const who = participant.name || participant.identity;
      const was = state.recBy;
      state.recBy = msg.on ? who : null;
      if (msg.on && !was) { sysMsg(`${who} 님(호스트)이 녹화 중입니다.`); toast('이 회의는 녹화되고 있습니다.'); }
      if (!msg.on && was) sysMsg(`${who} 님이 녹화를 중지했습니다.`);
      syncRecUi();
    } else if (topic === 'hand' && msg && typeof msg.raised === 'boolean') {
      if (msg.raised) state.hands.add(participant.identity); else state.hands.delete(participant.identity);
      if (msg.raised) toast(`${participant.name} 님이 손을 들었습니다.`);
      render();
    }
  }

  const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
  function linkify(target, text) {
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      if (m.index > last) target.append(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      target.append(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) target.append(document.createTextNode(text.slice(last)));
  }

  function timeNow() {
    return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }

  function addChat(from, text, mine) {
    const list = $('chat-list');
    const item = el('div', mine ? 'chat-item mine' : 'chat-item');
    const head = el('div', 'chat-head');
    head.append(el('span', 'chat-from', from), el('span', 'chat-time muted small', timeNow()));
    const body = el('p', 'chat-text');
    linkify(body, text);
    item.append(head, body);
    list.append(item);
    list.scrollTop = list.scrollHeight;
  }

  function sysMsg(text) {
    const list = $('chat-list');
    list.append(el('div', 'chat-sys muted small', `${timeNow()} ${text}`));
    list.scrollTop = list.scrollHeight;
  }

  // ------------------------------------------------------------ 사이드 패널
  function openPanel(name) {
    if (state.panel === name) name = null;
    state.panel = name;
    $('side').hidden = !name;
    $('view-meeting').classList.toggle('has-side', !!name);
    for (const p of ['chat', 'people', 'settings']) {
      $(`panel-${p}`).hidden = p !== name;
      $(`tab-${p}`).classList.toggle('active', p === name);
    }
    if (name === 'chat') {
      state.unread = 0;
      $('chat-badge').hidden = true;
      setTimeout(() => $('chat-input').focus(), 0);
    }
    if (name === 'settings') fillMeetingDevices();
  }

  async function fillMeetingDevices() {
    const room = state.room;
    if (!room) return;
    fillSelect($('sel-mic-in'), await listDevices('audioinput'), room.getActiveDevice('audioinput'));
    fillSelect($('sel-cam-in'), await listDevices('videoinput'), room.getActiveDevice('videoinput'));
    const spk = await listDevices('audiooutput');
    $('sel-spk-in').disabled = spk.length === 0;
    fillSelect($('sel-spk-in'), spk, state.spkId || room.getActiveDevice('audiooutput'));
  }

  function applySpeaker(audioEl) {
    const id = state.spkId;
    if (id && typeof audioEl.setSinkId === 'function') audioEl.setSinkId(id).catch(() => {});
  }

  // ------------------------------------------------------------ 녹화 (호스트 PC 저장, 서버 미저장)
  // 영상: 호스트가 고른 브라우저 탭(회의 화면) 캡처 / 음성: 내 마이크 + 모든 참석자 음성을 WebAudio로 합성
  // 저장: 지원 브라우저는 시작할 때 고른 파일에 1초 단위로 바로 기록(장시간 회의에도 메모리 부담 없음), 그 밖은 끝날 때 내려받기
  const rec = { on: false, recorder: null, ac: null, dst: null, sources: new Map(), display: null, writable: null, chunks: [], bytes: 0, startedAt: 0, timer: null, fileName: '' };
  state.recBy = null; // 다른 호스트가 녹화 중이면 그 이름

  function recMixAdd(key, mediaStreamTrack) {
    if (!rec.on || !rec.ac || !mediaStreamTrack || rec.sources.has(key)) return;
    try {
      const src = rec.ac.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
      src.connect(rec.dst);
      rec.sources.set(key, src);
    } catch { /* 이미 끝난 트랙 */ }
  }
  function recMixRemove(key) {
    const src = rec.sources.get(key);
    if (src) { try { src.disconnect(); } catch { /* noop */ } rec.sources.delete(key); }
  }
  function recMixAll() {
    const room = state.room;
    if (!room) return;
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (mic && mic.track) recMixAdd(`local:${mic.trackSid}`, mic.track.mediaStreamTrack);
    room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => {
      if (pub.track && pub.kind === Track.Kind.Audio) recMixAdd(pub.trackSid, pub.track.mediaStreamTrack);
    }));
  }

  function recFileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const safeTitle = (state.title || '회의').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    return `MeetFlow_${safeTitle}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.webm`;
  }

  function recMime() {
    const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  function sendRecState() {
    publish('rec', { on: rec.on }).catch(() => {});
  }

  function syncRecUi() {
    const btn = $('btn-rec');
    btn.textContent = rec.on ? '녹화 중지' : '녹화';
    btn.classList.toggle('rec-on', rec.on);
    $('rec-badge').hidden = !(rec.on || state.recBy);
    if (rec.on) {
      const s = Math.floor((Date.now() - rec.startedAt) / 1000);
      const mb = (rec.bytes / 1048576).toFixed(0);
      $('rec-badge').textContent = `● 녹화 중 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} · ${mb}MB`;
    } else if (state.recBy) {
      $('rec-badge').textContent = `● 녹화 중 (${state.recBy})`;
    }
  }

  async function startRecording() {
    if (!window.MediaRecorder || !navigator.mediaDevices.getDisplayMedia) return toast('이 브라우저는 녹화를 지원하지 않습니다. 크롬·엣지 최신판을 쓰세요.', true);
    if (!window.confirm('회의를 녹화합니다. 참석자 전원의 화면에 "녹화 중"이 표시됩니다.\n\n다음 창에서 「이 탭」(MeetFlow 회의 탭)을 선택하세요. 녹화 파일은 이 PC에만 저장되고 서버에는 남지 않습니다.')) return;
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15, displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
      });
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') toast(`녹화 화면 선택 실패: ${e.message}`, true);
      return;
    }
    rec.fileName = recFileName();
    rec.writable = null;
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: rec.fileName, types: [{ description: 'WebM 동영상', accept: { 'video/webm': ['.webm'] } }] });
        rec.writable = await handle.createWritable();
      } catch (e) {
        if (e && e.name === 'AbortError') { display.getTracks().forEach((t) => t.stop()); return; }
      }
    }
    rec.ac = new AudioContext();
    rec.dst = rec.ac.createMediaStreamDestination();
    // 무음 기준 신호(참석자가 모두 음소거여도 오디오 트랙이 끊기지 않게)
    const silent = rec.ac.createConstantSource();
    const g = rec.ac.createGain();
    g.gain.value = 0;
    silent.connect(g).connect(rec.dst);
    silent.start();
    rec.display = display;
    rec.on = true;
    rec.sources.clear();
    recMixAll();
    const stream = new MediaStream([display.getVideoTracks()[0], rec.dst.stream.getAudioTracks()[0]]);
    const mime = recMime();
    const mr = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 1500000, audioBitsPerSecond: 96000 });
    rec.chunks = [];
    rec.bytes = 0;
    let writeChain = Promise.resolve();
    mr.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      rec.bytes += ev.data.size;
      if (rec.writable) {
        const w = rec.writable;
        writeChain = writeChain.then(() => w.write(ev.data)).catch(() => {});
      } else rec.chunks.push(ev.data);
    };
    const writable = rec.writable;
    mr.onstop = async () => {
      await writeChain;
      if (writable) {
        try { await writable.close(); toast(`녹화 파일을 저장했습니다: ${rec.fileName}`); } catch (e) { toast(`녹화 저장 실패: ${e.message}`, true); }
      } else if (rec.chunks.length) {
        const blob = new Blob(rec.chunks, { type: mime || 'video/webm' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = rec.fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
        toast(`녹화 파일을 내려받았습니다: ${rec.fileName}`);
      }
      rec.chunks = [];
      rec.writable = null;
    };
    display.getVideoTracks()[0].addEventListener('ended', () => stopRecording());
    mr.start(1000);
    rec.recorder = mr;
    rec.startedAt = Date.now();
    rec.timer = setInterval(syncRecUi, 1000);
    // 늦게 들어온 참석자도 「● 녹화 중」을 확실히 보도록 녹화 중에는 5초마다 다시 알린다
    rec.beacon = setInterval(sendRecState, 5000);
    sendRecState();
    sysMsg(`${state.joinedName} 님(호스트)이 녹화를 시작했습니다.`);
    syncRecUi();
  }

  function stopRecording() {
    if (!rec.on) return;
    rec.on = false;
    clearInterval(rec.timer);
    clearInterval(rec.beacon);
    try { if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch { /* noop */ }
    if (rec.display) rec.display.getTracks().forEach((t) => t.stop());
    rec.sources.forEach((src) => { try { src.disconnect(); } catch { /* noop */ } });
    rec.sources.clear();
    const ac = rec.ac;
    rec.ac = null;
    setTimeout(() => { if (ac) ac.close().catch(() => {}); }, 1500);
    rec.display = null;
    rec.recorder = null;
    if (state.room) {
      sendRecState();
      sysMsg('녹화를 중지했습니다.');
    }
    syncRecUi();
  }

  // ------------------------------------------------------------ 버튼 연결
  function bindMeetingControls() {
    $('btn-mic').onclick = async () => {
      const lp = state.room.localParticipant;
      state.selfMicAt = Date.now(); // 내가 끈 음소거를 '호스트가 음소거' 로 오인하지 않게
      try { await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled); } catch (e) { toast(`마이크 오류: ${e.message}`, true); }
      render();
    };
    $('btn-cam').onclick = async () => {
      const lp = state.room.localParticipant;
      try { await lp.setCameraEnabled(!lp.isCameraEnabled); } catch (e) { toast(`카메라 오류: ${e.message}`, true); }
      render();
    };
    $('btn-screen').onclick = async () => {
      const lp = state.room.localParticipant;
      const turningOn = !lp.isScreenShareEnabled;
      // 회의 탭 자신은 공유 목록에서 빼고(무한 거울 방지), 공유를 시작해도 회의 탭에 머문다(크롬·엣지)
      const opts = { audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' };
      if (turningOn && typeof window.CaptureController === 'function') {
        try {
          const ctl = new window.CaptureController();
          if (typeof ctl.setFocusBehavior === 'function') ctl.setFocusBehavior('no-focus-change');
          opts.controller = ctl;
        } catch (_) { /* 미지원 브라우저는 기본 동작 */ }
      }
      try {
        await lp.setScreenShareEnabled(turningOn, opts);
      } catch (e) {
        if (e && e.name !== 'NotAllowedError') toast(`화면 공유 오류: ${e.message}`, true);
      }
      render();
    };
    $('btn-hand').onclick = () => {
      state.handRaised = !state.handRaised;
      sendHand();
      render();
    };
    $('btn-chat').onclick = () => openPanel('chat');
    $('btn-people').onclick = () => openPanel('people');
    $('tab-chat').onclick = () => openPanel('chat');
    $('tab-people').onclick = () => openPanel('people');
    $('tab-settings').onclick = () => openPanel('settings');
    $('btn-settings').onclick = () => openPanel('settings');
    $('btn-approve-all').onclick = async () => { for (const r of [...hostWait.list]) await decide(r, 'approve'); };
    $('btn-wait-cancel').onclick = async () => {
      const { reqId, key } = wait;
      stopWaiting();
      if (reqId) api(`/api/rooms/${encodeURIComponent(state.roomId)}/requests/${reqId}`, { method: 'DELETE', headers: { 'X-Wait-Key': key } }).catch(() => {});
      toast('입장 대기를 취소했습니다.');
    };
    $('set-waiting').onclick = async () => {
      try {
        const data = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/waiting`, { method: 'POST', body: { enabled: !state.waitingOn }, host: true });
        state.waitingOn = data.waiting;
        setToggle('set-waiting', state.waitingOn);
        toast(state.waitingOn ? '대기실을 켰습니다. 새 참석자는 수락 후 입장합니다.' : '대기실을 껐습니다. 비밀번호만 맞으면 바로 입장합니다.');
      } catch (e) { toast(e.message, true); }
    };
    $('set-mic').onclick = () => $('btn-mic').click();
    $('set-cam').onclick = () => $('btn-cam').click();
    $('btn-side-close').onclick = () => openPanel(null);
    $('btn-rec').onclick = () => (rec.on ? stopRecording() : startRecording());
    $('btn-leave').onclick = async () => {
      if (rec.on && !window.confirm('녹화 중입니다. 나가면 녹화를 끝내고 파일을 저장합니다. 나갈까요?')) return;
      state.leaving = true;
      if (state.room) await state.room.disconnect();
    };
    $('btn-audio-unlock').onclick = async () => {
      try { await state.room.startAudio(); } catch { /* noop */ }
      $('btn-audio-unlock').hidden = state.room ? state.room.canPlaybackAudio : true;
    };
    $('btn-copy-invite').onclick = () => copy(inviteUrl(), '초대 링크');
    $('btn-lock').onclick = async () => {
      try {
        const data = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/lock`, { method: 'POST', body: { locked: !state.locked }, host: true });
        state.locked = data.locked;
        syncLockUi();
        toast(state.locked ? '회의를 잠갔습니다. 새 참석자는 입장할 수 없습니다.' : '회의 잠금을 해제했습니다.');
      } catch (e) { toast(e.message, true); }
    };
    $('btn-end').onclick = async () => {
      if (!window.confirm('모든 참석자의 연결을 끊고 회의를 종료할까요? 초대 링크도 더 이상 쓸 수 없습니다.')) return;
      state.leaving = true;
      try {
        await api(`/api/rooms/${encodeURIComponent(state.roomId)}/end`, { method: 'POST', body: {}, host: true });
        ss.del(`mf_host_${state.roomId}`);
      } catch (e) {
        state.leaving = false;
        toast(e.message, true);
      }
    };
    $('btn-change-pw').onclick = async () => {
      const pw = $('new-password').value;
      if (pw.length < 6) return toast('비밀번호는 6자 이상이어야 합니다.', true);
      await hostAction('password', { password: pw }, '회의 비밀번호를 바꿨습니다. 이미 입장한 사람은 영향을 받지 않습니다.');
      $('new-password').value = '';
    };
    $('form-chat').onsubmit = async (ev) => {
      ev.preventDefault();
      const input = $('chat-input');
      const text = input.value.trim().slice(0, 1000);
      if (!text || !state.room) return;
      try {
        await publish('chat', { text });
        addChat(`${state.joinedName} (나)`, text, true);
        input.value = '';
      } catch (e) { toast(`전송 실패: ${e.message}`, true); }
    };
    $('sel-mic-in').onchange = (e) => state.room && state.room.switchActiveDevice('audioinput', e.target.value).catch((er) => toast(er.message, true));
    $('sel-cam-in').onchange = (e) => state.room && state.room.switchActiveDevice('videoinput', e.target.value).catch((er) => toast(er.message, true));
    $('sel-spk-in').onchange = (e) => setSpeaker(e.target.value);
    $('btn-spk-test').onclick = playTestTone;
    $('btn-rejoin').onclick = () => initJoin();
    window.addEventListener('beforeunload', () => { if (state.room) state.room.disconnect(); });
  }

  // ------------------------------------------------------------ 시작
  function boot() {
    if (!LK || !Room) {
      document.body.textContent = '화상회의 라이브러리를 불러오지 못했습니다. 새로고침하거나 관리자에게 문의하세요.';
      return;
    }
    const check = LK.isBrowserSupported ? LK.isBrowserSupported() : true;
    if (!check) toast('이 브라우저는 지원되지 않을 수 있습니다. 크롬·엣지·사파리 최신 버전을 사용하세요.', true);
    state.spkId = ls.get('mf_spk') || '';
    if (!CAN_PICK_SPEAKER) document.querySelectorAll('.spk-wrap').forEach((n) => { n.hidden = true; });
    bindMeetingControls();
    const id = (new URLSearchParams(location.search).get('room') || '').trim().toLowerCase();
    if (id) {
      state.roomId = id;
      initJoin();
    } else {
      initCreate();
    }
  }

  boot();
})();
