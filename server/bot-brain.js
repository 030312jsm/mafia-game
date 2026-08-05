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
    // 1일차부터 난사하면 게임이 성립하지 않는다. 정보가 쌓인 뒤에 가끔 쏜다.
    if (view.room.day < 2 || !chance(0.35)) return null;
    const pool = others(view);
    if (!pool.length) return null;
    const revealed = pool.filter((p) => p.revealedRole && teamOfRoleName(p.revealedRole) !== TEAM.MAFIA);
    const target = revealed.length ? pick(revealed) : pick(pool);
    const known = (you.snipeChoices || []).find((c) => c.name === target.revealedRole);
    const guess = known ?? pick(you.snipeChoices || []);
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

/** 투표 */
export function decideVote(view) {
  const you = view.you;
  const allies = new Set(you.allies || []);
  const pool = others(view);
  if (!pool.length) return { targetId: 'ABSTAIN' };

  let candidates;
  if (you.role?.team === TEAM.MAFIA) {
    candidates = pool.filter((p) => !allies.has(p.id));
  } else {
    const enemies = knownEnemies(view);
    candidates = enemies.length ? enemies : pool;
  }
  if (!candidates.length) candidates = pool;

  // 가끔은 기권해서 동표 상황도 만들어 본다
  if (chance(0.1)) return { targetId: 'ABSTAIN' };
  return { targetId: pick(candidates).id };
}
