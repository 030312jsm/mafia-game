/**
 * UI 확인용 드라이버.
 * 봇이 방장이 되어 방을 만들고, 사람(브라우저)이 마지막 자리에 앉도록 유도한다.
 * 편성표를 고정하므로 브라우저 플레이어가 어떤 직업을 받을지 미리 정할 수 있다.
 *
 *   node test/ui-driver.mjs '["citizen","citizen","citizen","citizen","citizen","chairman"]'
 *
 * 서버는 MAFIA_TEST_HOOKS=1 로 떠 있어야 한다.
 * 마지막 원소가 브라우저 플레이어의 직업이 된다.
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3100';
const roles = JSON.parse(process.argv[2] || '["citizen","citizen","citizen","citizen","citizen","chairman"]');
const total = roles.length;
const botCount = total - 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    const c = {
      name, socket: s, state: null, id: null,
      emit: (ev, d) => new Promise((res) => s.emit(ev, d, (r) => res(r || { ok: false }))),
    };
    s.on('state', (st) => { c.state = st; });
    s.on('connect', () => resolve(c));
  });
}

const host = await connect('봇방장');
const created = await host.emit('room:create', { nickname: '봇방장' });
if (!created.ok) { console.error(created.error); process.exit(1); }
host.id = created.playerId;

const bots = [host];
for (let i = 1; i < botCount; i++) {
  const c = await connect(`봇${i}`);
  const r = await c.emit('room:join', { roomCode: created.roomCode, nickname: `봇${i}` });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  c.id = r.playerId;
  bots.push(c);
}

console.log(`\n방 코드: ${created.roomCode}`);
console.log(`입장 주소: ${URL}/?r=${created.roomCode}`);
console.log(`브라우저로 들어와서 ${total}번 자리에 앉으세요. 받을 직업: ${roles[total - 1]}\n`);

// 사람이 들어올 때까지 대기
while ((host.state?.room.playerCount ?? 0) < total) await sleep(400);
console.log('사람 입장 확인. 편성표 고정 후 자리 배치로 넘어갑니다.');

const cfg = await host.emit('host:config', {
  patch: { roles, deterministicRoles: true, nightSeconds: 900, discussSeconds: 900, voteSeconds: 900 },
});
if (!cfg.validation?.ok) { console.error('편성 오류:', cfg.validation?.errors); process.exit(1); }

await host.emit('host:seating', {});
await sleep(300);
for (let i = 0; i < bots.length; i++) {
  const r = await bots[i].emit('seat:claim', { seat: i + 1 });
  if (!r.ok) console.error(`자리 ${i + 1}: ${r.error}`);
}
console.log(`봇이 1~${botCount}번 자리를 잡았습니다. 브라우저에서 ${total}번 자리를 선택하세요.`);

// 사람이 앉으면 게임 시작
while (host.state.players.some((p) => p.seat == null)) await sleep(400);
const st = await host.emit('host:start', {});
console.log(st.ok ? '게임 시작.' : `시작 실패: ${st.error}`);

// 봇 자동 행동 — 사람이 조작할 시간을 벌어주기 위해 밤/투표만 자동으로 채운다
for (const b of bots) {
  b.socket.on('state', async (s) => {
    if (s.room.phase === 'ROLE_REVEAL' && s.you.startAction) {
      const t = s.you.startTargets[0];
      if (t) b.emit('start:action', { targetId: t });
    }
    if (s.room.phase === 'NIGHT' && s.you.canAct && !s.you.submittedAction) {
      if (s.you.actionNoTarget) b.emit('night:action', { targetId: 'FIRE' });
      else if (s.you.actionPair) {
        const [a, c] = s.you.actionTargets;
        if (a && c) b.emit('night:action', { targetId: a, secondId: c });
      } else b.emit('night:action', { targetId: s.you.actionTargets[0] ?? null });
    }
    if (s.room.phase === 'VOTE' && s.you.alive && !s.you.votedFor) {
      const other = s.players.find((p) => p.alive && !p.isYou);
      b.emit('vote:cast', { targetId: other ? other.id : 'ABSTAIN' });
    }
  });
}

// 방장(봇)이 사람이 화면을 볼 시간을 준 뒤 다음 페이즈로 넘긴다
const HOLD_MS = Number(process.env.HOLD_MS || 12000);
let lastPhase = null;
let holdTimer = null;
host.socket.on('state', (s) => {
  if (s.room.phase === lastPhase) return;
  lastPhase = s.room.phase;
  clearTimeout(holdTimer);
  if (['ROLE_REVEAL', 'DAWN', 'DISCUSS', 'EXECUTION'].includes(s.room.phase)) {
    holdTimer = setTimeout(() => host.emit('host:next', {}), HOLD_MS);
  }
});

console.log(`봇 자동 행동 활성화 (페이즈당 ${HOLD_MS / 1000}초 대기). Ctrl+C 로 종료.\n`);
process.on('SIGINT', () => { for (const b of bots) b.socket.close(); process.exit(0); });
