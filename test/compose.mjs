/**
 * 무작위 직업 편성 생성기. 직업 간 상호작용을 넓게 훑기 위한 용도.
 * 평마피아·평시민이 빠졌으므로 모든 직업이 서로 다르다.
 */
import { ROLES, recommendCounts } from '../server/roles.js';

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p) => Math.random() < p;
const shuffle = (a) => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
};

const MAFIA_SPECIALS = ['sniper', 'chairman', 'independent_mafia'];
const CITIZEN_SPECIALS = [
  'police', 'guardian', 'detective', 'gymrat', 'soldier',
  'politician', 'reporter', 'independent_citizen', 'lunatic',
];
const NEUTRAL_SPECIALS = ['jindo', 'attention', 'serial_killer', 'clown'];

/**
 * n명짜리 편성표를 하나 만든다.
 * 서버의 validateConfig 를 그대로 통과한다는 보장은 없으므로,
 * 호출하는 쪽에서 검증 실패 시 다시 뽑는 것을 전제로 한다.
 */
export function randomComposition(n) {
  const rec = recommendCounts(n);
  const useTriplets = n >= 8 && chance(0.3);

  const roles = [];
  const takeUnique = (pool, count) => shuffle(pool).slice(0, Math.max(0, count));

  let mafiaSlots = rec.mafia;
  let neutralSlots = rec.neutral;
  let citizenSlots = n - mafiaSlots - neutralSlots;

  if (useTriplets && mafiaSlots >= 1 && neutralSlots >= 1 && citizenSlots >= 1) {
    roles.push('triplet_mafia', 'triplet_neutral', 'triplet_citizen');
    mafiaSlots--; neutralSlots--; citizenSlots--;
  }

  roles.push(...takeUnique(MAFIA_SPECIALS, mafiaSlots));
  roles.push(...takeUnique(NEUTRAL_SPECIALS, neutralSlots));
  roles.push(...takeUnique(CITIZEN_SPECIALS, citizenSlots));

  // 고유 직업이 모자라 자리가 비면 남은 직업으로 채운다
  const rest = shuffle([...CITIZEN_SPECIALS, ...NEUTRAL_SPECIALS, ...MAFIA_SPECIALS])
    .filter((id) => !roles.includes(id));
  while (roles.length < n && rest.length) roles.push(rest.shift());

  return shuffle(roles.slice(0, n));
}

/** 인원수에 맞는 무난한 기본 편성 (서버의 자동 편성과 같은 성격) */
export function defaultComposition(n) {
  const rec = recommendCounts(n);
  const roles = [];
  roles.push(...MAFIA_SPECIALS.slice(0, rec.mafia));
  roles.push(...NEUTRAL_SPECIALS.slice(0, rec.neutral));
  roles.push(...CITIZEN_SPECIALS.slice(0, Math.max(0, n - roles.length)));
  const rest = [...CITIZEN_SPECIALS, ...NEUTRAL_SPECIALS, ...MAFIA_SPECIALS]
    .filter((id) => !roles.includes(id));
  while (roles.length < n && rest.length) roles.push(rest.shift());
  return roles.slice(0, n);
}

export { pick, shuffle };
