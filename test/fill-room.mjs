/**
 * 브라우저에서 만든 방에 더미 플레이어를 붙여 UI를 확인할 때 쓰는 보조 스크립트.
 * 사용: node test/fill-room.mjs <방코드> [인원수]
 * 붙은 소켓은 프로세스를 종료할 때까지 유지된다.
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const code = (process.argv[2] || '').toUpperCase();
const count = Number(process.argv[3] || 4);
if (!code) { console.error('방 코드를 넣어주세요: node test/fill-room.mjs ABCD'); process.exit(1); }

const NAMES = ['봇하나', '봇둘', '봇셋', '봇넷', '봇다섯', '봇여섯', '봇일곱'];
const bots = [];

for (let i = 0; i < count; i++) {
  const s = io(URL, { transports: ['websocket'] });
  await new Promise((r) => s.on('connect', r));
  const res = await new Promise((r) => s.emit('room:join', { roomCode: code, nickname: NAMES[i] }, r));
  if (!res.ok) { console.error(`${NAMES[i]} 입장 실패: ${res.error}`); process.exit(1); }
  const bot = { name: NAMES[i], socket: s, id: res.playerId, state: null };
  s.on('state', (st) => {
    bot.state = st;
    // 자리 정하기 단계면 비어 있는 자리를 자동으로 잡는다
    if (st.room.phase === 'SEATING' && st.you.seat == null) {
      const taken = new Set(Object.keys(st.seats.taken).map(Number));
      for (let seat = 1; seat <= st.seats.total; seat++) {
        if (!taken.has(seat)) { s.emit('seat:claim', { seat }, () => {}); break; }
      }
    }
    // 밤이면 아무나 지목, 투표면 아무나 투표 (UI 확인용)
    if (st.room.phase === 'NIGHT' && st.you.canAct) {
      const t = st.you.actionTargets[0] ?? null;
      s.emit('night:action', { targetId: t }, () => {});
    }
    if (st.room.phase === 'VOTE' && st.you.alive && !st.you.votedFor) {
      const other = st.players.find((p) => p.alive && !p.isYou);
      s.emit('vote:cast', { targetId: other ? other.id : 'ABSTAIN' }, () => {});
    }
  });
  bots.push(bot);
  console.log(`${NAMES[i]} 입장`);
}

console.log(`\n${code} 방에 ${count}명 대기 중. Ctrl+C 로 종료.`);
process.on('SIGINT', () => { for (const b of bots) b.socket.close(); process.exit(0); });
