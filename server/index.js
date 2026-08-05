import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import QRCode from 'qrcode';

import { Room, PHASE } from './game.js';
import { decideSeat, decideStart, decideNight, decideDay, decideVote } from './bot-brain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// 클라우드 배포 시 QR 이 가리킬 공개 주소. Render 라면 https://xxx.onrender.com
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * 배포할 때마다 바뀌는 값. 정적 파일의 최종 수정 시각으로 만든다.
 * index.html 안의 자산 주소에 ?v=... 로 붙여서, 배포 직후에도
 * 브라우저가 예전 JS/CSS 를 계속 쓰는 일이 없게 한다.
 */
function buildId() {
  let latest = 0;
  for (const f of ['app.js', 'style.css', 'narration.js', 'index.html']) {
    try { latest = Math.max(latest, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs); } catch { /* 무시 */ }
  }
  return Math.floor(latest).toString(36);
}
const BUILD = buildId();

// index.html 은 캐시하지 않고, 그 안의 자산 주소에만 버전을 박는다
app.get('/', (_req, res) => {
  try {
    const html = fs
      .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      .replace(/(href|src)="\/(app\.js|style\.css|narration\.js)"/g, `$1="/$2?v=${BUILD}"`);
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (e) {
    res.status(500).type('text').send('index.html 을 읽을 수 없습니다.');
  }
});

app.use(express.static(PUBLIC_DIR, { maxAge: IS_PROD ? '1h' : 0, etag: true }));
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── 방 저장소 ────────────────────────────────────────────────────
/** @type {Map<string, Room>} */
const rooms = new Map();
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6시간 뒤 정리

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자 제외
function newRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return 'R' + Date.now().toString(36).toUpperCase().slice(-4);
}

function newPlayerId() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  ).toUpperCase();
}

// ── 브로드캐스트 ─────────────────────────────────────────────────
function pushState(room) {
  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit('state', room.viewFor(p.id));
  }
}

function pushCues(room, cues = [], personal = []) {
  if (cues.length) {
    room.narrationSeq += 1;
    io.to(room.code).emit('cue', { seq: room.narrationSeq, cues, phase: room.phase, day: room.day });
  }
  for (const item of personal) {
    const p = room.players.get(item.playerId);
    if (!p?.socketId) continue;
    room.narrationSeq += 1;
    io.to(p.socketId).emit('cue', {
      seq: room.narrationSeq, cues: [item.cue], phase: room.phase, day: room.day,
    });
  }
}

function emitAll(room, result) {
  if (!result) return;
  pushCues(room, result.cues || [], result.personal || []);
  pushState(room);
}

// ── 페이즈 진행 ──────────────────────────────────────────────────
const AUTO_ANNOUNCE_MS = 8000;

/**
 * 현재 페이즈에서 다음 페이즈로 넘긴다.
 * force = 방장이 직접 넘긴 경우 (타이머 무시)
 */
function advance(room, force = false) {
  switch (room.phase) {
    case PHASE.ROLE_REVEAL: {
      // 진돗개가 아직 주인을 안 정했으면 강제 진행 시 무작위로 채운다
      if (room.startActionsPending().length) {
        if (!force) return;
        room.autoFillStartActions();
      }
      emitAll(room, room.beginNight());
      return;
    }
    case PHASE.NIGHT: {
      if (!force && !room.allNightActionsIn() && !isExpired(room)) return;
      emitAll(room, room.resolveNight());
      room.deadline = Date.now() + AUTO_ANNOUNCE_MS;
      pushState(room);
      return;
    }
    case PHASE.DAWN: {
      const win = room.checkWin();
      if (win) { emitAll(room, room.endGame(win)); return; }
      emitAll(room, room.beginDiscuss());
      return;
    }
    case PHASE.DISCUSS: {
      emitAll(room, room.beginVote());
      return;
    }
    case PHASE.VOTE: {
      if (!force && !room.allVotesIn() && !isExpired(room)) return;
      emitAll(room, room.resolveVote());
      room.deadline = Date.now() + AUTO_ANNOUNCE_MS;
      pushState(room);
      return;
    }
    case PHASE.EXECUTION: {
      const win = room.checkWin();
      if (win) { emitAll(room, room.endGame(win)); return; }
      room.nextDay();
      emitAll(room, room.beginNight());
      return;
    }
    default:
      return;
  }
}

function isExpired(room) {
  return room.deadline != null && Date.now() >= room.deadline;
}

// ── 방 안의 봇 ───────────────────────────────────────────────────
/**
 * 방에 들어와 있는 봇들을 한 번씩 행동시킨다.
 * 판단은 전부 bot-brain 이 하고, 입력은 사람과 똑같은 개인화 상태다.
 * 무언가 실제로 행동했으면 true 를 돌려준다.
 */
function runBots(room) {
  let acted = false;
  for (const bot of room.bots) {
    const view = room.viewFor(bot.id);
    try {
      switch (room.phase) {
        case PHASE.SEATING: {
          // 사람이 원하는 자리를 먼저 고르게 두고, 봇은 남은 자리를 채운다
          if (room.humans.some((h) => h.seat == null)) break;
          const seat = decideSeat(view);
          if (seat != null && room.claimSeat(bot.id, seat).ok) acted = true;
          break;
        }
        case PHASE.ROLE_REVEAL: {
          if (!room.needsStartAction(bot)) break;
          const d = decideStart(view);
          if (d && room.submitStartAction(bot.id, d.targetId).ok) acted = true;
          break;
        }
        case PHASE.NIGHT: {
          if (!room.canActNight(bot) || room.nightActions.has(bot.id)) break;
          const d = decideNight(view);
          if (d && room.submitNightAction(bot.id, d).ok) acted = true;
          break;
        }
        case PHASE.VOTE: {
          if (!bot.alive) break;
          if (room.canActDay(bot)) {
            const d = decideDay(view);
            if (d?.kind === 'SNIPE') {
              const r = room.snipe(bot.id, d.targetId, d.roleKey);
              if (r.ok) { pushCues(room, r.cues || []); acted = true; }
            } else if (d?.kind === 'FORCE_VOTE') {
              if (room.forceVote(bot.id, d.targetId).ok) acted = true;
            }
          }
          if (!room.ballots.has(bot.id)) {
            const v = decideVote(room.viewFor(bot.id));
            if (v && room.castVote(bot.id, v.targetId).ok) acted = true;
          }
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.error(`봇 행동 실패 (${room.code}/${bot.nickname}):`, e.message);
    }
  }
  return acted;
}

// 봇이 있는 방을 주기적으로 굴린다.
// 사람 조작이 없어도 밤·투표가 진행되어야 혼자서도 테스트할 수 있다.
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.bots.length) continue;
    if (room.phase === PHASE.LOBBY || room.phase === PHASE.END) continue;

    if (runBots(room)) pushState(room);

    // 봇이 마지막 한 명이었다면 바로 다음 단계로
    if (room.phase === PHASE.NIGHT && room.allNightActionsIn()) advance(room);
    else if (room.phase === PHASE.VOTE && room.allVotesIn()) advance(room);

    // 저격으로 게임이 끝났을 수도 있다
    if (room.phase !== PHASE.END) {
      const soloEnded = room.soloWins.length && room.phase === PHASE.VOTE;
      if (soloEnded) { const w = room.checkWin(); if (w) emitAll(room, room.endGame(w)); }
    }
  }
}, 600);

// 마감 시각이 지난 방을 자동으로 넘겨준다
setInterval(() => {
  for (const room of rooms.values()) {
    // 방장이 죽었거나 나가버려서 아무도 단계를 넘길 수 없는 상태면
    // (또는 자동 진행이 켜져 있으면) 마감 시각을 붙여 스스로 넘어가게 한다.
    if (room.deadline == null && room.phase !== PHASE.LOBBY && room.phase !== PHASE.END) {
      const hold = room.autoHoldFor(room.phase);
      if (hold != null) room.deadline = Date.now() + hold;
    }
    if (room.deadline && Date.now() >= room.deadline) {
      const before = room.phase;
      advance(room);
      if (room.phase === before && room.deadline && Date.now() >= room.deadline) {
        room.deadline = null; // 중복 실행 방지
      }
    }
  }
}, 1000);

// 오래된 방 정리
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - Math.max(room.createdAt, ...[...room.players.values()].map((p) => p.lastSeen || 0));
    if (idle > ROOM_TTL_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000);

// ── 소켓 핸들러 ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  /** @type {{roomCode:string, playerId:string}|null} */
  let session = null;

  const ctx = () => {
    if (!session) return {};
    const room = rooms.get(session.roomCode);
    const player = room?.players.get(session.playerId);
    return { room, player };
  };

  const requireHost = (cb) => {
    const { room, player } = ctx();
    if (!room || !player) { cb?.({ ok: false, error: '방에 접속되어 있지 않습니다.' }); return null; }
    if (room.hostId !== player.id) { cb?.({ ok: false, error: '방장만 할 수 있습니다.' }); return null; }
    return { room, player };
  };

  const attach = async (room, player) => {
    session = { roomCode: room.code, playerId: player.id };
    player.socketId = socket.id;
    player.connected = true;
    player.lastSeen = Date.now();
    socket.join(room.code);
  };

  socket.on('room:create', async ({ nickname }, cb) => {
    const name = String(nickname || '').trim().slice(0, 12);
    if (!name) return cb?.({ ok: false, error: '닉네임을 입력하세요.' });

    const code = newRoomCode();
    const room = new Room(code);
    const joinUrl = `${PUBLIC_URL}/?r=${code}`;
    try {
      room.qrDataUrl = await QRCode.toDataURL(joinUrl, {
        width: 512, margin: 1, color: { dark: '#000000', light: '#ffffff' },
      });
    } catch { room.qrDataUrl = null; }
    room.joinUrl = joinUrl;
    rooms.set(code, room);

    const player = room.addPlayer({ id: newPlayerId(), nickname: name });
    await attach(room, player);
    room.rebuildComposition();
    cb?.({ ok: true, roomCode: code, playerId: player.id, joinUrl });
    pushState(room);
  });

  socket.on('room:join', async ({ roomCode, nickname, playerId }, cb) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: '그런 방이 없습니다. 코드를 확인하세요.' });

    // 재접속
    if (playerId && room.players.has(playerId)) {
      const p = room.players.get(playerId);
      await attach(room, p);
      cb?.({ ok: true, roomCode: code, playerId: p.id, joinUrl: room.joinUrl });
      pushState(room);
      return;
    }

    if (room.phase !== PHASE.LOBBY) {
      return cb?.({ ok: false, error: '이미 게임이 시작된 방입니다.' });
    }
    const name = String(nickname || '').trim().slice(0, 12);
    if (!name) return cb?.({ ok: false, error: '닉네임을 입력하세요.' });
    if (room.players.size >= 20) return cb?.({ ok: false, error: '정원이 가득 찼습니다.' });
    if ([...room.players.values()].some((p) => p.nickname === name)) {
      return cb?.({ ok: false, error: '이미 있는 닉네임입니다.' });
    }

    const player = room.addPlayer({ id: newPlayerId(), nickname: name });
    await attach(room, player);
    room.rebuildComposition();
    cb?.({ ok: true, roomCode: code, playerId: player.id, joinUrl: room.joinUrl });
    pushState(room);
  });

  socket.on('host:config', ({ patch }, cb) => {
    const h = requireHost(cb); if (!h) return;
    const { room } = h;
    if (room.phase !== PHASE.LOBBY && room.phase !== PHASE.SEATING) {
      return cb?.({ ok: false, error: '게임 중에는 설정을 바꿀 수 없습니다.' });
    }
    const allowed = ['roles', 'discussSeconds', 'voteSeconds', 'nightSeconds', 'adjacencySkipsDead', 'tieMeansNoExecution', 'maxDays', 'maxDaysWinner', 'mafiaSharedKill', 'strictNeutralElimination', 'autoAdvance', 'showRoleList', 'openVoting'];
    // 직업 배정을 편성표 순서대로 고정하는 테스트 전용 스위치
    if (process.env.MAFIA_TEST_HOOKS === '1') allowed.push('deterministicRoles');
    for (const [k, v] of Object.entries(patch || {})) {
      if (allowed.includes(k)) room.config[k] = v;
    }
    cb?.({ ok: true, validation: room.validateConfig() });
    pushState(room);
  });

  // 직업 체험 — 자기 자신에게만 찜할 수 있다 (방장이 아니어도 된다)
  socket.on('role:pin', ({ roleId = null } = {}, cb) => {
    const { room, player } = ctx();
    if (!room || !player) return cb?.({ ok: false, error: '방에 접속되어 있지 않습니다.' });
    const r = room.pinRole(player.id, roleId);
    cb?.({ ...r, validation: room.validateConfig() });
    pushState(room);
  });

  socket.on('host:addBot', ({ count = 1 } = {}, cb) => {
    const h = requireHost(cb); if (!h) return;
    const n = Math.min(Math.max(1, Number(count) || 1), 20);
    let added = 0;
    let error = null;
    for (let i = 0; i < n; i++) {
      const r = h.room.addBot(newPlayerId);
      if (!r.ok) { error = r.error; break; }
      added++;
    }
    cb?.({ ok: added > 0, added, error: added ? null : error });
    pushState(h.room);
  });

  socket.on('host:removeBot', ({ botId = null } = {}, cb) => {
    const h = requireHost(cb); if (!h) return;
    const r = h.room.removeBot(botId);
    cb?.(r);
    pushState(h.room);
  });

  socket.on('host:autoRoles', (_p, cb) => {
    const h = requireHost(cb); if (!h) return;
    // 찜해둔 직업은 자동 편성 뒤에도 남아 있어야 한다
    h.room.rebuildComposition();
    cb?.({ ok: true, validation: h.room.validateConfig() });
    pushState(h.room);
  });

  socket.on('host:seating', (_p, cb) => {
    const h = requireHost(cb); if (!h) return;
    const r = h.room.startSeating();
    cb?.(r);
    pushState(h.room);
  });

  socket.on('seat:claim', ({ seat }, cb) => {
    const { room, player } = ctx();
    if (!room || !player) return cb?.({ ok: false, error: '방에 접속되어 있지 않습니다.' });
    const r = room.claimSeat(player.id, Number(seat));
    cb?.(r);
    pushState(room);
  });

  socket.on('host:start', (_p, cb) => {
    const h = requireHost(cb); if (!h) return;
    const r = h.room.startGame();
    cb?.(r);
    if (r.ok) emitAll(h.room, r); else pushState(h.room);
  });

  socket.on('host:next', (_p, cb) => {
    const h = requireHost(cb); if (!h) return;
    advance(h.room, true);
    cb?.({ ok: true });
  });

  socket.on('host:reset', (_p, cb) => {
    const h = requireHost(cb); if (!h) return;
    h.room.resetToLobby();
    cb?.({ ok: true });
    pushState(h.room);
  });

  socket.on('night:action', ({ targetId, secondId, mode }, cb) => {
    const { room, player } = ctx();
    if (!room || !player) return cb?.({ ok: false, error: '방에 접속되어 있지 않습니다.' });
    const r = room.submitNightAction(player.id, { targetId: targetId ?? null, secondId, mode });
    cb?.(r);
    pushState(room);
    if (r.ok && room.allNightActionsIn()) setTimeout(() => advance(room), 600);
  });

  socket.on('start:action', ({ targetId }, cb) => {
    const { room, player } = ctx();
    if (!room || !player) return cb?.({ ok: false, error: '방에 접속되어 있지 않습니다.' });
    const r = room.submitStartAction(player.id, targetId);
    cb?.(r);
    pushState(room);
  });

  socket.on('day:snipe', ({ targetId, roleKey }, cb) => {
    const { room, player } = ctx();
    if (!room || !player) return cb?.({ ok: false, error: '방에 접속되어 있지 않습니다.' });
    const r = room.snipe(player.id, targetId, roleKey);
    cb?.(r);
    if (r.ok) {
      emitAll(room, r);
      const win = room.checkWin();
      if (win) { emitAll(room, room.endGame(win)); return; }
      // 저격으로 사망자가 나오면 남은 투표만으로 마감될 수 있다
      if (room.phase === PHASE.VOTE && room.allVotesIn()) setTimeout(() => advance(room), 600);
    } else {
      pushState(room);
    }
  });

  socket.on('day:force', ({ targetId }, cb) => {
    const { room, player } = ctx();
    if (!room || !player) return cb?.({ ok: false, error: '방에 접속되어 있지 않습니다.' });
    const r = room.forceVote(player.id, targetId);
    cb?.(r);
    pushState(room);
  });

  socket.on('vote:cast', ({ targetId }, cb) => {
    const { room, player } = ctx();
    if (!room || !player) return cb?.({ ok: false, error: '방에 접속되어 있지 않습니다.' });
    const r = room.castVote(player.id, targetId);
    cb?.(r);
    pushState(room);
    if (r.ok && room.allVotesIn()) setTimeout(() => advance(room), 600);
  });

  socket.on('room:leave', (_p, cb) => {
    const { room, player } = ctx();
    if (room && player) {
      socket.leave(room.code);
      room.removePlayer(player.id);
      // 봇만 남은 방은 유지할 이유가 없다
      if (room.humans.length === 0) rooms.delete(room.code);
      else pushState(room);
    }
    session = null;
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const { room, player } = ctx();
    if (!room || !player) return;
    if (player.socketId === socket.id) {
      player.socketId = null;
      player.connected = false;
    }
    if (room.phase === PHASE.LOBBY) {
      room.removePlayer(player.id);
      room.rebuildComposition();
    }
    // 사람이 아무도 남지 않았으면 방을 정리한다 (봇만 남은 방은 진행될 수 없다)
    if (room.humans.every((p) => !p.connected)) { rooms.delete(room.code); return; }
    pushState(room);
  });
});

server.listen(PORT, () => {
  console.log(`\n  마피아 서버 실행 중`);
  console.log(`  로컬:  http://localhost:${PORT}`);
  console.log(`  공개:  ${PUBLIC_URL}`);
  console.log(`  (QR 은 PUBLIC_URL 을 가리킵니다. 배포 시 환경변수로 지정하세요)\n`);
});
