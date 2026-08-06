/**
 * 봇 판단 로직 단위 테스트.
 *
 * 서버를 띄우지 않고 bot-brain 에 직접 상태를 넣어 결정을 확인한다.
 * 승률로는 판단 변화가 노이즈에 묻혀서 보이지 않기 때문에,
 * 「이 상황에서 이렇게 고르는가」를 여기서 못 박아 둔다.
 *
 *   node test/brain.mjs
 */
import { decideVote, decideNight } from '../server/bot-brain.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
};
const head = (t) => console.log(`\n▸ ${t}`);

/** 최소한의 개인화 상태를 만든다 */
function view({ me = 'p1', role, players, info = [], allies = [], day = 2 }) {
  return {
    room: { day },
    you: { id: me, role, info, allies, alive: true },
    players: players.map((p) => ({
      revealedRole: null, alive: true, survivedVote: false, ...p,
      isYou: p.id === me,
    })),
  };
}

const CITIZEN = { id: 'police', name: '경찰', team: 'CITIZEN' };
const MAFIA = { id: 'mafia', name: '마피아', team: 'MAFIA' };

/** 같은 상황을 여러 번 돌려 매번 같은 선택이 나오는지 (무작위성 배제) */
const repeat = (fn, n = 40) => new Set(Array.from({ length: n }, fn));

console.log('\n봇 판단 로직 테스트');

// ── 요청 사항: 투표로 못 죽이는 사람에게 표를 낭비하지 않는다 ──
{
  head('무소속당(마피아)이 드러나면 표를 주지 않는다');
  const v = view({
    role: CITIZEN,
    players: [
      { id: 'p1' },
      { id: 'p2', revealedRole: '무소속당 (마피아)' },
      { id: 'p3' },
      { id: 'p4' },
    ],
  });
  const picks = repeat(() => decideVote(v).targetId);
  check('정체가 드러난 무소속당은 절대 안 고름', !picks.has('p2'), [...picks].join(','));
  check('다른 사람 중에서 고름', picks.size === 1 && !picks.has('p2'), [...picks].join(','));
}

{
  head('처형을 견뎌낸 사람에게도 표를 주지 않는다');
  const v = view({
    role: CITIZEN,
    players: [{ id: 'p1' }, { id: 'p2', survivedVote: true }, { id: 'p3' }, { id: 'p4' }],
  });
  const picks = repeat(() => decideVote(v).targetId);
  check('견뎌낸 사람은 제외', !picks.has('p2'), [...picks].join(','));
}

{
  head('그래도 드러난 일반 마피아는 최우선으로 찍는다');
  const v = view({
    role: CITIZEN,
    players: [
      { id: 'p1' },
      { id: 'p2', revealedRole: '무소속당 (마피아)' },
      { id: 'p3', revealedRole: '마피아' },
      { id: 'p4' },
    ],
  });
  const picks = repeat(() => decideVote(v).targetId);
  check('죽일 수 있는 마피아를 고름', picks.size === 1 && picks.has('p3'), [...picks].join(','));
}

// ── 근거 활용 ────────────────────────────────────────────────
{
  head('경찰이 무고를 확인한 사람은 피한다');
  const v = view({
    role: CITIZEN,
    players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
    info: [{ kind: 'police.clear', about: 'p2' }, { kind: 'police.clear', about: 'p3' }],
  });
  const picks = repeat(() => decideVote(v).targetId);
  check('확인된 두 사람은 안 고름', !picks.has('p2') && !picks.has('p3'), [...picks].join(','));
  check('남은 사람을 고름', picks.size === 1 && picks.has('p4'), [...picks].join(','));
}

{
  head('탐정 결과에 마피아 직업이 섞이면 의심한다');
  const v = view({
    role: CITIZEN,
    players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
    info: [
      { kind: 'detective', about: 'p2', options: ['마피아', '경찰'] },
      { kind: 'detective', about: 'p3', options: ['수호자', '탐정'] },
    ],
  });
  const picks = repeat(() => decideVote(v).targetId);
  check('마피아가 후보로 뜬 쪽을 고름', picks.size === 1 && picks.has('p2'), [...picks].join(','));
}

{
  head('마피아는 동료를 찍지 않는다');
  const v = view({
    role: MAFIA,
    allies: ['p2'],
    players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
  });
  const picks = repeat(() => decideVote(v).targetId);
  check('동료 제외', !picks.has('p2'), [...picks].join(','));
}

{
  head('전부 못 죽이는 상대만 남으면 기권한다');
  const v = view({
    role: CITIZEN,
    players: [
      { id: 'p1' },
      { id: 'p2', revealedRole: '무소속당 (마피아)' },
      { id: 'p3', survivedVote: true },
    ],
  });
  const picks = repeat(() => decideVote(v).targetId);
  check('표를 버리지 않고 기권', picks.size === 1 && picks.has('ABSTAIN'), [...picks].join(','));
}

// ── 밤 행동 ──────────────────────────────────────────────────
{
  head('이미 조사한 사람은 다시 조사하지 않는다');
  const v = view({
    role: { id: 'detective', name: '탐정', team: 'CITIZEN' },
    players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
    info: [{ kind: 'detective', about: 'p2', options: ['경찰', '시민'] }],
  });
  v.you.actionTargets = ['p2', 'p3', 'p4'];
  v.you.role = { id: 'detective', name: '탐정', team: 'CITIZEN' };
  const picks = repeat(() => decideNight(v).targetId);
  check('조사한 적 있는 사람 제외', !picks.has('p2'), [...picks].join(','));
}

{
  head('마피아는 동료를 죽이지 않는다');
  const v = view({
    role: MAFIA,
    allies: ['p2'],
    players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
  });
  v.you.actionTargets = ['p2', 'p3'];
  const picks = repeat(() => decideNight(v).targetId);
  check('동료 제외', !picks.has('p2'), [...picks].join(','));
}

console.log(`\n${failures === 0 ? '전체 통과' : `${failures}개 실패`}\n`);
process.exit(failures === 0 ? 0 : 1);
