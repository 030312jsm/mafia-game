/**
 * 봇의 판단 로직.
 *
 * 입력은 오직 `Room.viewFor(playerId)` 가 내려주는 개인화 상태다.
 * 사람 플레이어가 화면에서 볼 수 있는 것과 완전히 같은 정보만 쓴다.
 * (서버 안에서 돌지만 방 내부 상태를 훔쳐보지 않는다)
 *
 * 서버(방에 넣는 봇)와 test/bot.mjs(터미널에서 붙는 봇)가 이 파일을 함께 쓴다.
 */
import { ROLES, TEAM } from './roles.js';

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p) => Math.random() < p;

/** 공개된 직업명 → 진영 (모르는 이름이면 null) */
const teamOfRoleName = (name) => Object.values(ROLES).find((r) => r.name === name)?.team ?? null;

const alive = (view) => view.players.filter((p) => p.alive);
const others = (view) => alive(view).filter((p) => !p.isYou);

/** 이 봇이 마피아라고 확신하는 사람들 (기자 특종 등으로 드러난 경우) */
function knownEnemies(view) {
  const allies = new Set(view.you.allies || []);
  if (view.you.role?.team === TEAM.MAFIA) return [];
  return others(view).filter(
    (p) => !allies.has(p.id) && teamOfRoleName(p.revealedRole) === TEAM.MAFIA
  );
}

/** 자리 정하기 — 비어 있는 가장 낮은 번호를 잡는다 */
export function decideSeat(view) {
  if (view.you.seat != null) return null;
  const taken = new Set(Object.keys(view.seats.taken).map(Number));
  for (let s = 1; s <= view.seats.total; s++) if (!taken.has(s)) return s;
  return null;
}

/** 게임 시작 시 1회 능력 (진돗개의 각인) */
export function decideStart(view) {
  const targets = view.you.startTargets || [];
  if (!targets.length) return null;
  return { targetId: pick(targets) };
}

/**
 * 밤 행동.
 * targetId 가 null 이면 능력을 쓰지 않고 넘긴다.
 */
export function decideNight(view) {
  const you = view.you;
  const targets = you.actionTargets || [];

  // 삐에로: 지목 없이 발동만
  if (you.actionNoTarget) return { targetId: chance(0.7) ? 'FIRE' : null };

  if (!targets.length) return { targetId: null };

  // 삼둥이 셋째: 두 명을 찍는다
  if (you.actionPair) {
    if (targets.length < 2) return { targetId: null };
    const a = pick(targets);
    const b = pick(targets.filter((x) => x !== a));
    return { targetId: a, secondId: b };
  }

  const allies = new Set(you.allies || []);
  const roleId = you.role.id;
  let candidates = targets;
  let mode;

  switch (roleId) {
    // 마피아 계열 — 아군은 죽이지 않는다
    case 'mafia': case 'rigger': case 'independent_mafia':
    case 'triplet_mafia': case 'sniper':
      candidates = targets.filter((id) => !allies.has(id));
      break;

    case 'chairman': {
      candidates = targets.filter((id) => !allies.has(id));
      mode = !you.convertUsed && candidates.length && chance(0.4) ? 'CONVERT' : 'KILL';
      break;
    }

    case 'guardian':
      // 절반 가까이는 자기 자신을 보호
      candidates = chance(0.4) ? [you.id] : targets.filter((id) => id !== you.id);
      if (!candidates.length) candidates = targets;
      break;

    case 'police': case 'detective': case 'gymrat': case 'soldier': case 'reporter': {
      const enemies = knownEnemies(view).map((p) => p.id).filter((id) => targets.includes(id));
      candidates = enemies.length ? enemies : targets.filter((id) => id !== you.id);
      break;
    }

    case 'serial_killer':
      candidates = targets.filter((id) => id !== you.id);
      break;

    default:
      candidates = targets;
  }

  if (!candidates.length) return { targetId: null };

  // 군인·연쇄살인마가 매일 밤 쏘면 게임이 너무 빨리 끝난다
  const restraint = { soldier: 0.5, serial_killer: 0.8 }[roleId];
  if (restraint != null && !chance(restraint)) return { targetId: null };

  return { targetId: pick(candidates), mode };
}

/** 투표 시간의 능력 (저격수 / 정치인). 쓰지 않기로 하면 null */
export function decideDay(view) {
  const you = view.you;
  if (!you.dayAbility) return null;

  if (you.dayAbility.kind === 'SNIPE') {
    // 직업을 모르는 채로 찍어서 쏘면 거의 빗나가고, 빗나가면 저격수 본인이 죽는다.
    // 즉 근거 없는 저격은 그냥 자살이다. 확실히 아는 대상에게만 쏜다.
    const pool = others(view).filter(
      (p) => p.revealedRole && teamOfRoleName(p.revealedRole) !== TEAM.MAFIA
    );
    if (!pool.length) return null;
    const target = pick(pool);
    const guess = (you.snipeChoices || []).find((c) => c.name === target.revealedRole);
    if (!guess) return null;
    return { kind: 'SNIPE', targetId: target.id, roleKey: guess.key };
  }

  if (you.dayAbility.kind === 'FORCE_VOTE') {
    if (view.room.day < 2 || !chance(0.3)) return null;
    const enemies = knownEnemies(view);
    const pool = enemies.length ? enemies : others(view);
    if (!pool.length) return null;
    return { kind: 'FORCE_VOTE', targetId: pick(pool).id };
  }
  return null;
}

/**
 * 그날의 「합의 점수」.
 * 일차와 대상 id 만으로 정해지므로 모든 봇이 같은 값을 계산한다.
 * 이걸로 정렬해 1위를 찍으면, 말을 하지 않고도 같은 사람에게 표가 모인다.
 *
 * 각자 무작위로 찍게 두면 표가 흩어져 동표가 나고 처형이 거의 일어나지 않는다.
 * 그러면 마피아가 밤마다 한 명씩 줄여 이기는 결과만 나와서 밸런스 측정이 무의미해진다.
 * 실제 사람은 토론으로 한 명에 의견을 모으므로, 그쪽에 가깝게 맞춘 것이다.
 */
function consensusScore(day, id) {
  let h = (2166136261 ^ day) >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 투표 */
export function decideVote(view) {
  const you = view.you;
  const day = view.room.day;
  const allies = new Set(you.allies || []);
  const pool = others(view);
  if (!pool.length) return { targetId: 'ABSTAIN' };

  let candidates;
  if (you.role?.team === TEAM.MAFIA) {
    // 마피아는 동료를 빼고, 나머지 중에서 시민들과 같은 기준으로 고른다
    candidates = pool.filter((p) => !allies.has(p.id));
  } else {
    // 정체가 드러난 마피아가 있으면 무조건 그쪽
    const enemies = knownEnemies(view);
    candidates = enemies.length ? enemies : pool;
  }
  if (!candidates.length) candidates = pool;

  const target = candidates
    .slice()
    .sort((a, b) => consensusScore(day, b.id) - consensusScore(day, a.id))[0];
  return { targetId: target.id };
}
