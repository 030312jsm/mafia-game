import {
  ROLES, TEAM, TARGET, NIGHT_ORDER, DAY_ABILITY, TRIPLET_IDS,
  MAFIA_POOL, CITIZEN_POOL, NEUTRAL_POOL, recommendCounts,
  getRole, roleCatalog, isTriplet, snipeChoices, snipeMatches,
} from './roles.js';
import { cue } from './narration.js';

export const PHASE = {
  LOBBY: 'LOBBY',
  SEATING: 'SEATING',
  ROLE_REVEAL: 'ROLE_REVEAL',
  NIGHT: 'NIGHT',
  DAWN: 'DAWN',
  DISCUSS: 'DISCUSS',
  VOTE: 'VOTE',
  EXECUTION: 'EXECUTION',
  END: 'END',
};

const DEFAULT_CONFIG = {
  // 편성 방식.
  // 'counts' = 진영별 인원수만 정하고, 어떤 직업이 들어갈지는 게임 시작 때 무작위로 뽑는다
  // 'manual' = 직업을 하나하나 직접 고른다 (예전 방식)
  compositionMode: 'counts',
  teamCounts: { mafia: 0, citizen: 0, neutral: 0 },
  // 어떤 직업이 이번 판에 들어 있는지 끝까지 감춘다.
  // 켜면 탐정의 가짜 후보·저격수의 선택지·정신병자의 위장도 전체 직업에서 뽑는다.
  hiddenLineup: false,
  roles: [],
  discussSeconds: 180,
  voteSeconds: 60,
  nightSeconds: 45,
  // 양옆 계산 시 죽은 사람을 건너뛸지 여부.
  adjacencySkipsDead: true,
  // 동표일 때 아무도 처형하지 않을지 여부
  tieMeansNoExecution: true,
  // 켜면 중립 「전원」을 제거해야 시민·마피아가 이긴다 (원래 스펙, 기본값).
  // 끄면 죽일 수단이 있는 중립(연쇄살인마)만 진영 승리를 막는다.
  //
  // 끄는 쪽이 시민에게 유리할 거라 보고 측정했으나 결과는 반대였다.
  // 살아 있는 중립이 마피아의 과반 승리를 막아주던 브레이크가 사라지면서
  // 마피아 승률이 63% → 82% 로 올랐다. 그래서 기본값은 스펙 그대로 둔다.
  strictNeutralElimination: true,
  // 마피아 진영이 밤에 한 명만 죽일지 여부.
  // true  = 각자 양옆을 지목하되 가장 많이 지목된 한 명만 죽는다 (동수면 무작위)
  // false = 마피아 각자가 독립적으로 죽인다 (마피아 수만큼 사망자가 나온다)
  mafiaSharedKill: true,
  // 이 일수를 넘기면 무승부로 끝낸다.
  // 서로 죽일 수단이 없는 생존자만 남으면(예: 삐에로 1 + 정치인 1) 규칙상 영원히
  // 끝나지 않는 상황이 실제로 발생한다. 그때 방이 멈춰 있지 않도록 하는 안전망이다.
  maxDays: 20,
  // maxDays 에 도달했을 때의 처리.
  // 'CITIZEN' = 마피아가 제한 시간 안에 이기지 못했으므로 시민 진영 승리 (기본)
  // 'NONE'    = 무승부
  maxDaysWinner: 'CITIZEN',
  // 방장이 버튼을 누르지 않아도 단계가 알아서 넘어간다.
  // 봇과 혼자 테스트할 때 켜두면 편하다.
  autoAdvance: false,
  // 특정 사람에게 특정 직업을 고정 배정한다. { playerId: roleId }
  // 직업을 하나씩 체험해 볼 때 쓴다.
  pinnedRoles: {},
  // 게임 중에 이번 판 직업 라인업과 각 능력을 볼 수 있게 할지.
  // 규칙을 익히는 중이면 켜두는 쪽이 편하다.
  showRoleList: true,
  // 투표를 공개로 진행할지.
  // 켜면 투표 중에도 누가 누구에게 몇 표를 줬는지 실시간으로 보인다.
  // (둘러앉아 손 드는 오프라인 방식과 같다) 끄면 개표 전까지 가려진다.
  openVoting: true,
};

// 방장이 버튼을 눌러야만 넘어가는 단계들
export const HOST_GATED = ['ROLE_REVEAL', 'DAWN', 'DISCUSS', 'EXECUTION'];
const AUTO_HOLD_MS = { ROLE_REVEAL: 15000, DAWN: 8000, DISCUSS: 20000, EXECUTION: 8000 };

const CLOWN_TARGET_CREDITS = 3;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class Room {
  constructor(code) {
    this.code = code;
    this.createdAt = Date.now();
    this.hostId = null;
    this.players = new Map();
    this.phase = PHASE.LOBBY;
    this.day = 0;
    this.config = { ...DEFAULT_CONFIG };
    this.publicLog = [];
    this.nightActions = new Map();
    this.ballots = new Map();
    this.pendingDeaths = [];
    this.blockedDeaths = [];      // 면역/삼둥이 순서로 죽지 않은 사람
    this.publicReveals = [];      // 기자 특종 [{playerId, roleName, day}]
    this.revealedIds = new Set();  // 전체에 공개된 사람
    this.forcedVoteTarget = null;  // 정치인
    this.soloWins = [];            // [{playerId, roleId, reason}]
    this.gunshotThisNight = false;
    this.result = null;
    this.deadline = null;
    this.qrDataUrl = null;
    this.joinUrl = null;
    this.narrationSeq = 0;
    // 이번 판에 실제로 쓰인 직업 목록. 시작할 때 확정된다.
    // config.roles 와 분리해 둔 이유는, 인원수 편성 모드에서는
    // 시작 전까지 어떤 직업이 뽑힐지 아무도 몰라야 하기 때문이다.
    this.activeRoles = [];
  }

  /** 규칙 판정에 쓰는 이번 판의 직업 목록 */
  get composition() {
    if (this.activeRoles.length) return this.activeRoles;
    return this.config.compositionMode === 'manual' ? this.config.roles : [];
  }

  /** 라인업을 감추는 판인지 */
  get lineupHidden() {
    return !!this.config.hiddenLineup && this.phase !== PHASE.END;
  }

  /**
   * 탐정의 가짜 후보·저격수의 선택지·정신병자의 위장에 쓸 직업 풀.
   * 라인업이 공개된 판에서는 「이번 판에 있는 직업」만 써야 정보가 의미를 갖고,
   * 감춰진 판에서는 전체 직업에서 뽑아야 한다.
   */
  candidatePool() {
    if (this.lineupHidden) {
      return Object.values(ROLES).filter((r) => r.implemented && r.selectable).map((r) => r.id);
    }
    return [...new Set(this.composition)];
  }

  // ── 플레이어 관리 ─────────────────────────────────────────────
  freshRoleState() {
    return {
      used: {},           // { night: true, day: true } — 1회성 능력 사용 여부
      charges: {},        // { kill: 1 } — 부정선거자
      jindoTargetId: null,
      clownArmed: false,  // 간밤에 가짜 총성을 냈는지
      clownCredits: 0,
      lunaticRevealed: false,
    };
  }

  addPlayer({ id, nickname, isBot = false }) {
    const player = {
      id, nickname, isBot,
      seat: null,
      roleId: null,          // 실제 직업
      fakeRoleId: null,      // 정신병자에게만: 본인이 믿고 있는 직업
      tripletOrder: null,    // 1 | 2 | 3
      alive: true,
      connected: true,
      socketId: null,
      info: [],
      rs: this.freshRoleState(),
      lastSeen: Date.now(),
    };
    this.players.set(id, player);
    // 봇은 절대 방장이 되지 않는다. 사람이 없으면 방을 진행할 수 없기 때문이다.
    if (!this.hostId && !isBot) this.hostId = id;
    return player;
  }

  get bots() { return this.playerList.filter((p) => p.isBot); }
  get humans() { return this.playerList.filter((p) => !p.isBot); }

  /**
   * 방장이 단계를 넘겨줄 수 없는 상태인지.
   * 죽었거나 접속이 끊긴 방장 때문에 방이 멈춰 있으면 안 된다.
   */
  get hostCanDrive() {
    const host = this.players.get(this.hostId);
    return !!(host && host.alive && host.connected);
  }

  /** 자동 진행이 필요한 상황이면 이 단계의 마감 시각을 돌려준다 */
  autoHoldFor(phase) {
    if (this.config.autoAdvance || !this.hostCanDrive) return AUTO_HOLD_MS[phase] ?? null;
    return null;
  }

  /** 혼자서도 게임을 굴려볼 수 있도록 방에 봇을 넣는다 */
  addBot(makeId) {
    if (this.phase !== PHASE.LOBBY) return { ok: false, error: '대기실에서만 봇을 넣을 수 있습니다.' };
    if (this.players.size >= 20) return { ok: false, error: '정원이 가득 찼습니다.' };
    const used = new Set(this.playerList.map((p) => p.nickname));
    let n = 1;
    while (used.has(`봇${n}`)) n++;
    const bot = this.addPlayer({ id: makeId(), nickname: `봇${n}`, isBot: true });
    this.rebuildComposition();
    return { ok: true, bot };
  }

  // ── 직업 체험 (특정 사람에게 특정 직업을 고정 배정) ──────────
  /**
   * 직업을 하나씩 눌러보며 확인할 수 있게, 원하는 직업을 미리 찜해둔다.
   * 편성표에 그 직업이 없으면 자동으로 끼워 넣는다.
   */
  pinRole(playerId, roleId) {
    if (this.phase !== PHASE.LOBBY) return { ok: false, error: '대기실에서만 바꿀 수 있습니다.' };
    if (!this.players.has(playerId)) return { ok: false, error: '방에 없는 플레이어입니다.' };
    this.config.pinnedRoles = { ...(this.config.pinnedRoles || {}) };

    if (!roleId) {
      delete this.config.pinnedRoles[playerId];
      return { ok: true };
    }
    const role = getRole(roleId);
    if (!role?.implemented || !role.selectable) return { ok: false, error: '고를 수 없는 직업입니다.' };
    if (role.minPlayers > this.players.size) {
      return { ok: false, error: `${role.name}은(는) ${role.minPlayers}인 이상에서만 쓸 수 있습니다.` };
    }
    if (role.unique) {
      const taken = Object.entries(this.config.pinnedRoles)
        .find(([pid, rid]) => rid === roleId && pid !== playerId);
      if (taken) return { ok: false, error: `${role.name}은(는) 이미 다른 사람이 찜했습니다.` };
    }
    this.config.pinnedRoles[playerId] = roleId;
    this.ensurePinnedInComposition();
    return { ok: true };
  }

  /** 찜한 직업들이 편성표 안에 실제로 들어 있도록 맞춘다 */
  ensurePinnedInComposition() {
    const pins = Object.values(this.config.pinnedRoles || {});
    if (!pins.length) return;

    // 삼둥이는 3종 세트라 하나만 찜해도 나머지 둘이 같이 들어가야 한다
    const wanted = [...pins];
    if (pins.some((r) => isTriplet(r))) {
      for (const t of TRIPLET_IDS) if (!wanted.includes(t)) wanted.push(t);
    }

    const need = {};
    for (const r of wanted) need[r] = (need[r] || 0) + 1;
    const roles = [...this.config.roles];
    const pinnedSet = new Set(wanted);

    for (const [rid, count] of Object.entries(need)) {
      let have = roles.filter((r) => r === rid).length;
      while (have < count) {
        // 교체 대상: 평범한 시민을 먼저, 없으면 찜하지 않은 아무 직업
        let idx = roles.indexOf('citizen');
        if (idx === -1) idx = roles.findIndex((r) => !pinnedSet.has(r));
        if (idx === -1) break; // 자리가 없다 — validateConfig 가 걸러낸다
        roles[idx] = rid;
        have++;
      }
    }
    // 찜 때문에 중립이 마피아보다 많아지는 일이 없도록 정리한다
    this.config.roles = this.capNeutrals(roles, pinnedSet);
  }

  /** 가장 마지막에 들어온 봇을 뺀다 (id 를 주면 그 봇을) */
  removeBot(botId = null) {
    if (this.phase !== PHASE.LOBBY) return { ok: false, error: '대기실에서만 봇을 뺄 수 있습니다.' };
    const list = this.bots;
    if (!list.length) return { ok: false, error: '뺄 봇이 없습니다.' };
    const target = botId ? list.find((b) => b.id === botId) : list[list.length - 1];
    if (!target) return { ok: false, error: '없는 봇입니다.' };
    this.players.delete(target.id);
    this.rebuildComposition();
    return { ok: true };
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase !== PHASE.LOBBY) { p.connected = false; return; }
    this.players.delete(id);
    if (this.config.pinnedRoles?.[id]) {
      this.config.pinnedRoles = { ...this.config.pinnedRoles };
      delete this.config.pinnedRoles[id];
    }
    // 방장은 반드시 사람이어야 한다 (봇은 페이즈를 넘길 수 없다)
    if (this.hostId === id) this.hostId = this.humans[0]?.id ?? null;
  }

  get playerList() { return [...this.players.values()]; }
  get alivePlayers() { return this.playerList.filter((p) => p.alive); }
  get aliveBySeat() {
    return this.alivePlayers.filter((p) => p.seat != null).sort((a, b) => a.seat - b.seat);
  }
  get seatCount() { return this.players.size; }

  seatMap() {
    const map = {};
    for (const p of this.players.values()) if (p.seat != null) map[p.seat] = p.id;
    return map;
  }

  /** 실제 직업 — 모든 판정의 기준 */
  trueRole(p) { return p ? getRole(p.roleId) : null; }
  /** 본인이 믿고 있는 직업 — UI 와 능력 사용 화면의 기준 (정신병자만 달라진다) */
  actingRole(p) { return p ? getRole(p.fakeRoleId || p.roleId) : null; }
  teamOf(p) { return this.trueRole(p)?.team ?? null; }

  tripletsOf() { return this.playerList.filter((p) => isTriplet(p.roleId)); }

  // ── 인접(양옆) 계산 ────────────────────────────────────────────
  adjacentIds(player) {
    if (player.seat == null) return [];
    if (this.config.adjacencySkipsDead) {
      const ring = this.aliveBySeat;
      const idx = ring.findIndex((p) => p.id === player.id);
      if (idx === -1 || ring.length < 2) return [];
      const left = ring[(idx - 1 + ring.length) % ring.length];
      const right = ring[(idx + 1) % ring.length];
      return [...new Set([left.id, right.id])].filter((id) => id !== player.id);
    }
    const total = this.seatCount;
    const bySeat = new Map();
    for (const p of this.players.values()) if (p.seat != null) bySeat.set(p.seat, p);
    const leftSeat = ((player.seat - 2 + total) % total) + 1;
    const rightSeat = (player.seat % total) + 1;
    return [bySeat.get(leftSeat), bySeat.get(rightSeat)]
      .filter((p) => p && p.alive && p.id !== player.id)
      .map((p) => p.id);
  }

  legalTargets(player, spec) {
    if (!spec) return [];

    let ids;
    switch (spec.targets) {
      case TARGET.NONE: return [];
      case TARGET.ANY_ALIVE: ids = this.alivePlayers.map((p) => p.id); break;
      case TARGET.OTHER_ALIVE:
        ids = this.alivePlayers.filter((p) => p.id !== player.id).map((p) => p.id); break;
      case TARGET.ADJACENT: ids = this.adjacentIds(player); break;
      default: return [];
    }

    // 마피아 진영은 동료를 죽이거나 포섭할 수 없다.
    // (서로를 이미 알고 있으므로 목록에서 빼도 정보가 새지 않는다)
    const role = this.actingRole(player);
    if (role?.team === TEAM.MAFIA && spec.order === NIGHT_ORDER.KILL) {
      ids = ids.filter((id) => this.teamOf(this.players.get(id)) !== TEAM.MAFIA);
    }
    return ids;
  }

  // ── 능력 사용 가능 여부 ───────────────────────────────────────
  canActNight(p) {
    const role = this.actingRole(p);
    if (!p.alive || !role?.night) return false;
    if (role.night.once && p.rs.used.night) return false;
    if (role.night.charged && (p.rs.charges.kill ?? 0) <= 0) return false;
    return true;
  }

  canActDay(p) {
    const role = this.actingRole(p);
    if (!p.alive || !role?.day) return false;
    if (role.day.once && p.rs.used.day) return false;
    return true;
  }

  needsStartAction(p) {
    const role = this.actingRole(p);
    return !!(p.alive && role?.start && !p.rs.used.start);
  }

  // ── 설정 검증 ─────────────────────────────────────────────────
  validateConfig() {
    const n = this.players.size;

    // 인원수 편성 모드: 직업 목록 대신 진영별 인원수만 본다
    if (this.config.compositionMode === 'counts') {
      const errors = [];
      if (n < 4) errors.push('최소 4명이 필요합니다.');
      errors.push(...this.countsFeasible(this.config.teamCounts, n));
      const unseated = this.playerList.filter((p) => p.seat == null);
      const c = this.config.teamCounts;
      return {
        ok: errors.length === 0,
        errors,
        teams: { MAFIA: c.mafia, CITIZEN: c.citizen, NEUTRAL: c.neutral },
        unseated: unseated.map((p) => p.id),
      };
    }

    const errors = [];
    const roles = this.config.roles;

    if (n < 4) errors.push('최소 4명이 필요합니다.');
    if (roles.length !== n) {
      errors.push(`직업 ${roles.length}개 / 참가자 ${n}명 — 개수가 맞아야 합니다.`);
    }

    const counts = {};
    for (const rid of roles) {
      const role = getRole(rid);
      if (!role) { errors.push(`알 수 없는 직업: ${rid}`); continue; }
      if (!role.implemented) errors.push(`${role.name}은(는) 아직 구현되지 않았습니다.`);
      // 평마피아·평시민은 편성에서 빠졌다. 다만 테스트에서는 필요하므로
      // 테스트 훅(deterministicRoles)이 켜져 있을 때만 허용한다.
      if (!role.selectable && !this.config.deterministicRoles) {
        errors.push(`${role.name}은(는) 직접 편성할 수 없습니다.`);
      }
      if (role.minPlayers > n) errors.push(`${role.name}은(는) ${role.minPlayers}인 이상에서만 사용할 수 있습니다.`);
      counts[rid] = (counts[rid] || 0) + 1;
    }
    for (const [rid, c] of Object.entries(counts)) {
      const role = getRole(rid);
      if (role?.unique && c > 1) errors.push(`${role.name}은(는) 1명만 넣을 수 있습니다.`);
    }

    // 삼둥이는 3종 세트가 전부 있거나 전부 없어야 한다
    const tripletCount = roles.filter((r) => isTriplet(r)).length;
    if (tripletCount > 0 && tripletCount !== 3) {
      errors.push('삼둥이는 마피아·시민·셋째 3종을 모두 넣거나 모두 빼야 합니다.');
    }

    // 정신병자는 위장할 직업이 필요하다
    if (counts.lunatic) {
      const disguisePool = this.lunaticDisguisePool(roles);
      if (!disguisePool.length) {
        errors.push('정신병자가 위장할 직업이 없습니다. 편성표에 시민 직업을 하나 더 넣으세요.');
      }
    }

    const teams = { MAFIA: 0, CITIZEN: 0, NEUTRAL: 0 };
    for (const rid of roles) { const r = getRole(rid); if (r) teams[r.team]++; }
    if (teams.MAFIA === 0) errors.push('마피아가 최소 1명은 있어야 합니다.');
    if (teams.MAFIA * 2 >= n) errors.push('마피아가 처음부터 과반입니다. 인원 편성을 조정하세요.');

    const unseated = this.playerList.filter((p) => p.seat == null);
    return { ok: errors.length === 0, errors, teams, unseated: unseated.map((p) => p.id) };
  }

  /**
   * 정신병자가 뒤집어쓸 직업 후보.
   * **이번 판 편성표에 실제로 들어 있는 시민 직업만** 쓴다.
   * 편성표는 공개 정보라, 없는 직업을 주면 본인이 바로 이상을 눈치챈다.
   */
  lunaticDisguisePool(roles = null) {
    const source = roles ?? this.candidatePool();
    const pool = [...new Set(source)]
      .map(getRole)
      .filter((r) => r && r.team === TEAM.CITIZEN && r.id !== 'lunatic');
    if (pool.length) return pool;
    // 뽑을 게 없으면 전체 시민 직업에서 고른다 (라인업이 감춰진 판 등)
    return Object.values(ROLES).filter(
      (r) => r.implemented && r.selectable && r.team === TEAM.CITIZEN && r.id !== 'lunatic'
    );
  }

  /**
   * 인원수에 맞는 편성표를 만든다.
   * 평마피아·평시민이 없어졌으므로 모든 직업이 서로 다르다.
   * 삼둥이는 3종 세트라 자리가 딱 맞을 때만 넣는다.
   */
  suggestRoles(n = this.players.size) {
    const rec = recommendCounts(n);
    const usable = (pool) => pool.filter((id) => {
      const r = getRole(id);
      return r?.implemented && !isTriplet(id) && r.minPlayers <= n;
    });
    const M = usable(MAFIA_POOL);
    const C = usable(CITIZEN_POOL);
    const N = usable(NEUTRAL_POOL);

    const picks = [];
    picks.push(...M.slice(0, rec.mafia));
    picks.push(...N.slice(0, rec.neutral));
    picks.push(...C.slice(0, Math.max(0, n - picks.length)));

    // 아직 자리가 남으면 남은 직업으로 채운다
    const rest = [...C, ...N, ...M].filter((id) => !picks.includes(id));
    while (picks.length < n && rest.length) picks.push(rest.shift());

    // 그래도 3자리 이상 비면 삼둥이 세트를 넣는다 (8인 이상에서만)
    if (n >= 8 && picks.length + TRIPLET_IDS.length <= n) picks.push(...TRIPLET_IDS);

    return this.capNeutrals(picks.slice(0, n));
  }

  /**
   * 중립이 마피아보다 많아지지 않게 맞춘다.
   * 넘치는 중립은 아직 안 쓴 시민 직업으로 바꾼다.
   * pinned 에 든 직업은 사용자가 직접 고른 것이라 건드리지 않는다.
   */
  capNeutrals(roles, pinned = new Set()) {
    const out = [...roles];
    const teamOf = (id) => getRole(id)?.team;
    const countTeam = (t) => out.filter((id) => teamOf(id) === t).length;

    let guard = 0;
    while (countTeam(TEAM.NEUTRAL) > countTeam(TEAM.MAFIA) && guard++ < 20) {
      // 바꿀 수 있는(찜하지 않은) 중립을 하나 고른다.
      // 삼둥이는 3종 세트라 하나만 빼면 편성이 깨지므로 건드리지 않는다.
      const idx = out.findIndex(
        (id) => teamOf(id) === TEAM.NEUTRAL && !pinned.has(id) && !isTriplet(id)
      );
      if (idx === -1) break;
      const spare = CITIZEN_POOL.find((id) => {
        const r = getRole(id);
        return r?.implemented && !isTriplet(id) && !out.includes(id);
      });
      if (!spare) break;
      out[idx] = spare;
    }
    return out;
  }

  /** 로비에 보여줄 권장 인원 (인원수 기준) */
  recommendation(n = this.players.size) {
    return recommendCounts(n);
  }

  /** 인원수 편성 모드에서 진영별로 쓸 수 있는 직업 (삼둥이 제외) */
  poolFor(team) {
    const pool = { MAFIA: MAFIA_POOL, CITIZEN: CITIZEN_POOL, NEUTRAL: NEUTRAL_POOL }[team] ?? [];
    return pool.filter((id) => {
      const r = getRole(id);
      return r?.implemented && r.selectable && !isTriplet(id);
    });
  }

  /**
   * 진영별 인원수만 받아서 실제 직업을 무작위로 뽑는다.
   * 삼둥이는 마피아·시민·중립 한 자리씩 정확히 차지하므로 인원수를 깨지 않는다.
   */
  drawComposition(counts, n = this.players.size) {
    let { mafia, citizen, neutral } = counts;
    const roles = [];

    if (n >= 8 && mafia >= 1 && citizen >= 1 && neutral >= 1 && Math.random() < 0.3) {
      roles.push(...TRIPLET_IDS);
      mafia--; citizen--; neutral--;
    }
    roles.push(...shuffle(this.poolFor(TEAM.MAFIA)).slice(0, mafia));
    roles.push(...shuffle(this.poolFor(TEAM.CITIZEN)).slice(0, citizen));
    roles.push(...shuffle(this.poolFor(TEAM.NEUTRAL)).slice(0, neutral));
    return roles;
  }

  /** 인원수 편성이 실제로 가능한지 (직업 수가 모자라지 않는지) */
  countsFeasible(counts, n = this.players.size) {
    const errors = [];
    const { mafia, citizen, neutral } = counts;
    const total = mafia + citizen + neutral;

    if (total !== n) errors.push(`진영 인원 합계 ${total}명 / 참가자 ${n}명 — 개수가 맞아야 합니다.`);
    if (mafia < 1) errors.push('마피아가 최소 1명은 있어야 합니다.');
    if (citizen < 1) errors.push('시민이 최소 1명은 있어야 합니다.');
    if (neutral < 0) errors.push('중립 인원이 잘못됐습니다.');
    if (mafia * 2 >= n) errors.push('마피아가 처음부터 과반입니다.');
    if (neutral > mafia) errors.push('중립은 마피아보다 많을 수 없습니다.');

    // 삼둥이 없이도 뽑을 수 있어야 한다 (삼둥이는 확률적으로만 들어간다)
    const cap = { mafia: this.poolFor(TEAM.MAFIA).length,
                  citizen: this.poolFor(TEAM.CITIZEN).length,
                  neutral: this.poolFor(TEAM.NEUTRAL).length };
    if (mafia > cap.mafia) errors.push(`마피아 직업이 ${cap.mafia}종뿐이라 ${mafia}명을 채울 수 없습니다.`);
    if (citizen > cap.citizen) errors.push(`시민 직업이 ${cap.citizen}종뿐이라 ${citizen}명을 채울 수 없습니다.`);
    if (neutral > cap.neutral) errors.push(`중립 직업이 ${cap.neutral}종뿐이라 ${neutral}명을 채울 수 없습니다.`);

    return errors;
  }

  /**
   * 설정이 바뀐 뒤 앞뒤를 맞춘다.
   * 인원수 편성으로 넘어가면 직업 목록과 찜은 의미가 없으므로 비운다
   * (남겨두면 시작 전에 어떤 직업이 들어갈지 새어 나간다).
   */
  normalizeConfig() {
    if (this.config.compositionMode === 'counts') {
      this.config.roles = [];
      this.config.pinnedRoles = {};
      const c = this.config.teamCounts;
      if (!c || (c.mafia + c.citizen + c.neutral) === 0) this.resetTeamCounts();
    } else if (!this.config.roles?.length) {
      this.config.roles = this.suggestRoles();
    }
  }

  /** 인원수가 바뀌면 권장값으로 다시 맞춘다 */
  resetTeamCounts(n = this.players.size) {
    const rec = recommendCounts(n);
    this.config.teamCounts = { mafia: rec.mafia, citizen: rec.citizen, neutral: rec.neutral };
  }

  /**
   * 편성표를 인원수에 맞게 다시 만든다.
   * 찜해둔 직업은 반드시 살려둔다 — 자동 편성이 찜을 지워버리면
   * 삼둥이처럼 세트로 들어가야 하는 직업이 반쪽만 남는다.
   */
  rebuildComposition() {
    this.resetTeamCounts();
    if (this.config.compositionMode === 'manual') {
      this.config.roles = this.suggestRoles();
      this.ensurePinnedInComposition();
    }
  }

  // ── 시작 ──────────────────────────────────────────────────────
  startSeating() {
    if (this.phase !== PHASE.LOBBY) return { ok: false, error: '이미 시작된 방입니다.' };
    if (this.players.size < 4) return { ok: false, error: '최소 4명이 필요합니다.' };
    this.phase = PHASE.SEATING;
    for (const p of this.players.values()) p.seat = null;
    this.log('둥글게 앉은 뒤 각자 자기 자리 번호를 선택하세요.');
    return { ok: true };
  }

  claimSeat(playerId, seat) {
    if (this.phase !== PHASE.SEATING) return { ok: false, error: '지금은 자리를 정할 수 없습니다.' };
    const n = this.seatCount;
    if (!Number.isInteger(seat) || seat < 1 || seat > n) return { ok: false, error: '없는 자리 번호입니다.' };
    for (const p of this.players.values()) {
      if (p.seat === seat && p.id !== playerId) {
        return { ok: false, error: `${seat}번 자리는 이미 ${p.nickname}님이 앉았습니다.` };
      }
    }
    const me = this.players.get(playerId);
    if (!me) return { ok: false, error: '방에 없는 플레이어입니다.' };
    me.seat = seat;
    return { ok: true };
  }

  startGame() {
    const v = this.validateConfig();
    if (!v.ok) return { ok: false, error: v.errors.join('\n') };
    if (v.unseated.length) return { ok: false, error: '아직 자리를 정하지 않은 사람이 있습니다.' };

    // 이번 판에 쓸 직업 목록을 확정한다.
    // 인원수 편성 모드에서는 여기서 처음으로 뽑히므로, 그 전까지는 아무도 알 수 없다.
    this.activeRoles =
      this.config.compositionMode === 'counts'
        ? this.drawComposition(this.config.teamCounts)
        : [...this.config.roles];

    // 찜해둔 직업을 먼저 배정하고, 나머지를 나눠 준다.
    const pins = this.config.compositionMode === 'manual' ? (this.config.pinnedRoles || {}) : {};
    const pool = [...this.activeRoles];
    const fixed = new Map();
    for (const p of this.aliveBySeat) {
      const rid = pins[p.id];
      if (!rid) continue;
      const idx = pool.indexOf(rid);
      if (idx >= 0) { pool.splice(idx, 1); fixed.set(p.id, rid); }
    }

    // deterministicRoles 는 테스트 전용 (MAFIA_TEST_HOOKS=1 일 때만 설정 가능).
    // 자리 번호 순서대로 편성표를 그대로 배정한다.
    const assigned = this.config.deterministicRoles ? pool : shuffle(pool);
    let i = 0;
    for (const p of this.aliveBySeat) {
      p.roleId = fixed.get(p.id) ?? assigned[i++];
      p.fakeRoleId = null;
      p.tripletOrder = null;
      p.alive = true;
      p.info = [];
      p.rs = this.freshRoleState();
    }

    // 삼둥이 순번 — 중립은 무조건 셋째, 첫째/둘째는 마피아·시민 중 무작위
    const triplets = this.tripletsOf();
    if (triplets.length === 3) {
      const third = triplets.find((p) => p.roleId === 'triplet_neutral');
      const rest = triplets.filter((p) => p !== third);
      const others = this.config.deterministicRoles ? rest : shuffle(rest);
      third.tripletOrder = 3;
      others[0].tripletOrder = 1;
      others[1].tripletOrder = 2;
    }

    // 부정선거자 충전 1회
    for (const p of this.players.values()) {
      if (this.trueRole(p)?.night?.charged) p.rs.charges.kill = 1;
    }

    // 정신병자 위장 직업
    const lunatic = this.playerList.find((p) => p.roleId === 'lunatic');
    if (lunatic) {
      const pool = this.lunaticDisguisePool(this.lineupHidden ? null : this.activeRoles);
      lunatic.fakeRoleId = (this.config.deterministicRoles ? pool[0] : pick(pool)).id;
    }

    this.phase = PHASE.ROLE_REVEAL;
    this.day = 1;
    this.result = null;
    this.soloWins = [];
    this.revealedIds = new Set();
    this.publicReveals = [];
    this.log('게임이 시작되었습니다. 각자 자기 직업을 확인하세요.');

    const cues = [cue('game.start'), cue('role.reveal')];
    const personal = [];
    for (const p of this.alivePlayers) {
      if (this.needsStartAction(p)) {
        personal.push({ playerId: p.id, cue: cue('start.jindo', null, 'personal') });
      }
    }
    return { ok: true, cues, personal };
  }

  /** 진돗개의 각인 (직업 확인 단계) */
  submitStartAction(playerId, targetId) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: '방에 없는 플레이어입니다.' };
    if (this.phase !== PHASE.ROLE_REVEAL) return { ok: false, error: '지금은 사용할 수 없습니다.' };
    if (!this.needsStartAction(p)) return { ok: false, error: '사용할 수 있는 능력이 없습니다.' };
    const target = this.players.get(targetId);
    if (!target || !target.alive || target.id === p.id) return { ok: false, error: '지목할 수 없는 대상입니다.' };

    p.rs.jindoTargetId = target.id;
    p.rs.used.start = true;
    this.tell(p.id, `주인은 ${this.label(target)} 입니다. 직업은 「${this.trueRole(target).name}」.`);
    return { ok: true };
  }

  startActionsPending() {
    return this.alivePlayers.filter((p) => this.needsStartAction(p)).map((p) => p.id);
  }

  /** 방장이 강제로 넘길 때 미완료 시작 능력을 무작위로 채운다 */
  autoFillStartActions() {
    for (const p of this.alivePlayers) {
      if (!this.needsStartAction(p)) continue;
      const others = this.alivePlayers.filter((o) => o.id !== p.id);
      if (others.length) this.submitStartAction(p.id, pick(others).id);
      else p.rs.used.start = true;
    }
  }

  // ── 밤 ────────────────────────────────────────────────────────
  beginNight() {
    this.phase = PHASE.NIGHT;
    this.nightActions.clear();
    this.pendingDeaths = [];
    this.blockedDeaths = [];
    this.publicReveals = [];
    this.forcedVoteTarget = null;
    this.gunshotThisNight = false;
    for (const p of this.players.values()) p.rs.clownArmed = false;
    this.deadline = Date.now() + this.config.nightSeconds * 1000;
    this.log(`${this.day}일차 밤이 되었습니다.`);

    const cues = [cue('night.begin')];
    const personal = [];
    for (const p of this.alivePlayers) {
      const role = this.actingRole(p);
      if (this.canActNight(p)) {
        personal.push({ playerId: p.id, cue: cue(role.night.narrationKey, null, 'personal') });
      } else {
        personal.push({ playerId: p.id, cue: cue('night.wait', null, 'personal') });
      }
    }
    return { cues, personal };
  }

  submitNightAction(playerId, { targetId, secondId, mode } = {}) {
    if (this.phase !== PHASE.NIGHT) return { ok: false, error: '지금은 밤이 아닙니다.' };
    const p = this.players.get(playerId);
    if (!p || !p.alive) return { ok: false, error: '행동할 수 없습니다.' };
    const role = this.actingRole(p);
    if (!this.canActNight(p)) return { ok: false, error: '지금 사용할 수 있는 능력이 없습니다.' };

    const spec = role.night;

    // 능력 사용 포기
    if (targetId === null || targetId === 'PASS') {
      this.nightActions.set(playerId, { passed: true });
      return { ok: true };
    }

    // 삐에로: 지목 없이 발동만
    if (spec.targets === TARGET.NONE) {
      if (targetId !== 'FIRE') return { ok: false, error: '잘못된 요청입니다.' };
      this.nightActions.set(playerId, { targetId: 'FIRE', passed: false });
      this.consumeNightUse(p, spec);
      return { ok: true };
    }

    const legal = this.legalTargets(p, spec);
    if (!legal.includes(targetId)) return { ok: false, error: '지목할 수 없는 대상입니다.' };

    // 삼둥이 셋째: 두 명을 지목한다
    if (spec.pair) {
      if (!secondId || secondId === targetId) return { ok: false, error: '서로 다른 두 사람을 골라야 합니다.' };
      if (!legal.includes(secondId)) return { ok: false, error: '지목할 수 없는 대상입니다.' };
    }

    // 회장: 죽이기 / 포섭 선택
    let useMode = null;
    if (spec.modes) {
      useMode = spec.modes.includes(mode) ? mode : 'KILL';
      if (useMode === 'CONVERT' && p.rs.used.convert) {
        return { ok: false, error: '포섭은 게임 중 한 번만 쓸 수 있습니다.' };
      }
    }

    this.nightActions.set(playerId, { targetId, secondId: secondId ?? null, mode: useMode, passed: false });
    this.consumeNightUse(p, spec, useMode);
    return { ok: true };
  }

  /**
   * 능력 사용 횟수를 지목 시점에 차감한다.
   * 헬창에게 막혔더라도 소모된 것으로 본다.
   */
  consumeNightUse(p, spec, mode) {
    if (spec.once) p.rs.used.night = true;
    if (spec.charged) p.rs.charges.kill = Math.max(0, (p.rs.charges.kill ?? 0) - 1);
    if (mode === 'CONVERT') p.rs.used.convert = true;
  }

  allNightActionsIn() {
    return this.alivePlayers.filter((p) => this.canActNight(p)).every((p) => this.nightActions.has(p.id));
  }

  /** 밤 해결: 차단 → 보호 → 포섭 → 살해 → 목격 → 정보 */
  resolveNight() {
    // 판정은 언제나 실제 직업 기준. 정신병자의 행동은 여기서 조용히 버려진다.
    const acts = [];
    for (const p of this.alivePlayers) {
      const role = this.trueRole(p);
      if (!role?.night) continue;
      const a = this.nightActions.get(p.id);
      if (!a || a.passed || !a.targetId) continue;
      acts.push({ p, role, a });
    }
    const at = (order, filter = () => true) =>
      acts.filter((x) => x.role.night.order === order && filter(x));

    const blocked = new Set();
    const protectedIds = new Set();
    const killIntents = [];
    const killers = new Set();
    let gunshot = false;

    // 1. 차단
    for (const { p, a } of at(NIGHT_ORDER.BLOCK)) {
      blocked.add(a.targetId);
      this.tell(p.id, `${this.label(this.players.get(a.targetId))} 의 능력을 하루 동안 막았습니다.`);
    }

    const active = (x) => !blocked.has(x.p.id);

    // 2. 보호 — 누가 누구를 지켰는지 남겨둔다 (막아냈을 때 알려주기 위해)
    const guards = [];
    for (const { p, a } of at(NIGHT_ORDER.PROTECT).filter(active)) {
      protectedIds.add(a.targetId);
      guards.push({ byId: p.id, targetId: a.targetId });
    }

    // 3. 포섭 (회장) — 살해 대신 쓰는 능력이라 그날 밤 살해는 일어나지 않는다
    const converts = [];
    for (const { p, a } of at(NIGHT_ORDER.KILL, (x) => x.a.mode === 'CONVERT').filter(active)) {
      converts.push({ byId: p.id, targetId: a.targetId });
    }

    // 4. 살해
    const mafiaIntents = [];
    for (const { p, role, a } of at(NIGHT_ORDER.KILL, (x) => x.a.mode !== 'CONVERT').filter(active)) {
      if (role.night.targets === TARGET.NONE) {
        // 삐에로의 가짜 총성 — 아무도 죽지 않는다
        gunshot = true;
        p.rs.clownArmed = true;
        continue;
      }
      // 지목에 참여한 사람은 모두 「살해를 시도한 사람」이다 (경찰의 목격 판정 기준)
      killers.add(p.id);
      if (role.night.makesGunshot) gunshot = true;

      if (this.config.mafiaSharedKill && role.team === TEAM.MAFIA) {
        mafiaIntents.push({ actorId: p.id, targetId: a.targetId });
      } else {
        killIntents.push({ playerId: a.targetId, cause: 'NIGHT_KILL', byId: p.id });
      }
    }

    // 마피아 진영은 밤에 한 명만 죽인다. 가장 많이 지목된 사람, 동수면 무작위.
    if (mafiaIntents.length) {
      const counts = {};
      for (const m of mafiaIntents) counts[m.targetId] = (counts[m.targetId] || 0) + 1;
      let best = 0;
      let top = [];
      for (const [id, c] of Object.entries(counts)) {
        if (c > best) { best = c; top = [id]; }
        else if (c === best) top.push(id);
      }
      const chosenId = pick(top);
      const chosenBy = mafiaIntents.find((m) => m.targetId === chosenId).actorId;
      killIntents.push({ playerId: chosenId, cause: 'NIGHT_KILL', byId: chosenBy });

      if (Object.keys(counts).length > 1) {
        const label = this.label(this.players.get(chosenId));
        for (const m of mafiaIntents) {
          this.tell(m.actorId, `마피아의 지목이 갈려 ${label} 이(가) 이번 밤의 대상이 되었습니다.`);
        }
      }
    }

    // 5. 목격 (경찰) — 살해 「시도」를 기준으로 본다
    const policeKills = [];
    for (const { p, a } of at(NIGHT_ORDER.WITNESS).filter(active)) {
      const suspect = this.players.get(a.targetId);
      if (killers.has(a.targetId)) {
        policeKills.push({ playerId: a.targetId, cause: 'POLICE', byId: p.id });
        this.tell(p.id, `${this.label(suspect)} 이(가) 사람을 죽이려는 것을 목격하고 사살했습니다.`);
      } else {
        this.tell(p.id, `${this.label(suspect)} 은(는) 간밤에 아무도 죽이지 않았습니다.`);
      }
    }

    // 6. 정보
    for (const { p, role, a } of at(NIGHT_ORDER.INFO).filter(active)) {
      const target = this.players.get(a.targetId);

      if (role.id === 'detective') {
        const real = this.trueRole(target);
        const decoy = pick(this.decoyPoolFor(target));
        const pair = shuffle([real.name, decoy.name]);
        this.tell(p.id, `${this.label(target)} 의 직업은 「${pair[0]}」 또는 「${pair[1]}」 중 하나입니다.`);

      } else if (role.id === 'reporter') {
        const real = this.trueRole(target);
        this.publicReveals.push({ playerId: target.id, roleName: real.name, day: this.day });
        this.revealedIds.add(target.id);
        if (target.roleId === 'lunatic') {
          target.rs.lunaticRevealed = true;
          this.tell(target.id, '당신의 정체가 폭로되었습니다. 당신은 정신병자였습니다.');
        }
        this.tell(p.id, `${this.label(target)} 의 정체를 특종으로 터뜨렸습니다.`);

      } else if (role.id === 'triplet_neutral') {
        const guessed = [a.targetId, a.secondId];
        const siblings = new Set(this.tripletsOf().filter((s) => s.id !== p.id).map((s) => s.id));
        const hits = guessed.filter((g) => siblings.has(g)).length;
        const names = guessed.map((g) => this.label(this.players.get(g))).join(', ');

        if (hits === 2) {
          this.soloWins.push({
            playerId: p.id, roleId: 'triplet_neutral',
            reason: '삼둥이 셋째가 첫째와 둘째를 모두 맞혔습니다.',
          });
          this.tell(p.id, `${names} — 두 형제를 모두 맞혔습니다. 당신의 승리입니다.`);
        } else if (hits === 1) {
          this.tell(p.id, `${names} — 둘 중 한 명만 형제입니다. 누가 맞았는지는 알 수 없습니다.`);
        } else {
          this.tell(p.id, `${names} — 둘 다 형제가 아닙니다.`);
        }
      }
    }

    // 차단 통보
    for (const id of blocked) {
      const p = this.players.get(id);
      if (p && this.actingRole(p)?.night) this.tell(id, '누군가에 의해 능력이 차단되었습니다.');
    }

    // 포섭 실행 — 보호받고 있어도 포섭은 막히지 않는다
    for (const c of converts) {
      const target = this.players.get(c.targetId);
      if (!target || !target.alive) continue;
      target.roleId = 'converted_mafia';
      target.fakeRoleId = null;
      target.tripletOrder = null;
      this.tell(target.id, '당신은 회장에게 포섭되었습니다. 이제부터 마피아 진영입니다.');
      this.tell(c.byId, `${this.label(target)} 을(를) 포섭했습니다.`);
    }

    // 수호자에게 「막아냈다」고 알려준다.
    // 이게 없으면 아무도 죽지 않은 밤과 구분이 안 돼서, 자기 능력이 통했는지 영영 모른다.
    const attacked = new Set(killIntents.map((k) => k.playerId));
    for (const g of guards) {
      if (!attacked.has(g.targetId)) continue;
      const who = g.targetId === g.byId ? '당신' : this.label(this.players.get(g.targetId));
      this.tell(g.byId, `${who} 을(를) 노린 공격이 있었지만 막아냈습니다.`);
    }

    // 호신술사의 되받아치기.
    // 수호자에게 보호받아 살해 자체가 무산됐으면 발동하지 않는다(= 소모되지 않는다).
    const surviving = killIntents.filter((k) => !protectedIds.has(k.playerId));
    const reflectedBy = new Set();   // 이번 밤에 반사를 발동한 사람
    const reflectKills = [];
    for (const k of surviving) {
      const target = this.players.get(k.playerId);
      if (!target || this.trueRole(target)?.id !== 'reflector') continue;
      if (target.rs.used.reflect) continue;
      reflectedBy.add(target.id);
      if (k.byId && k.byId !== target.id) {
        reflectKills.push({ playerId: k.byId, cause: 'REFLECT', byId: target.id });
      }
    }
    for (const id of reflectedBy) {
      const p = this.players.get(id);
      p.rs.used.reflect = true;
      this.tell(id, '누군가 당신을 죽이려 했지만 그대로 되돌려주었습니다. 이 능력은 한 번뿐입니다.');
    }
    for (const rk of reflectKills) {
      this.tell(rk.playerId, '공격이 그대로 되돌아왔습니다.');
    }

    // 사망 확정 (반사에 막힌 대상은 죽지 않는다)
    const intents = surviving
      .filter((k) => !reflectedBy.has(k.playerId))
      .concat(reflectKills, policeKills);
    const { deaths, blocked: survived } = this.applyDeaths(intents);

    this.gunshotThisNight = gunshot;
    this.pendingDeaths = deaths;
    this.blockedDeaths = survived;
    this.phase = PHASE.DAWN;
    this.deadline = null;

    const cues = [cue('night.close')];
    if (gunshot) cues.push(cue('sfx.gunshot'));
    cues.push(cue('day.begin'));
    if (this.publicReveals.length) cues.push(cue('day.reporter'));
    if (deaths.length) {
      cues.push(cue('day.death'));
      this.log(`${this.day}일차 아침 — 사망: ${deaths.map((d) => this.label(this.players.get(d.playerId))).join(', ')}`);
    } else {
      cues.push(cue('day.peace'));
      this.log(`${this.day}일차 아침 — 사망자 없음`);
    }
    for (const r of this.publicReveals) {
      this.log(`기자 특종 — ${this.label(this.players.get(r.playerId))} 의 직업은 「${r.roleName}」`);
    }
    // 포섭 사실은 공개 로그에 남기지 않고 당사자에게만 알린다
    const personalCues = converts
      .map((c) => c.targetId)
      .filter((id) => this.players.get(id)?.alive)
      .map((id) => ({ playerId: id, cue: cue('you.converted', null, 'personal') }));

    // 죽은 사람에게는 본인에게만 사망을 알린다.
    // 화면만 바뀌고 아무 말도 없으면 자기가 죽은 줄 모르고 계속 말을 한다.
    personalCues.push(...this.deathCues(deaths));

    return { cues, personal: personalCues, deaths };
  }

  /**
   * 탐정이 내놓을 가짜 후보 직업.
   * 편성표는 공개 정보이므로, 이번 판에 없는 직업을 후보로 주면
   * 둘 중 어느 쪽이 진짜인지 바로 들통난다. 반드시 판에 있는 직업만 쓴다.
   */
  decoyPoolFor(target) {
    const candidates = new Set(this.candidatePool());
    // 라인업이 공개된 판에서는 포섭 등으로 생겨난 직업도 후보에 넣는다
    if (!this.lineupHidden) {
      for (const p of this.players.values()) if (p.roleId) candidates.add(p.roleId);
    }
    const pool = [...candidates].filter((id) => id !== target.roleId).map(getRole).filter(Boolean);
    if (pool.length) return pool;
    return Object.values(ROLES).filter((r) => r.implemented && r.id !== target.roleId);
  }

  /** 방금 죽은 사람들에게 보낼 개인 나레이션 */
  deathCues(deaths) {
    return deaths.map((d) => {
      this.tell(d.playerId, '당신은 사망했습니다. 이제부터 발언할 수 없습니다.');
      return { playerId: d.playerId, cue: cue('you.dead', null, 'personal') };
    });
  }

  // ── 사망 처리 ─────────────────────────────────────────────────
  isVoteImmune(p) { return !!this.trueRole(p)?.voteImmune; }

  /** 자기보다 순번이 뒤인 삼둥이 형제가 살아 있으면 죽지 않는다 */
  tripletBlocked(p) {
    if (!p.tripletOrder) return false;
    return this.tripletsOf().some((s) => s.alive && s.id !== p.id && s.tripletOrder > p.tripletOrder);
  }

  /**
   * 사망 의도 목록을 실제 사망으로 바꾼다.
   * 투표 면역 / 삼둥이 순서 / 진돗개 연쇄를 여기서 한꺼번에 처리한다.
   */
  applyDeaths(intents) {
    const deaths = [];
    const blocked = [];
    const queue = [...intents];

    while (queue.length) {
      const d = queue.shift();
      const p = this.players.get(d.playerId);
      if (!p || !p.alive) continue;
      if (deaths.some((x) => x.playerId === p.id)) continue;

      if (d.cause === 'VOTE' && this.isVoteImmune(p)) {
        blocked.push({ playerId: p.id, reason: 'VOTE_IMMUNE' });
        continue;
      }
      if (this.tripletBlocked(p)) {
        blocked.push({ playerId: p.id, reason: 'TRIPLET_ORDER' });
        this.tell(p.id, '형제가 아직 살아 있어 당신은 죽지 않았습니다.');
        continue;
      }

      p.alive = false;
      deaths.push(d);

      // 진돗개 연쇄 — 주인이 죽으면 같이 죽는다
      for (const j of this.playerList) {
        if (j.alive && this.trueRole(j)?.id === 'jindo' && j.rs.jindoTargetId === p.id) {
          queue.push({ playerId: j.id, cause: 'JINDO_CHAIN', byId: p.id });
        }
      }
    }
    return { deaths, blocked };
  }

  // ── 낮 / 투표 ─────────────────────────────────────────────────
  beginDiscuss() {
    this.phase = PHASE.DISCUSS;
    // 자동 진행(테스트) 모드에서는 토론을 길게 끌 이유가 없다
    const secs = this.config.autoAdvance
      ? Math.min(this.config.discussSeconds, AUTO_HOLD_MS.DISCUSS / 1000)
      : this.config.discussSeconds;
    this.deadline = Date.now() + secs * 1000;
    return { cues: [cue('day.discuss')] };
  }

  beginVote() {
    this.phase = PHASE.VOTE;
    this.ballots.clear();
    this.forcedVoteTarget = null;
    this.pendingDeaths = [];
    this.blockedDeaths = [];
    this.deadline = Date.now() + this.config.voteSeconds * 1000;
    this.log(`${this.day}일차 투표 시작`);
    return { cues: [cue('vote.begin')] };
  }

  castVote(voterId, targetId) {
    if (this.phase !== PHASE.VOTE) return { ok: false, error: '지금은 투표 시간이 아닙니다.' };
    const voter = this.players.get(voterId);
    if (!voter || !voter.alive) return { ok: false, error: '투표할 수 없습니다.' };
    if (targetId !== 'ABSTAIN') {
      const t = this.players.get(targetId);
      if (!t || !t.alive) return { ok: false, error: '지목할 수 없는 대상입니다.' };
    }
    this.ballots.set(voterId, targetId);
    return { ok: true };
  }

  allVotesIn() {
    return this.alivePlayers.every((p) => this.ballots.has(p.id));
  }

  /**
   * 유효표만 집계한다.
   * 죽은 사람이 던진 표, 그리고 개표 전에 죽어버린 사람(저격 등)에게 간 표는 모두 무효다.
   */
  voteTally() {
    const tally = {};
    for (const [voterId, t] of this.ballots) {
      const voter = this.players.get(voterId);
      if (!voter?.alive || t === 'ABSTAIN') continue;
      if (!this.players.get(t)?.alive) continue;
      tally[t] = (tally[t] || 0) + 1;
    }
    return tally;
  }

  /** 저격수 — 투표 시간에 즉시 발동한다 */
  snipe(playerId, targetId, roleKey) {
    if (this.phase !== PHASE.VOTE) return { ok: false, error: '투표 시간에만 사용할 수 있습니다.' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: '방에 없는 플레이어입니다.' };
    const role = this.actingRole(p);
    if (!this.canActDay(p) || role.day.kind !== DAY_ABILITY.SNIPE) {
      return { ok: false, error: '지금 사용할 수 있는 능력이 없습니다.' };
    }
    const target = this.players.get(targetId);
    if (!target || !target.alive || target.id === p.id) return { ok: false, error: '지목할 수 없는 대상입니다.' };
    if (!snipeChoices(this.candidatePool()).some((c) => c.key === roleKey)) {
      return { ok: false, error: '이번 판에 없는 직업입니다.' };
    }

    p.rs.used.day = true;

    // 정신병자의 저격은 아무 일도 일어나지 않는다 (총소리만 난다)
    if (this.trueRole(p).id !== 'sniper') {
      this.log(`${this.day}일차 — 어디선가 총소리가 났지만 아무 일도 없었습니다.`);
      return { ok: true, cues: [cue('sfx.gunshot')], hit: false, deaths: [] };
    }

    const hit = snipeMatches(roleKey, target.roleId);
    const victim = hit ? target : p;
    const { deaths, blocked } = this.applyDeaths([
      { playerId: victim.id, cause: hit ? 'SNIPE' : 'SNIPE_BACKFIRE', byId: p.id },
    ]);

    this.log(
      hit
        ? `${this.day}일차 — 저격 성공. ${this.label(target)} 사망.`
        : `${this.day}일차 — 저격 실패. 저격수가 사망했습니다.`
    );
    this.pendingDeaths = [...this.pendingDeaths, ...deaths];
    this.blockedDeaths = [...this.blockedDeaths, ...blocked];
    return { ok: true, cues: [cue('sfx.gunshot')], hit, deaths };
  }

  /** 정치인 — 투표 결과를 강제 지정한다 */
  forceVote(playerId, targetId) {
    if (this.phase !== PHASE.VOTE) return { ok: false, error: '투표 시간에만 사용할 수 있습니다.' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: '방에 없는 플레이어입니다.' };
    const role = this.actingRole(p);
    if (!this.canActDay(p) || role.day.kind !== DAY_ABILITY.FORCE_VOTE) {
      return { ok: false, error: '지금 사용할 수 있는 능력이 없습니다.' };
    }
    const target = this.players.get(targetId);
    if (!target || !target.alive) return { ok: false, error: '지목할 수 없는 대상입니다.' };

    p.rs.used.day = true;
    // 정신병자의 능력은 효과가 없다
    if (this.trueRole(p).id === 'politician') {
      this.forcedVoteTarget = target.id;
      this.tell(p.id, `${this.label(target)} 을(를) 투표 결과로 지정했습니다.`);
    } else {
      this.tell(p.id, `${this.label(target)} 을(를) 투표 결과로 지정했습니다.`);
    }
    return { ok: true };
  }

  resolveVote() {
    const tally = this.voteTally();
    const aliveCount = this.alivePlayers.length;

    // 관종: 생존자 과반의 표를 받으면 그 즉시 단독 승리 (강제 지정은 표가 아니므로 제외)
    for (const p of this.alivePlayers) {
      if (this.trueRole(p)?.id !== 'attention') continue;
      const got = tally[p.id] || 0;
      if (got * 2 > aliveCount) {
        this.soloWins.push({ playerId: p.id, roleId: 'attention', reason: `관종이 과반(${got}표)의 지목을 받았습니다.` });
      }
    }

    let top = [];
    let max = 0;
    for (const [id, c] of Object.entries(tally)) {
      if (c > max) { max = c; top = [id]; }
      else if (c === max) top.push(id);
    }

    this.phase = PHASE.EXECUTION;
    this.deadline = null;
    this.pendingDeaths = [];
    this.blockedDeaths = [];

    // 관종이 이겼으면 처형 처리 없이 즉시 종료 판정으로 넘긴다
    if (this.soloWins.length) {
      this.log(`${this.day}일차 투표 — 관종의 단독 승리`);
      return { cues: [cue('vote.executed')], executed: null, tally, forced: false };
    }

    const forced = !!this.forcedVoteTarget;
    let designatedId = null;
    if (forced) {
      designatedId = this.forcedVoteTarget;
    } else if (max === 0) {
      this.log(`${this.day}일차 투표 — 전원 기권`);
      return { cues: [cue('vote.none')], executed: null, tally, forced };
    } else if (top.length > 1 && this.config.tieMeansNoExecution) {
      this.log(`${this.day}일차 투표 — 동표로 처형 없음`);
      return { cues: [cue('vote.tie')], executed: null, tally, forced };
    } else {
      designatedId = top[0];
    }

    const designated = this.players.get(designatedId);
    // 정치인이 지정한 사람이 개표 전에 죽었을 수도 있다
    if (!designated?.alive) {
      this.log(`${this.day}일차 투표 — 지목된 사람이 이미 사망하여 처형이 무산되었습니다.`);
      return { cues: [cue('vote.none')], executed: null, tally, forced };
    }

    // 부정선거자: 다수결로 지정되면 능력이 다시 충전된다
    if (this.trueRole(designated)?.night?.charged) {
      designated.rs.charges.kill = 1;
      this.tell(designated.id, '다수결로 지목되어 능력이 다시 충전되었습니다.');
    }

    const { deaths, blocked } = this.applyDeaths([{ playerId: designatedId, cause: 'VOTE' }]);
    this.pendingDeaths = deaths;
    this.blockedDeaths = blocked;

    const cues = [];
    if (forced) cues.push(cue('vote.forced'));

    if (deaths.length) {
      this.log(`${this.day}일차 투표 — ${this.label(designated)} 처형${forced ? ' (강제 지정)' : ` (${max}표)`}`);
      cues.push(cue('vote.executed'));
      this.creditClowns();
    } else {
      this.log(`${this.day}일차 투표 — ${this.label(designated)} 이(가) 처형을 견뎌냈습니다.`);
      cues.push(cue('vote.immune'));
    }

    return {
      cues,
      personal: this.deathCues(deaths),
      executed: deaths.length ? designatedId : null,
      tally,
      forced,
    };
  }

  /** 삐에로: 총성을 낸 다음 날 투표로 누군가 죽으면 1점 */
  creditClowns() {
    for (const p of this.alivePlayers) {
      if (this.trueRole(p)?.id !== 'clown' || !p.rs.clownArmed) continue;
      p.rs.clownCredits += 1;
      this.tell(p.id, `가짜 총성이 통했습니다. (${p.rs.clownCredits} / ${CLOWN_TARGET_CREDITS})`);
      if (p.rs.clownCredits >= CLOWN_TARGET_CREDITS) {
        this.soloWins.push({ playerId: p.id, roleId: 'clown', reason: '삐에로가 조건을 3번 채웠습니다.' });
      }
    }
  }

  // ── 승패 판정 ─────────────────────────────────────────────────
  /** 진돗개가 특정 진영의 승리를 막지 않는 경우(= 주인이 그 진영)를 걸러낸다 */
  winBlockers(team) {
    const strict = this.config.strictNeutralElimination;
    return this.alivePlayers.filter((p) => {
      const r = this.trueRole(p);
      if (r?.team !== TEAM.NEUTRAL) return false;
      if (!strict && !r.blocksTeamWin) return false;
      if (r.id === 'jindo') {
        const owner = this.players.get(p.rs.jindoTargetId);
        if (owner && this.teamOf(owner) === team) return false;
      }
      return true;
    });
  }

  /** 진돗개의 편승 승리 */
  jindoRidersFor({ team, playerIds = [] }) {
    const out = [];
    for (const p of this.playerList) {
      if (this.trueRole(p)?.id !== 'jindo') continue;
      const owner = this.players.get(p.rs.jindoTargetId);
      if (!owner) continue;
      const ownerWins = (team && this.teamOf(owner) === team) || playerIds.includes(owner.id);
      if (ownerWins) out.push({ kind: 'SOLO', playerId: p.id, label: `진돗개 (${p.nickname})` });
    }
    return out;
  }

  checkWin() {
    // 1. 개인 승리 조건이 먼저다 (즉발)
    if (this.soloWins.length) {
      const ids = this.soloWins.map((s) => s.playerId);
      const winners = this.soloWins.map((s) => ({
        kind: 'SOLO',
        playerId: s.playerId,
        label: `${getRole(s.roleId).name} (${this.players.get(s.playerId).nickname})`,
      }));
      const riders = this.jindoRidersFor({ playerIds: ids })
        .filter((r) => !winners.some((w) => w.playerId === r.playerId));
      return {
        winner: null,
        winners: [...winners, ...riders],
        reason: this.soloWins.map((s) => s.reason).join(' '),
      };
    }

    const alive = this.alivePlayers;
    const mafia = alive.filter((p) => this.teamOf(p) === TEAM.MAFIA);
    const citizens = alive.filter((p) => this.teamOf(p) === TEAM.CITIZEN);

    if (alive.length === 0) {
      return { winner: null, winners: [], reason: '생존자가 없습니다.' };
    }
    if (this.day > this.config.maxDays) {
      // 제한 일수를 넘겼다 = 마피아가 시간 안에 이기지 못했다 → 시민 진영 승리.
      // 단 살아 있는 시민이 하나도 없으면 시민의 승리라고 부를 수 없으므로 무승부로 둔다.
      if (this.config.maxDaysWinner === 'CITIZEN' && citizens.length > 0) {
        return {
          winner: TEAM.CITIZEN,
          winners: [{ kind: 'TEAM', team: TEAM.CITIZEN, label: '시민 진영' },
                    ...this.jindoRidersFor({ team: TEAM.CITIZEN })],
          reason: `${this.config.maxDays}일 안에 마피아가 이기지 못해 시민 진영이 승리했습니다.`,
        };
      }
      return { winner: null, winners: [], reason: `${this.config.maxDays}일이 지나 무승부로 끝났습니다.` };
    }

    // 2. 시민 승리 — 마피아 전멸 + 승리를 막는 중립 전멸
    if (mafia.length === 0 && this.winBlockers(TEAM.CITIZEN).length === 0) {
      return {
        winner: TEAM.CITIZEN,
        winners: [{ kind: 'TEAM', team: TEAM.CITIZEN, label: '시민 진영' },
                  ...this.jindoRidersFor({ team: TEAM.CITIZEN })],
        reason: '마피아와 중립이 모두 제거되었습니다.',
      };
    }

    // 3. 마피아 승리 — 승리를 막는 중립이 없고, 시민 전멸이거나 과반
    if (mafia.length > 0 && this.winBlockers(TEAM.MAFIA).length === 0) {
      if (citizens.length === 0) {
        return {
          winner: TEAM.MAFIA,
          winners: [{ kind: 'TEAM', team: TEAM.MAFIA, label: '마피아 진영' },
                    ...this.jindoRidersFor({ team: TEAM.MAFIA })],
          reason: '시민과 중립이 모두 제거되었습니다.',
        };
      }
      if (mafia.length * 2 >= alive.length) {
        return {
          winner: TEAM.MAFIA,
          winners: [{ kind: 'TEAM', team: TEAM.MAFIA, label: '마피아 진영' },
                    ...this.jindoRidersFor({ team: TEAM.MAFIA })],
          reason: '마피아가 과반을 차지했습니다.',
        };
      }
    }

    return null;
  }

  endGame(win) {
    this.phase = PHASE.END;
    this.deadline = null;
    const winnerIds = new Set(win.winners.filter((w) => w.kind === 'SOLO').map((w) => w.playerId));

    this.result = {
      winner: win.winner,
      winners: win.winners,
      reason: win.reason,
      roles: this.playerList.map((p) => ({
        id: p.id,
        nickname: p.nickname,
        seat: p.seat,
        roleId: p.roleId,
        roleName: this.trueRole(p)?.name ?? '?',
        fakeRoleName: p.fakeRoleId ? getRole(p.fakeRoleId).name : null,
        tripletOrder: p.tripletOrder,
        team: this.teamOf(p),
        alive: p.alive,
        won: winnerIds.has(p.id) || (win.winner && this.teamOf(p) === win.winner),
      })),
    };
    this.log(`게임 종료 — ${win.reason}`);
    const key =
      win.winner === TEAM.MAFIA ? 'game.end.mafia'
      : win.winner === TEAM.CITIZEN ? 'game.end.citizen'
      : 'game.end.solo';
    return { cues: [cue(key)] };
  }

  nextDay() { this.day += 1; }

  resetToLobby() {
    this.phase = PHASE.LOBBY;
    this.day = 0;
    this.result = null;
    this.activeRoles = [];
    this.publicLog = [];
    this.nightActions.clear();
    this.ballots.clear();
    this.pendingDeaths = [];
    this.blockedDeaths = [];
    this.publicReveals = [];
    this.revealedIds = new Set();
    this.forcedVoteTarget = null;
    this.soloWins = [];
    this.deadline = null;
    for (const p of this.players.values()) {
      p.alive = true;
      p.roleId = null;
      p.fakeRoleId = null;
      p.tripletOrder = null;
      p.seat = null;
      p.info = [];
      p.rs = this.freshRoleState();
    }
  }

  // ── 로그 ──────────────────────────────────────────────────────
  label(p) {
    if (!p) return '?';
    return p.seat != null ? `${p.seat}번 ${p.nickname}` : p.nickname;
  }

  log(text) {
    this.publicLog.push({ day: this.day, phase: this.phase, text, at: Date.now() });
    if (this.publicLog.length > 200) this.publicLog.shift();
  }

  tell(playerId, text) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.info.push({ day: this.day, text, at: Date.now() });
  }

  // ── 개인화 상태 뷰 ────────────────────────────────────────────
  /** viewer 가 p 에 대해 알아도 되는 직업명 (모르면 null) */
  revealedRoleFor(viewer, p) {
    if (this.phase === PHASE.END) return this.trueRole(p)?.name ?? null;
    if (!viewer) return null;

    if (p.id === viewer.id) {
      return p.rs.lunaticRevealed
        ? this.trueRole(p)?.name ?? null
        : this.actingRole(p)?.name ?? null;
    }
    if (this.phase === PHASE.LOBBY || this.phase === PHASE.SEATING) return null;

    // 기자 특종으로 공개된 사람
    if (this.revealedIds.has(p.id)) return this.trueRole(p)?.name ?? null;

    // 마피아 진영은 서로를 안다
    if (this.teamOf(viewer) === TEAM.MAFIA && this.teamOf(p) === TEAM.MAFIA) {
      return this.trueRole(p)?.name ?? null;
    }
    // 삼둥이 첫째·둘째는 서로를 알아본다 (순번과 셋째는 모른다)
    if (viewer.tripletOrder && viewer.tripletOrder < 3 && p.tripletOrder && p.tripletOrder < 3) {
      return '삼둥이';
    }
    // 진돗개는 주인의 직업을 안다
    if (this.trueRole(viewer)?.id === 'jindo' && viewer.rs.jindoTargetId === p.id) {
      return this.trueRole(p)?.name ?? null;
    }
    return null;
  }

  viewFor(playerId) {
    const me = this.players.get(playerId);
    const role = this.actingRole(me);
    const trueRoleOfMe = this.trueRole(me);
    const showTrue = me?.rs.lunaticRevealed;
    const shownRole = showTrue ? trueRoleOfMe : role;

    const players = this.playerList
      .sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99))
      .map((p) => ({
        id: p.id,
        nickname: p.nickname,
        seat: p.seat,
        alive: p.alive,
        connected: p.connected,
        isHost: p.id === this.hostId,
        isYou: p.id === playerId,
        isBot: !!p.isBot,
        revealedRole: this.revealedRoleFor(me, p),
      }));

    const nightSpec = role?.night ?? null;
    const canAct = this.phase === PHASE.NIGHT && this.canActNight(me) && !this.nightActions.has(playerId);
    const daySpec = role?.day ?? null;
    const canDay = this.phase === PHASE.VOTE && this.canActDay(me);
    const startSpec = role?.start ?? null;
    const needStart = this.phase === PHASE.ROLE_REVEAL && this.needsStartAction(me);

    return {
      room: {
        code: this.code,
        phase: this.phase,
        day: this.day,
        hostId: this.hostId,
        deadline: this.deadline,
        playerCount: this.players.size,
        botCount: this.bots.length,
        // 라인업을 감추는 판에서는 직업 목록 자체를 내려보내지 않는다.
        // 개발자 도구로 상태를 들여다봐도 알 수 없어야 한다.
        config: this.lineupHidden ? { ...this.config, roles: [], pinnedRoles: {} } : this.config,
        lineupHidden: this.lineupHidden,
        qr: this.phase === PHASE.LOBBY ? this.qrDataUrl : null,
      },
      you: me
        ? {
            id: me.id,
            nickname: me.nickname,
            seat: me.seat,
            alive: me.alive,
            isHost: me.id === this.hostId,
            role: shownRole
              ? { id: shownRole.id, name: shownRole.name, team: shownRole.team, desc: shownRole.desc }
              : null,
            tripletOrder: me.tripletOrder,
            clownCredits: me.rs.clownCredits,
            charges: me.rs.charges,

            canAct,
            actionPrompt: nightSpec?.prompt ?? null,
            actionTargets: canAct ? this.legalTargets(me, nightSpec) : [],
            actionPair: !!nightSpec?.pair,
            actionModes: nightSpec?.modes ?? null,
            convertUsed: !!me.rs.used.convert,
            actionNoTarget: nightSpec?.targets === TARGET.NONE,
            submittedAction: this.nightActions.has(playerId),

            dayAbility: canDay ? { kind: daySpec.kind, prompt: daySpec.prompt } : null,
            snipeChoices: canDay && daySpec.kind === DAY_ABILITY.SNIPE ? snipeChoices(this.candidatePool()) : null,

            startAction: needStart ? { kind: startSpec.kind, prompt: startSpec.prompt } : null,
            startTargets: needStart ? this.alivePlayers.filter((p) => p.id !== me.id).map((p) => p.id) : [],

            // 밤에 마피아끼리는 서로의 지목을 실시간으로 본다.
            // 말을 하지 않고도 한 명으로 몰아줄 수 있게 하기 위한 장치다.
            mafiaPicks:
              this.phase === PHASE.NIGHT && this.config.mafiaSharedKill && this.teamOf(me) === TEAM.MAFIA
                ? [...this.nightActions.entries()]
                    .filter(([id]) => this.teamOf(this.players.get(id)) === TEAM.MAFIA)
                    .map(([id, a]) => ({
                      byId: id,
                      targetId: a.passed ? null : a.targetId,
                      mode: a.mode ?? null,
                    }))
                : [],
            // 확실히 같은 편이라고 알고 있는 사람들 (마피아 진영만 서로를 안다)
            allies:
              me.alive && this.teamOf(me) === TEAM.MAFIA
                ? this.playerList.filter((p) => p.id !== me.id && this.teamOf(p) === TEAM.MAFIA).map((p) => p.id)
                : [],
            votedFor: this.ballots.get(playerId) ?? null,
            info: me.info,
          }
        : null,
      players,
      seats: { total: this.seatCount, taken: this.seatMap() },
      vote:
        this.phase === PHASE.VOTE || this.phase === PHASE.EXECUTION
          ? (() => {
              // 개표가 끝났으면 무조건 공개, 투표 중이면 공개 투표일 때만 보여준다
              const open = this.phase === PHASE.EXECUTION || this.config.openVoting;
              return {
                open,
                tally: open ? this.voteTally() : null,
                // 누가 누구를 찍었는지 (공개 투표일 때만)
                ballots: open
                  ? [...this.ballots.entries()]
                      .filter(([vid]) => this.players.get(vid)?.alive)
                      .map(([voterId, targetId]) => ({ voterId, targetId }))
                  : [],
                abstain: open
                  ? [...this.ballots.entries()].filter(
                      ([vid, t]) => t === 'ABSTAIN' && this.players.get(vid)?.alive
                    ).length
                  : 0,
                votedCount: this.ballots.size,
                totalVoters: this.alivePlayers.length,
              };
            })()
          : null,
      deaths: this.pendingDeaths.map((d) => ({
        ...d,
        nickname: this.players.get(d.playerId)?.nickname ?? '?',
        seat: this.players.get(d.playerId)?.seat ?? null,
      })),
      survivors: this.blockedDeaths.map((b) => ({
        ...b,
        nickname: this.players.get(b.playerId)?.nickname ?? '?',
        seat: this.players.get(b.playerId)?.seat ?? null,
      })),
      reveals: this.publicReveals.map((r) => ({
        ...r,
        nickname: this.players.get(r.playerId)?.nickname ?? '?',
        seat: this.players.get(r.playerId)?.seat ?? null,
      })),
      nightProgress:
        this.phase === PHASE.NIGHT
          ? {
              done: this.nightActions.size,
              total: this.alivePlayers.filter((p) => this.canActNight(p)).length,
            }
          : null,
      startPending: this.phase === PHASE.ROLE_REVEAL ? this.startActionsPending().length : 0,
      publicLog: this.publicLog.slice(-30),
      result: this.result,
      catalog: this.phase === PHASE.LOBBY ? roleCatalog() : null,
      recommend: this.phase === PHASE.LOBBY ? recommendCounts(this.players.size) : null,
      // 이번 판에 어떤 직업이 들어 있는지 (누가 뭔지는 알려주지 않는다).
      // hiddenLineup 이 켜져 있으면 게임이 끝날 때까지 아무에게도 보여주지 않는다.
      lineup: (() => {
        if (!this.config.showRoleList || this.lineupHidden) return null;
        const src = this.composition;
        if (!src.length) return null;
        return [...new Set(src)].map((id) => {
          const r = getRole(id);
          return {
            id,
            name: r?.name ?? id,
            team: r?.team ?? null,
            desc: r?.desc ?? '',
            count: src.filter((x) => x === id).length,
          };
        });
      })(),
    };
  }
}
