/**
 * 터미널에서 방에 붙는 봇 플레이어 (소켓 클라이언트).
 *
 * 판단 로직은 서버와 동일한 `server/bot-brain.js` 를 그대로 쓴다.
 * 방 안에 넣는 봇과 두뇌가 갈라지지 않도록 하기 위해서다.
 * 입력은 서버가 내려주는 개인화 상태뿐이라 사람과 정보량이 같다.
 */
import { io } from 'socket.io-client';
import {
  decideSeat, decideStart, decideNight, decideDay, decideVote,
} from '../server/bot-brain.js';

export const BOT_NAMES = [
  '가람', '나래', '다온', '라온', '마루', '바다', '사랑', '아름', '자유', '차미',
  '카라', '타미', '파랑', '하늘', '미르', '슬기', '다솜', '예솔', '한별', '도담',
];

export function createBot({
  url,
  nickname,
  roomCode = null,     // null 이면 방을 새로 만든다 (= 이 봇이 방장)
  holdMs = 0,          // 방장 봇이 각 페이즈를 붙잡고 있는 시간
  autoAdvance = false, // 방장 봇이 페이즈를 자동으로 넘길지
  claimSeat = true,    // 자리 정하기 단계에서 스스로 자리를 잡을지
  log = () => {},
}) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'] });
    const bot = {
      nickname, socket,
      id: null,
      roomCode,
      isHost: false,
      state: null,
      done: null,        // 게임 종료 결과
      emit: (ev, d) => new Promise((res) => socket.emit(ev, d, (r) => res(r || { ok: false }))),
      close: () => { clearInterval(watchdog); clearTimeout(holdTimer); socket.close(); },
    };

    // 같은 페이즈에서 두 번 행동하지 않도록 하는 표식.
    // 서버가 거부하면 표식을 지워서 다음 기회에 다시 시도한다.
    // (거부당하고 그대로 손을 놓으면 그 방은 영원히 다음 단계로 못 넘어간다)
    const acted = new Set();
    const once = async (key, fn) => {
      if (acted.has(key)) return;
      acted.add(key);
      try {
        const res = await fn();
        if (res && res.ok === false) acted.delete(key);
      } catch { acted.delete(key); }
    };

    let holdTimer = null;
    let lastPhase = null;

    const nameOf = (id) => {
      const p = bot.state?.players.find((x) => x.id === id);
      return p ? `${p.seat ?? '?'}번 ${p.nickname}` : '?';
    };

    // ── 행동 판단 ─────────────────────────────────────────────
    // 상태 갱신 때마다, 그리고 주기적으로도 호출한다.
    // 상태 푸시가 더 오지 않는 상황에서도 손을 놓지 않기 위해서다.
    function maybeAct() {
      const st = bot.state;
      if (!st?.you) return;
      const day = st.room.day;

      switch (st.room.phase) {
        case 'SEATING': {
          if (!claimSeat || st.you.seat != null) break;
          const seat = decideSeat(st);
          if (seat != null) once(`seat:${seat}`, () => bot.emit('seat:claim', { seat }));
          break;
        }
        case 'ROLE_REVEAL': {
          if (!st.you.startAction) break;
          once(`start:${day}`, () => {
            const d = decideStart(st);
            if (!d) return null;
            log({ kind: 'start', bot, text: `${nameOf(d.targetId)} 을(를) 주인으로 각인` });
            return bot.emit('start:action', d);
          });
          break;
        }
        case 'NIGHT': {
          if (!st.you.canAct || st.you.submittedAction) break;
          once(`night:${day}`, () => {
            const d = decideNight(st);
            if (!d) return null;
            log({
              kind: 'night', bot,
              text: d.targetId === null ? '능력 사용 안 함'
                : d.targetId === 'FIRE' ? '가짜 총성 발사'
                : d.secondId ? `형제 추측: ${nameOf(d.targetId)}, ${nameOf(d.secondId)}`
                : `${d.mode === 'CONVERT' ? '포섭' : '지목'} → ${nameOf(d.targetId)}`,
            });
            return bot.emit('night:action', d);
          });
          break;
        }
        case 'VOTE': {
          if (!st.you.alive) break;
          once(`dayability:${day}`, () => {
            const d = decideDay(st);
            if (!d) return null;
            if (d.kind === 'SNIPE') {
              log({ kind: 'day', bot, text: `저격 → ${nameOf(d.targetId)} 을(를) 「${d.roleKey}」로` });
              return bot.emit('day:snipe', { targetId: d.targetId, roleKey: d.roleKey });
            }
            log({ kind: 'day', bot, text: `투표 강제 지정 → ${nameOf(d.targetId)}` });
            return bot.emit('day:force', { targetId: d.targetId });
          });
          if (!st.you.votedFor) {
            once(`vote:${day}`, () => {
              const d = decideVote(st);
              if (!d) return null;
              log({
                kind: 'vote', bot,
                text: d.targetId === 'ABSTAIN' ? '기권' : `투표 → ${nameOf(d.targetId)}`,
              });
              return bot.emit('vote:cast', d);
            });
          }
          break;
        }
        default:
          break;
      }
    }
    const watchdog = setInterval(maybeAct, 1500);

    // ── 상태 수신 ─────────────────────────────────────────────
    socket.on('state', (st) => {
      bot.state = st;
      bot.isHost = !!st.you?.isHost;
      const phase = st.room.phase;

      if (phase !== lastPhase) {
        lastPhase = phase;
        clearTimeout(holdTimer);
        // 방장 봇이 사람이 화면을 볼 시간을 준 뒤 다음 단계로 넘긴다
        if (autoAdvance && bot.isHost &&
            ['ROLE_REVEAL', 'DAWN', 'DISCUSS', 'EXECUTION'].includes(phase)) {
          holdTimer = setTimeout(() => bot.emit('host:next', {}), holdMs);
        }
      }

      if (phase === 'END' && !bot.done) {
        bot.done = st.result;
        clearTimeout(holdTimer);
        clearInterval(watchdog);
      }

      maybeAct();
    });

    socket.on('connect_error', (e) => reject(new Error(`연결 실패: ${e.message}`)));

    socket.on('connect', async () => {
      const res = roomCode
        ? await bot.emit('room:join', { roomCode, nickname })
        : await bot.emit('room:create', { nickname });
      if (!res.ok) return reject(new Error(`${nickname}: ${res.error}`));
      bot.id = res.playerId;
      bot.roomCode = res.roomCode;
      bot.joinUrl = res.joinUrl;
      resolve(bot);
    });
  });
}
