// 직업 레지스트리.
//
// 직업을 추가/수정할 때는 이 파일의 메타데이터를 먼저 고치고,
// 표준 패턴(지목·보호·살해·정보)으로 표현되지 않는 부분만 game.js 에 분기를 붙인다.

export const TEAM = {
  MAFIA: 'MAFIA',
  CITIZEN: 'CITIZEN',
  NEUTRAL: 'NEUTRAL',
};

export const TEAM_LABEL = {
  MAFIA: '마피아',
  CITIZEN: '시민',
  NEUTRAL: '중립',
};

// 밤 행동 해결 순서. 숫자가 작을수록 먼저 처리된다.
export const NIGHT_ORDER = {
  BLOCK: 10,     // 능력 차단 (헬창)
  PROTECT: 20,   // 보호 (수호자)
  CONVERT: 35,   // 포섭 (회장)
  KILL: 40,      // 살해 시도 (마피아 계열, 군인, 연쇄살인마, 삐에로의 가짜 총성)
  WITNESS: 50,   // 목격 판정 (경찰) — 살해가 확정된 뒤에 봐야 한다
  INFO: 60,      // 정보 획득 (탐정, 기자, 삼둥이 셋째)
};

// 밤에 지목할 수 있는 대상 범위
export const TARGET = {
  NONE: 'NONE',                 // 지목 없이 발동만 (삐에로)
  ANY_ALIVE: 'ANY_ALIVE',       // 살아있는 아무나 (자신 포함)
  OTHER_ALIVE: 'OTHER_ALIVE',   // 자신을 제외한 살아있는 사람
  ADJACENT: 'ADJACENT',         // 원형 자리 기준 양옆 (마피아 진영 공통)
};

// 낮(투표 중) 능력 종류
export const DAY_ABILITY = {
  SNIPE: 'SNIPE',             // 저격수: 대상 + 직업을 맞히기
  FORCE_VOTE: 'FORCE_VOTE',   // 정치인: 투표 결과를 강제 지정
};

const R = (def) => ({
  implemented: false,
  selectable: true,      // 로비 편성에서 고를 수 있는지
  unique: false,
  minPlayers: 0,
  maxCount: 99,
  voteImmune: false,     // 투표로 죽지 않음
  // (중립 전용) 살아 있으면 시민·마피아의 진영 승리를 막는지.
  // 남을 죽일 수단이 있는 중립만 true 다. 죽일 수단이 없는 중립까지 막게 하면
  // 시민이 일방적으로 불리해진다 (마피아는 밤에 중립을 지울 수 있지만 시민은 투표뿐).
  // 로비의 strictNeutralElimination 을 켜면 중립 전원이 막도록 되돌릴 수 있다.
  blocksTeamWin: false,
  night: null,
  day: null,
  start: null,           // 게임 시작 시 1회 행동
  ...def,
});

// 마피아 진영 공통 능력: 밤에 양옆 사람만 죽일 수 있다.
const MAFIA_KILL = {
  order: NIGHT_ORDER.KILL,
  targets: TARGET.ADJACENT,
  optional: true,
  prompt: '죽일 사람을 지목하세요 (양옆만 가능)',
  narrationKey: 'night.mafia',
};

export const ROLES = {
  // ═══════════════════════════ 시민 ═══════════════════════════
  // 능력 없는 평시민은 편성에서 제외됐다. 정의만 남겨둔 이유는
  // 회장의 포섭처럼 게임 중 직업이 바뀌는 경우와 테스트에서 필요하기 때문이다.
  citizen: R({
    id: 'citizen',
    name: '시민',
    team: TEAM.CITIZEN,
    implemented: true,
    selectable: false,
    desc: '아무 능력이 없다. 낮 투표로 마피아를 찾아내는 것이 전부다.',
  }),

  police: R({
    id: 'police',
    name: '경찰',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    desc: '밤에 한 명을 지목한다. 그 사람이 그날 밤 누군가를 죽이려 했다면 목격하고 즉시 사살한다.',
    night: {
      order: NIGHT_ORDER.WITNESS,
      targets: TARGET.OTHER_ALIVE,
      optional: true,
      prompt: '감시할 사람을 지목하세요',
      narrationKey: 'night.police',
    },
  }),

  guardian: R({
    id: 'guardian',
    name: '수호자',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    desc: '밤에 한 명을 지목해 그날 밤의 살해를 막아낸다. 자기 자신에게도 사용할 수 있다.',
    night: {
      order: NIGHT_ORDER.PROTECT,
      targets: TARGET.ANY_ALIVE,
      optional: true,
      prompt: '보호할 사람을 지목하세요',
      narrationKey: 'night.guardian',
    },
  }),

  detective: R({
    id: 'detective',
    name: '탐정',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    desc: '밤에 한 명을 지목하면 그 사람의 진짜 직업 하나와, 그 사람이 아닌 직업 하나를 함께 알려준다. 둘 중 어느 쪽이 진짜인지는 알려주지 않는다.',
    night: {
      order: NIGHT_ORDER.INFO,
      targets: TARGET.OTHER_ALIVE,
      optional: true,
      prompt: '조사할 사람을 지목하세요',
      narrationKey: 'night.detective',
    },
  }),

  gymrat: R({
    id: 'gymrat',
    name: '헬창',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    desc: '밤에 한 명을 지목해 그 사람의 능력을 하루 동안 차단한다.',
    night: {
      order: NIGHT_ORDER.BLOCK,
      targets: TARGET.OTHER_ALIVE,
      optional: true,
      prompt: '능력을 막을 사람을 지목하세요',
      narrationKey: 'night.gymrat',
    },
  }),

  soldier: R({
    id: 'soldier',
    name: '군인',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    desc: '밤에 원거리에서 아무나 죽일 수 있다. 단, 쏠 때마다 모두에게 총소리가 들린다.',
    night: {
      order: NIGHT_ORDER.KILL,
      targets: TARGET.OTHER_ALIVE,
      optional: true,
      prompt: '저격할 사람을 지목하세요 (총소리가 납니다)',
      narrationKey: 'night.soldier',
      makesGunshot: true,
    },
  }),

  politician: R({
    id: 'politician',
    name: '정치인',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    desc: '게임 중 딱 한 번, 투표 시간에 한 사람을 지목하면 득표와 상관없이 그 사람이 다수결 지정자가 된다.',
    day: {
      kind: DAY_ABILITY.FORCE_VOTE,
      once: true,
      prompt: '투표 결과로 강제 지정할 사람을 고르세요',
    },
  }),

  reporter: R({
    id: 'reporter',
    name: '기자',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    desc: '게임 중 딱 한 번, 밤에 한 명을 지목해 다음 날 아침 투표 전에 그 사람의 직업을 전체에 공개한다.',
    night: {
      order: NIGHT_ORDER.INFO,
      targets: TARGET.OTHER_ALIVE,
      optional: true,
      once: true,
      prompt: '직업을 폭로할 사람을 지목하세요 (1회 한정)',
      narrationKey: 'night.reporter',
    },
  }),

  independent_citizen: R({
    id: 'independent_citizen',
    name: '무소속당 (시민)',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    voteImmune: true,
    desc: '투표로는 죽지 않는다. 밤의 살해로는 죽는다.',
  }),

  lunatic: R({
    id: 'lunatic',
    name: '정신병자',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    desc: '본인은 다른 직업을 받은 줄 알지만 그 능력은 실제로는 아무 효과가 없다. 누군가에게 정체가 밝혀지거나 게임이 끝날 때까지 본인의 진짜 직업을 알 수 없다.',
  }),

  triplet_citizen: R({
    id: 'triplet_citizen',
    name: '삼둥이 (시민)',
    team: TEAM.CITIZEN,
    implemented: true,
    unique: true,
    minPlayers: 8,
    triplet: true,
    desc: '삼둥이 3인 세트 중 하나. 마피아 삼둥이와 서로를 알아보지만 순번은 모른다. 자기보다 순번이 뒤인 형제가 살아 있는 동안에는 죽지 않는다.',
  }),

  // ═══════════════════════════ 마피아 ═══════════════════════════
  // 평마피아도 편성에서 제외됐다 (평시민과 같은 이유로 정의만 남긴다)
  mafia: R({
    id: 'mafia',
    name: '마피아',
    team: TEAM.MAFIA,
    implemented: true,
    selectable: false,
    desc: '밤에 원형 자리 기준으로 자기 양옆에 앉은 사람만 죽일 수 있다.',
    night: { ...MAFIA_KILL },
  }),

  sniper: R({
    id: 'sniper',
    name: '저격수',
    team: TEAM.MAFIA,
    implemented: true,
    unique: true,
    desc: '투표 시간에 한 사람의 직업을 맞히면 그 사람이 즉사한다. 틀리면 저격수 본인이 죽는다. 쏘는 순간 모두에게 총소리가 들린다. 밤에는 양옆을 죽일 수 있다.',
    night: { ...MAFIA_KILL },
    day: {
      kind: DAY_ABILITY.SNIPE,
      once: true,
      prompt: '저격할 사람과 그 사람의 직업을 고르세요',
    },
  }),

  // 임시로 편성에서 제외했다. 규칙 자체는 그대로 살아 있으므로
  // selectable 을 true 로 되돌리고 MAFIA_POOL 에 다시 넣기만 하면 부활한다.
  rigger: R({
    id: 'rigger',
    name: '부정선거자',
    team: TEAM.MAFIA,
    implemented: true,
    selectable: false,
    unique: true,
    voteImmune: true,
    desc: '투표로는 죽지 않는다. 밤의 살해 능력은 1회 충전식이며, 투표에서 본인이 다수결로 지정되면 다시 충전된다.',
    night: { ...MAFIA_KILL, charged: true, prompt: '죽일 사람을 지목하세요 (충전 1회 소모)' },
  }),

  chairman: R({
    id: 'chairman',
    name: '회장',
    team: TEAM.MAFIA,
    implemented: true,
    unique: true,
    desc: '밤에 양옆을 죽일 수 있다. 게임 중 딱 한 번, 죽이는 대신 그 사람을 아무 능력 없는 마피아로 포섭할 수 있다.',
    night: {
      ...MAFIA_KILL,
      modes: ['KILL', 'CONVERT'],
      prompt: '죽이거나 포섭할 사람을 지목하세요',
    },
  }),

  independent_mafia: R({
    id: 'independent_mafia',
    name: '무소속당 (마피아)',
    team: TEAM.MAFIA,
    implemented: true,
    unique: true,
    voteImmune: true,
    desc: '투표로는 죽지 않는다. 밤에는 양옆을 죽일 수 있다.',
    night: { ...MAFIA_KILL },
  }),

  triplet_mafia: R({
    id: 'triplet_mafia',
    name: '삼둥이 (마피아)',
    team: TEAM.MAFIA,
    implemented: true,
    unique: true,
    minPlayers: 8,
    triplet: true,
    desc: '삼둥이 3인 세트 중 하나. 시민 삼둥이와 서로를 알아보지만 순번은 모른다. 자기보다 순번이 뒤인 형제가 살아 있는 동안에는 죽지 않는다. 밤에는 양옆을 죽일 수 있다.',
    night: { ...MAFIA_KILL },
  }),

  converted_mafia: R({
    id: 'converted_mafia',
    name: '포섭된 마피아',
    team: TEAM.MAFIA,
    implemented: true,
    selectable: false, // 회장의 포섭으로만 생긴다
    desc: '회장에게 포섭되어 마피아가 되었다. 아무 능력이 없다.',
  }),

  // ═══════════════════════════ 중립 ═══════════════════════════
  jindo: R({
    id: 'jindo',
    name: '진돗개',
    team: TEAM.NEUTRAL,
    implemented: true,
    unique: true,
    desc: '게임 시작 시 한 사람을 주인으로 정하고 그 직업을 알게 된다. 주인이 죽으면 같이 죽고, 주인이 승리하면 같이 승리한다.',
    start: {
      kind: 'IMPRINT',
      prompt: '주인으로 삼을 사람을 고르세요',
    },
  }),

  attention: R({
    id: 'attention',
    name: '관종',
    team: TEAM.NEUTRAL,
    implemented: true,
    unique: true,
    desc: '투표에서 생존자 과반의 표를 본인이 받으면 그 즉시 단독 승리한다.',
  }),

  serial_killer: R({
    id: 'serial_killer',
    name: '연쇄살인마',
    team: TEAM.NEUTRAL,
    implemented: true,
    unique: true,
    blocksTeamWin: true, // 살아 있는 한 시민도 마피아도 이기지 못한다
    desc: '밤에 아무나 지목해 죽일 수 있으며 총소리가 나지 않는다. 연쇄살인마가 살아 있는 한 시민도 마피아도 승리할 수 없다.',
    night: {
      order: NIGHT_ORDER.KILL,
      targets: TARGET.OTHER_ALIVE,
      optional: true,
      prompt: '죽일 사람을 지목하세요',
      narrationKey: 'night.serial_killer',
    },
  }),

  clown: R({
    id: 'clown',
    name: '삐에로',
    team: TEAM.NEUTRAL,
    implemented: true,
    unique: true,
    desc: '밤에 사람을 죽이지 않는 가짜 총소리를 낼 수 있다. 총소리를 낸 다음 날 투표로 누군가 처형되면 1점. 3점을 채우면 단독 승리한다.',
    night: {
      order: NIGHT_ORDER.KILL,
      targets: TARGET.NONE,
      optional: true,
      prompt: '가짜 총소리를 낼까요?',
      narrationKey: 'night.clown',
      makesGunshot: true,
    },
  }),

  triplet_neutral: R({
    id: 'triplet_neutral',
    name: '삼둥이 (셋째)',
    team: TEAM.NEUTRAL,
    implemented: true,
    unique: true,
    minPlayers: 8,
    triplet: true,
    desc: '삼둥이 셋째. 다른 두 형제는 셋째가 누구인지 모르고, 셋째도 그들이 누구인지 모른다. 셋째가 죽기 전에는 나머지 형제가 죽지 않는다. 밤마다 첫째와 둘째를 지목해 둘 다 맞히면 단독 승리한다.',
    night: {
      order: NIGHT_ORDER.INFO,
      targets: TARGET.OTHER_ALIVE,
      optional: true,
      pair: true, // 두 명을 지목한다
      prompt: '첫째와 둘째로 추정되는 두 사람을 고르세요',
      narrationKey: 'night.triplet_third',
    },
  }),
};

export const ROLE_LIST = Object.values(ROLES);
export const TRIPLET_IDS = ['triplet_mafia', 'triplet_citizen', 'triplet_neutral'];

// 자동 편성이 고르는 순서. 앞쪽일수록 먼저 들어간다.
// 부정선거자(rigger)는 임시 제외 상태라 풀에서 빠져 있다
export const MAFIA_POOL = ['sniper', 'chairman', 'independent_mafia', 'triplet_mafia'];
export const CITIZEN_POOL = [
  'police', 'guardian', 'detective', 'soldier', 'gymrat',
  'reporter', 'politician', 'lunatic', 'independent_citizen', 'triplet_citizen',
];
export const NEUTRAL_POOL = ['jindo', 'clown', 'attention', 'serial_killer', 'triplet_neutral'];

/**
 * 인원수에 맞는 진영별 권장 인원.
 *
 * 5~12인은 봇 시뮬레이션(조합별 60판)으로 실제 승률을 재서 정한 값이다.
 * 괄호 안은 그 조합에서 나온 마피아/시민 승률.
 * 마피아 수를 하나 올리면 승률이 30%p 이상 튀기 때문에, 이보다 잘 맞추기는 어렵다.
 *
 * 13인 이상은 측정하지 않았고 n/5 비율로 늘린 추정값이다.
 */
const RECOMMENDED = {
  4:  { mafia: 1, neutral: 0 },
  5:  { mafia: 1, neutral: 0 }, // 38 / 62
  6:  { mafia: 1, neutral: 1 }, // 30 / 70
  7:  { mafia: 2, neutral: 1 }, // 70 / 30
  8:  { mafia: 2, neutral: 0 }, // 70 / 30
  9:  { mafia: 2, neutral: 0 }, // 50 / 50
  10: { mafia: 2, neutral: 1 }, // 62 / 38
  11: { mafia: 2, neutral: 1 },
  12: { mafia: 2, neutral: 1 }, // 65 / 35
};

export function recommendCounts(n) {
  const base = RECOMMENDED[n] ?? {
    mafia: Math.max(1, Math.round(n / 5)),
    neutral: n >= 10 ? 2 : 1,
  };
  // 마피아가 처음부터 과반이면 게임이 성립하지 않는다
  const mafia = Math.max(1, Math.min(base.mafia, Math.ceil(n / 2) - 1));
  // 중립이 마피아보다 많으면 판이 이상해진다
  const neutral = Math.max(0, Math.min(base.neutral, mafia, n - mafia - 1));
  return { mafia, neutral, citizen: Math.max(1, n - mafia - neutral) };
}

export function getRole(id) {
  return ROLES[id] || null;
}

export function isTriplet(roleId) {
  return TRIPLET_IDS.includes(roleId);
}

/** 클라이언트로 내려보낼 직업 카탈로그 (로비 직업 편성 UI 용) */
export function roleCatalog() {
  return ROLE_LIST.filter((r) => r.selectable).map((r) => ({
    id: r.id,
    name: r.name,
    team: r.team,
    desc: r.desc,
    implemented: r.implemented,
    unique: r.unique,
    minPlayers: r.minPlayers,
    hasNight: !!r.night,
    hasDay: !!r.day,
    triplet: !!r.triplet,
  }));
}

/**
 * 저격수가 고를 수 있는 직업 후보.
 * 편성표는 공개 정보이므로 이번 판에 들어 있는 직업만 후보로 준다.
 * 삼둥이 3종은 「삼둥이」 하나로 합쳐서 판정한다.
 */
export function snipeChoices(configRoles) {
  const seen = new Set();
  const out = [];
  for (const id of configRoles) {
    const role = getRole(id);
    if (!role) continue;
    const key = role.triplet ? 'TRIPLET' : id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name: role.triplet ? '삼둥이' : role.name, team: role.team });
  }
  // 회장의 포섭으로 생길 수 있는 직업도 후보에 넣는다
  if (configRoles.includes('chairman')) {
    out.push({ key: 'converted_mafia', name: ROLES.converted_mafia.name, team: TEAM.MAFIA });
  }
  return out;
}

/** 저격 정답 판정: 실제 직업 기준, 삼둥이는 3종을 하나로 본다 */
export function snipeMatches(guessKey, actualRoleId) {
  if (guessKey === 'TRIPLET') return isTriplet(actualRoleId);
  return guessKey === actualRoleId;
}
