/**
 * 특수 직업 시나리오 테스트.
 * 서버를 MAFIA_TEST_HOOKS=1 로 띄워야 직업을 편성표 순서대로 고정할 수 있다.
 *
 *   MAFIA_TEST_HOOKS=1 npm run dev   (다른 터미널)
 *   node test/roles.mjs
 *
 * 플레이어 i (0-based) 는 언제나 자리 i+1 번, 직업 roles[i] 를 받는다.
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let scenario = '';
const check = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
};
const head = (name) => { scenario = name; console.log(`\n▸ ${name}`); };

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    const c = {
      socket: s, state: null, cues: [], id: null,
      emit: (ev, data) => new Promise((res) => s.emit(ev, data, (r) => res(r || { ok: false }))),
      waitPhase: (phase, timeout = 15000) =>
        new Promise((res, rej) => {
          if (c.state?.room.phase === phase) return res(c.state);
          const t = setTimeout(() => rej(new Error(`${scenario}: ${phase} 대기 초과 (현재 ${c.state?.room.phase})`)), timeout);
          const h = (st) => { if (st.room.phase === phase) { clearTimeout(t); s.off('state', h); res(st); } };
          s.on('state', h);
        }),
    };
    s.on('state', (st) => { c.state = st; });
    s.on('cue', ({ cues }) => c.cues.push(...cues.map((x) => x.key)));
    s.on('connect', () => resolve(c));
  });
}

/** 지정한 편성으로 방을 만들고 게임 시작 직전(직업 확인 단계)까지 진행한다 */
async function setup(roles, extraConfig = {}) {
  const n = roles.length;
  const c = [];
  const host = await connect();
  const created = await host.emit('room:create', { nickname: 'P1' });
  if (!created.ok) throw new Error(created.error);
  host.id = created.playerId;
  c.push(host);

  for (let i = 1; i < n; i++) {
    const cl = await connect();
    const r = await cl.emit('room:join', { roomCode: created.roomCode, nickname: `P${i + 1}` });
    if (!r.ok) throw new Error(r.error);
    cl.id = r.playerId;
    c.push(cl);
  }
  await sleep(200);

  const cfg = await host.emit('host:config', {
    patch: {
      // 시나리오 테스트는 직업을 정확히 지정해야 하므로 수동 편성으로 고정한다
      compositionMode: 'manual',
      roles, deterministicRoles: true,
      nightSeconds: 600, discussSeconds: 600, voteSeconds: 600,
      ...extraConfig,
    },
  });
  if (!cfg.ok) throw new Error(cfg.error);
  if (!cfg.validation.ok) throw new Error(`편성 오류: ${cfg.validation.errors.join(' / ')}`);

  await host.emit('host:seating', {});
  await sleep(150);
  for (let i = 0; i < n; i++) {
    const r = await c[i].emit('seat:claim', { seat: i + 1 });
    if (!r.ok) throw new Error(`자리 ${i + 1}: ${r.error}`);
  }
  const st = await host.emit('host:start', {});
  if (!st.ok) throw new Error(st.error);
  await sleep(250);

  const g = {
    code: created.roomCode,
    c,
    id: (i) => c[i].id,
    you: (i) => c[i].state.you,
    seeRole: (viewer, target) =>
      c[viewer].state.players.find((p) => p.id === c[target].id)?.revealedRole ?? null,
    info: (i) => (c[i].state.you.info || []).map((x) => x.text).join(' | '),
    alive: (i) => c[i].state.players.find((p) => p.id === c[i].id).alive,
    next: async () => { await host.emit('host:next', {}); await sleep(400); },
    toNight: async () => { await host.emit('host:next', {}); await host.waitPhase('NIGHT'); await sleep(250); },
    act: (i, payload) => c[i].emit('night:action', payload),
    pass: (i) => c[i].emit('night:action', { targetId: null }),
    /** 살아있는 사람 전원이 targetIdx 에게 투표 */
    voteAll: async (targetIdx) => {
      for (let i = 0; i < n; i++) {
        if (!c[i].state.you.alive) continue;
        await c[i].emit('vote:cast', { targetId: c[targetIdx].id });
      }
      await sleep(500);
    },
    vote: (i, targetIdx) => c[i].emit('vote:cast', { targetId: c[targetIdx].id }),
    /** 아직 밤 행동을 안 한 사람들을 전부 「사용 안 함」으로 넘긴다 */
    passRest: async () => {
      for (let i = 0; i < n; i++) {
        const y = c[i].state.you;
        if (y.canAct && !y.submittedAction) await c[i].emit('night:action', { targetId: null });
      }
      await sleep(300);
    },
    abstainAll: async () => {
      for (let i = 0; i < n; i++) {
        if (!c[i].state.you.alive) continue;
        await c[i].emit('vote:cast', { targetId: 'ABSTAIN' });
      }
      await sleep(500);
    },
    /** 밤 전원 통과 → 아침까지 */
    dawn: async () => { await host.waitPhase('DAWN'); await sleep(300); },
    /** 아침 → 토론 → 투표 */
    toVote: async () => {
      await host.emit('host:next', {}); await sleep(300);
      await host.emit('host:next', {}); await host.waitPhase('VOTE'); await sleep(250);
    },
    execution: async () => { await host.waitPhase('EXECUTION'); await sleep(300); },
    end: async () => { await host.waitPhase('END'); await sleep(250); },
    close: () => { for (const cl of c) cl.socket.close(); },
  };
  return g;
}

// ═══════════════════════════════════════════════════════════════
const run = async () => {
  console.log(`\n특수 직업 시나리오 테스트 → ${URL}`);

  // ── 직업 체험 (찜해둔 직업 배정) ─────────────────────────────
  {
    head('직업 체험 — 찜한 직업을 그대로 받는다');
    const g = await setup(['mafia', 'citizen', 'citizen', 'citizen', 'citizen']);
    // 게임이 이미 시작된 뒤라 대기실로 돌린 다음 찜한다
    await g.c[0].emit('host:reset', {});
    await sleep(300);
    const pin = await g.c[2].emit('role:pin', { roleId: 'detective' });
    await sleep(300); // 편성표 갱신 상태가 도착할 때까지
    check('찜 성공', pin.ok, pin.error || '');
    check('편성표에 자동으로 들어감',
      g.c[0].state.room.config.roles.includes('detective'),
      g.c[0].state.room.config.roles.join(','));
    check('편성 검증 통과', pin.validation.ok, (pin.validation.errors || []).join(' / '));

    await g.c[0].emit('host:seating', {});
    await sleep(200);
    for (let i = 0; i < 5; i++) await g.c[i].emit('seat:claim', { seat: i + 1 });
    const st = await g.c[0].emit('host:start', {});
    await sleep(300);
    check('게임 시작', st.ok, st.error || '');
    check('찜한 사람이 그 직업을 받음', g.you(2).role.id === 'detective', g.you(2).role.name);
    g.close();
  }

  {
    head('직업 체험 — 삼둥이를 찜한 뒤 자동 편성해도 세트가 유지된다');
    const g = await setup(Array.from({ length: 8 }, (_, i) => (i === 0 ? 'mafia' : 'citizen')));
    await g.c[0].emit('host:reset', {});
    await sleep(300);
    const pin = await g.c[3].emit('role:pin', { roleId: 'triplet_neutral' });
    await sleep(300);
    check('삼둥이 찜 성공', pin.ok, pin.error || '');
    const afterPin = g.c[0].state.room.config.roles;
    check('찜 직후 삼둥이 3종이 모두 들어감',
      ['triplet_mafia', 'triplet_citizen', 'triplet_neutral'].every((r) => afterPin.includes(r)),
      afterPin.join(','));

    // 자동 편성을 다시 눌러도 세트가 깨지면 안 된다
    const auto = await g.c[0].emit('host:autoRoles', {});
    await sleep(300);
    const afterAuto = g.c[0].state.room.config.roles;
    check('자동 편성 후에도 삼둥이 3종 유지',
      ['triplet_mafia', 'triplet_citizen', 'triplet_neutral'].every((r) => afterAuto.includes(r)),
      afterAuto.join(','));
    check('자동 편성 후에도 편성이 유효함', auto.validation.ok,
      (auto.validation.errors || []).join(' / '));
    g.close();
  }

  {
    head('자동 편성 — 중립이 마피아보다 많아지지 않는다');
    for (const n of [6, 8, 10, 12]) {
      const g = await setup(Array.from({ length: n }, (_, i) => (i === 0 ? 'mafia' : 'citizen')));
      await g.c[0].emit('host:reset', {});
      await sleep(250);
      await g.c[0].emit('host:autoRoles', {});
      await sleep(300);
      const roles = g.c[0].state.room.config.roles;
      const teamOf = (id) => ({
        sniper: 'M', rigger: 'M', chairman: 'M', independent_mafia: 'M', triplet_mafia: 'M', mafia: 'M',
        jindo: 'N', clown: 'N', attention: 'N', serial_killer: 'N', triplet_neutral: 'N',
      }[id] || 'C');
      const m = roles.filter((r) => teamOf(r) === 'M').length;
      const k = roles.filter((r) => teamOf(r) === 'N').length;
      check(`${n}인 — 중립(${k}) ≤ 마피아(${m})`, k <= m, roles.join(','));
      g.close();
    }
  }

  {
    head('직업 체험 — 인원이 모자라는 직업은 거부');
    const g = await setup(['mafia', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.c[0].emit('host:reset', {});
    await sleep(300);
    const pin = await g.c[1].emit('role:pin', { roleId: 'triplet_mafia' }); // 8인 이상 필요
    check('8인 미만에서는 삼둥이 거부', !pin.ok, pin.error || '');
    g.close();
  }

  // ── 인원수 편성 + 직업 비공개 ───────────────────────────────
  {
    head('인원수 편성 — 진영 수만 정하면 직업은 시작할 때 무작위로 뽑힌다');
    const g = await setup(Array.from({ length: 8 }, (_, i) => (i === 0 ? 'mafia' : 'citizen')));
    await g.c[0].emit('host:reset', {});
    await sleep(300);
    const cfg = await g.c[0].emit('host:config', {
      patch: {
        compositionMode: 'counts',
        teamCounts: { mafia: 2, citizen: 5, neutral: 1 },
        deterministicRoles: false,
      },
    });
    await sleep(300);
    check('인원수 편성이 유효함', cfg.validation.ok, (cfg.validation.errors || []).join(' / '));
    check('시작 전에는 직업 목록이 비어 있음',
      (g.c[0].state.room.config.roles || []).length === 0,
      JSON.stringify(g.c[0].state.room.config.roles));

    await g.c[0].emit('host:seating', {});
    await sleep(250);
    for (let i = 0; i < 8; i++) await g.c[i].emit('seat:claim', { seat: i + 1 });
    const st = await g.c[0].emit('host:start', {});
    await sleep(400);
    check('게임 시작', st.ok, st.error || '');

    const teamOf = (i) => g.you(i).role.team;
    const counts = { MAFIA: 0, CITIZEN: 0, NEUTRAL: 0 };
    for (let i = 0; i < 8; i++) counts[teamOf(i)]++;
    check('지정한 진영 인원 그대로 배정',
      counts.MAFIA === 2 && counts.CITIZEN === 5 && counts.NEUTRAL === 1,
      JSON.stringify(counts));
    check('평마피아·평시민은 뽑히지 않음',
      !Array.from({ length: 8 }, (_, i) => g.you(i).role.id).some((r) => r === 'mafia' || r === 'citizen'),
      Array.from({ length: 8 }, (_, i) => g.you(i).role.id).join(','));
    check('부정선거자는 편성에서 제외됨',
      !Array.from({ length: 8 }, (_, i) => g.you(i).role.id).includes('rigger'));
    g.close();
  }

  {
    head('직업 비공개 — 게임 중 라인업이 아무에게도 노출되지 않는다');
    const g = await setup(Array.from({ length: 8 }, (_, i) => (i === 0 ? 'mafia' : 'citizen')));
    await g.c[0].emit('host:reset', {});
    await sleep(300);
    await g.c[0].emit('host:config', {
      patch: {
        compositionMode: 'counts',
        teamCounts: { mafia: 2, citizen: 5, neutral: 1 },
        hiddenLineup: true,
        deterministicRoles: false,
      },
    });
    await sleep(300);
    await g.c[0].emit('host:seating', {});
    await sleep(250);
    for (let i = 0; i < 8; i++) await g.c[i].emit('seat:claim', { seat: i + 1 });
    await g.c[0].emit('host:start', {});
    await sleep(400);

    check('라인업이 내려오지 않음', g.c[3].state.lineup === null, JSON.stringify(g.c[3].state.lineup));
    check('상태에 직업 목록이 비어 있음',
      (g.c[3].state.room.config.roles || []).length === 0,
      JSON.stringify(g.c[3].state.room.config.roles));
    check('비공개 표시가 내려옴', g.c[3].state.room.lineupHidden === true);
    check('본인 직업은 정상적으로 보임', !!g.you(3).role?.name, g.you(3).role?.name);

    // 게임이 끝나면 전원 공개
    await g.c[0].emit('host:next', {});
    await sleep(500);
    check('게임 중에는 여전히 비공개', g.c[3].state.lineup === null);
    g.close();
  }

  // ── 마피아 공유 킬 ───────────────────────────────────────────
  {
    head('마피아 공유 킬 — 지목이 갈려도 한 명만 죽는다');
    // 자리 1번과 3번이 마피아. 1번의 양옆은 8·2번, 3번의 양옆은 2·4번.
    const g = await setup([
      'mafia', 'citizen', 'mafia', 'citizen',
      'citizen', 'citizen', 'citizen', 'citizen',
    ]);
    await g.toNight();
    check('동료가 마피아로 보임', g.seeRole(0, 2) === '마피아', String(g.seeRole(0, 2)));
    await g.act(0, { targetId: g.id(7) });   // 1번 → 8번
    await sleep(250);
    check('동료의 지목이 실시간으로 보임',
      (g.you(2).mafiaPicks || []).some((p) => p.byId === g.id(0) && p.targetId === g.id(7)),
      JSON.stringify(g.you(2).mafiaPicks));
    await g.act(2, { targetId: g.id(3) });   // 3번 → 4번 (서로 다른 대상)
    await g.dawn();
    const deaths = g.c[4].state.deaths;
    check('사망자는 한 명뿐', deaths.length === 1,
      JSON.stringify(deaths.map((d) => `${d.seat}번`)));
    check('둘 중 한 명이 대상이 됨',
      [g.id(7), g.id(3)].includes(deaths[0]?.playerId));
    check('지목이 갈린 사실을 마피아에게 알림',
      g.info(0).includes('갈려') && g.info(2).includes('갈려'), g.info(0));
    g.close();
  }

  {
    head('마피아 공유 킬 — 둘이 같은 사람을 지목');
    const g = await setup([
      'mafia', 'citizen', 'mafia', 'citizen',
      'citizen', 'citizen', 'citizen', 'citizen',
    ]);
    await g.toNight();
    await g.act(0, { targetId: g.id(1) });   // 둘 다 2번을 지목 (양옆이 겹치는 유일한 자리)
    await g.act(2, { targetId: g.id(1) });
    await g.dawn();
    const deaths = g.c[4].state.deaths;
    check('합의한 대상이 죽음',
      deaths.length === 1 && deaths[0].playerId === g.id(1),
      JSON.stringify(deaths.map((d) => `${d.seat}번`)));
    check('합의했으면 갈렸다는 안내는 없음', !g.info(0).includes('갈려'), g.info(0));
    g.close();
  }

  // ── 마피아는 동료를 지목할 수 없다 ──────────────────────────
  {
    head('마피아는 동료를 죽이거나 포섭할 수 없다');
    // 자리 1·2번이 마피아라 서로 옆자리다
    const g = await setup(['mafia', 'mafia', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    const t0 = g.you(0).actionTargets;
    const t1 = g.you(1).actionTargets;
    check('1번 마피아 대상에 동료(2번)가 없음', !t0.includes(g.id(1)),
      t0.map((id) => g.c.findIndex((x) => x.id === id) + 1).join(','));
    check('2번 마피아 대상에 동료(1번)가 없음', !t1.includes(g.id(0)));
    check('바깥쪽 이웃은 그대로 지목 가능', t0.includes(g.id(5)) && t1.includes(g.id(2)));
    const bad = await g.act(0, { targetId: g.id(1) });
    check('동료 지목 요청은 서버가 거부', !bad.ok, bad.error || '');
    g.close();
  }

  // ── 정신병자의 위장 직업 범위 ───────────────────────────────
  {
    head('정신병자 — 편성표에 있는 시민 직업으로만 위장');
    const g = await setup(['mafia', 'lunatic', 'police', 'guardian', 'citizen']);
    const shown = g.you(1).role;
    const inPlayCitizens = ['경찰', '수호자', '시민'];
    check('본인은 정신병자인 줄 모름', shown.name !== '정신병자', shown.name);
    check('위장 직업이 편성표 안에 있음', inPlayCitizens.includes(shown.name), shown.name);
    check('위장 직업은 시민 진영', shown.team === 'CITIZEN');
    g.close();
  }

  // ── 무소속당: 투표로 죽지 않는다 ────────────────────────────
  {
    head('무소속당 (시민) — 투표 면역');
    const g = await setup(['mafia', 'independent_citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    await g.pass(0);
    await g.dawn();
    await g.toVote();
    await g.voteAll(1);
    await g.execution();
    check('투표로 죽지 않음', g.alive(1));
    check('처형 무효 사유가 전달됨',
      g.c[0].state.survivors.some((s) => s.reason === 'VOTE_IMMUNE'),
      JSON.stringify(g.c[0].state.survivors));
    g.close();
  }

  // ── 부정선거자: 1회 충전 + 다수결 지정 시 재충전 ────────────
  {
    head('부정선거자 — 능력 충전과 재충전');
    const g = await setup(['rigger', 'citizen', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    check('시작 시 충전 1회', g.you(0).charges.kill === 1, `charges=${JSON.stringify(g.you(0).charges)}`);
    const adj = g.you(0).actionTargets;
    await g.act(0, { targetId: adj[0] });
    await g.dawn();
    check('충전 소진', g.you(0).charges.kill === 0);
    await g.toVote();
    await g.voteAll(0);
    await g.execution();
    check('투표로 죽지 않음', g.alive(0));
    check('다수결 지정으로 재충전', g.you(0).charges.kill === 1);
    check('재충전 안내 수신', g.info(0).includes('다시 충전'), g.info(0));
    g.close();
  }

  // ── 회장: 포섭 ───────────────────────────────────────────────
  {
    head('회장 — 포섭');
    const g = await setup(['chairman', 'citizen', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    check('포섭 모드 제공', (g.you(0).actionModes || []).includes('CONVERT'));
    await g.act(0, { targetId: g.id(1), mode: 'CONVERT' });
    await g.dawn();
    check('포섭 대상은 죽지 않음', g.alive(1));
    check('포섭 대상의 직업이 바뀜', g.you(1).role.name === '포섭된 마피아', g.you(1).role.name);
    check('포섭 대상이 마피아 진영', g.you(1).role.team === 'MAFIA');
    check('포섭 대상에게 통보', g.info(1).includes('포섭'), g.info(1));
    check('회장이 포섭 대상을 마피아로 인식', g.seeRole(0, 1) === '포섭된 마피아', String(g.seeRole(0, 1)));
    check('포섭 대상도 회장을 마피아로 인식', g.seeRole(1, 0) === '회장', String(g.seeRole(1, 0)));
    check('시민은 포섭 사실을 모름', g.seeRole(2, 1) === null);
    g.close();
  }

  // ── 저격수: 명중 ─────────────────────────────────────────────
  {
    head('저격수 — 명중');
    const g = await setup(['sniper', 'police', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    await g.pass(0); await g.pass(1);
    await g.dawn();
    await g.toVote();
    check('저격 능력 제공', g.you(0).dayAbility?.kind === 'SNIPE');
    check('후보 직업은 편성표 기준',
      (g.you(0).snipeChoices || []).map((x) => x.key).sort().join() === ['citizen', 'police', 'sniper'].sort().join(),
      JSON.stringify((g.you(0).snipeChoices || []).map((x) => x.key)));
    const r = await g.c[0].emit('day:snipe', { targetId: g.id(1), roleKey: 'police' });
    await sleep(400);
    check('명중 판정', r.ok && r.hit === true, r.error || '');
    check('대상 사망', !g.alive(1));
    check('저격수 생존', g.alive(0));
    check('총소리 전체 전달', g.c[3].cues.includes('sfx.gunshot'));
    check('능력 1회 소진', !g.you(0).dayAbility);
    g.close();
  }

  // ── 저격수: 빗나감 ───────────────────────────────────────────
  {
    head('저격수 — 빗나감');
    const g = await setup(['sniper', 'police', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    await g.pass(0); await g.pass(1);
    await g.dawn();
    await g.toVote();
    const r = await g.c[0].emit('day:snipe', { targetId: g.id(1), roleKey: 'citizen' });
    await sleep(400);
    check('빗나감 판정', r.ok && r.hit === false, r.error || '');
    check('저격수 사망', !g.alive(0));
    check('대상 생존', g.alive(1));
    g.close();
  }

  // ── 개표 전에 죽은 사람에게 간 표는 무효 ────────────────────
  {
    head('저격 이후 개표 — 사망자에게 간 표는 무효');
    const g = await setup(['sniper', 'police', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    await g.pass(0); await g.pass(1);
    await g.dawn();
    await g.toVote();
    // 네 명이 경찰(자리2)에게 표를 몰아준 뒤, 저격수가 그 경찰을 쏜다
    for (const i of [2, 3, 4, 5]) await g.vote(i, 1);
    await sleep(200);
    const r = await g.c[0].emit('day:snipe', { targetId: g.id(1), roleKey: 'police' });
    await sleep(400);
    check('저격 명중', r.ok && r.hit === true, r.error || '');
    await g.vote(0, 2);
    await g.execution();
    const tally = g.c[0].state.vote.tally;
    check('사망자에게 간 표가 집계에서 빠짐', !(g.id(1) in tally), JSON.stringify(tally));
    check('남은 유효표로 처형 결정', !g.alive(2), `idx2 alive=${g.alive(2)}`);
    check('「견뎌냈다」로 잘못 표시되지 않음',
      !g.c[0].state.publicLog.some((l) => l.text.includes('견뎌냈')),
      g.c[0].state.publicLog.slice(-2).map((l) => l.text).join(' / '));
    g.close();
  }

  // ── 정치인: 투표 결과 강제 지정 ──────────────────────────────
  {
    head('정치인 — 투표 결과 강제 지정');
    const g = await setup(['politician', 'mafia', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    await g.pass(1);
    await g.dawn();
    await g.toVote();
    check('강제 지정 능력 제공', g.you(0).dayAbility?.kind === 'FORCE_VOTE');
    const f = await g.c[0].emit('day:force', { targetId: g.id(3) });
    check('강제 지정 성공', f.ok, f.error || '');
    // 표는 전부 2번(index 2)에게 몰아준다
    for (let i = 0; i < 6; i++) await g.vote(i, 2);
    await g.execution();
    check('득표 1위가 아니라 강제 지정자가 처형됨', !g.alive(3) && g.alive(2),
      `idx2 alive=${g.alive(2)} / idx3 alive=${g.alive(3)}`);
    check('능력 1회 소진', !g.you(0).dayAbility);
    g.close();
  }

  // ── 기자: 정체 공개 ──────────────────────────────────────────
  {
    head('기자 — 정체 공개');
    const g = await setup(['reporter', 'mafia', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    await g.act(0, { targetId: g.id(1) });
    await g.pass(1);
    await g.dawn();
    const rev = g.c[3].state.reveals;
    check('아침에 특종 전달', rev.length === 1 && rev[0].roleName === '마피아', JSON.stringify(rev));
    check('전원이 해당 인물의 직업을 알게 됨', g.seeRole(3, 1) === '마피아', String(g.seeRole(3, 1)));
    check('공개 로그에 기록', g.c[3].state.publicLog.some((l) => l.text.includes('기자 특종')));
    check('기자 능력 1회 한정', !g.c[0].state.you.canAct || g.c[0].state.room.phase !== 'NIGHT');
    g.close();
  }

  // ── 정신병자 ─────────────────────────────────────────────────
  {
    head('정신병자 — 가짜 직업과 무효 능력');
    const g = await setup(['lunatic', 'mafia', 'detective', 'citizen', 'citizen', 'citizen']);
    check('본인은 다른 직업으로 알고 있음',
      g.you(0).role.name !== '정신병자' && g.you(0).role.team === 'CITIZEN', g.you(0).role.name);
    await g.toNight();
    check('가짜 직업의 능력을 쓸 수 있음', g.you(0).canAct);
    await g.act(0, { targetId: g.id(1) });   // 경찰인 줄 알고 마피아를 감시
    await g.act(2, { targetId: g.id(0) });   // 탐정이 정신병자를 조사
    const adj = g.you(1).actionTargets;
    await g.act(1, { targetId: adj.find((x) => x !== g.id(0)) ?? adj[0] });
    await g.dawn();
    check('정신병자의 능력은 아무 정보도 주지 않음',
      !g.info(0).includes('목격') && !g.info(0).includes('죽이지 않았'), g.info(0) || '(정보 없음)');
    check('탐정에게는 진짜 직업(정신병자)이 후보로 잡힘',
      g.info(2).includes('정신병자'), g.info(2));
    // 편성표에 없는 직업이 후보로 나오면 어느 쪽이 진짜인지 바로 들통난다
    const inPlayNames = ['정신병자', '마피아', '탐정', '시민'];
    const shown = (g.info(2).match(/「([^」]+)」/g) || []).map((s) => s.slice(1, -1));
    check('가짜 후보도 편성표 안에서만 나옴',
      shown.length === 2 && shown.every((n) => inPlayNames.includes(n)), shown.join(' / '));
    g.close();
  }

  // ── 삼둥이: 사망 순서 ────────────────────────────────────────
  {
    head('삼둥이 — 사망 순서 보호');
    const g = await setup([
      'triplet_mafia', 'triplet_citizen', 'triplet_neutral',
      'mafia', 'citizen', 'citizen', 'citizen', 'citizen',
    ]);
    check('첫째 순번 부여', g.you(0).tripletOrder === 1);
    check('둘째 순번 부여', g.you(1).tripletOrder === 2);
    check('셋째는 중립', g.you(2).tripletOrder === 3 && g.you(2).role.team === 'NEUTRAL');
    check('첫째는 둘째를 삼둥이로 인식', g.seeRole(0, 1) === '삼둥이', String(g.seeRole(0, 1)));
    check('첫째는 셋째를 모름', g.seeRole(0, 2) === null, String(g.seeRole(0, 2)));
    check('셋째는 형제를 모름', g.seeRole(2, 0) === null && g.seeRole(2, 1) === null);

    await g.toNight();
    await g.pass(0); await g.pass(2); await g.pass(3);
    await g.dawn();
    await g.toVote();
    await g.voteAll(0);   // 첫째를 처형 시도
    await g.execution();
    check('셋째가 살아 있으면 첫째는 죽지 않음', g.alive(0));
    check('보호 사유 전달', g.c[0].state.survivors.some((s) => s.reason === 'TRIPLET_ORDER'));
    check('본인에게 안내', g.info(0).includes('형제가 아직 살아'), g.info(0));
    g.close();
  }

  // ── 삼둥이 셋째: 단독 승리 ───────────────────────────────────
  {
    head('삼둥이 셋째 — 형제 맞히기 단독 승리');
    const g = await setup([
      'triplet_mafia', 'triplet_citizen', 'triplet_neutral',
      'mafia', 'citizen', 'citizen', 'citizen', 'citizen',
    ]);
    await g.toNight();
    check('셋째는 두 명을 지목한다', g.you(2).actionPair === true);
    await g.act(2, { targetId: g.id(0), secondId: g.id(1) });
    await g.pass(0); await g.pass(3);
    await g.end();
    const w = g.c[0].state.result.winners;
    check('셋째 단독 승리', w.length === 1 && w[0].playerId === g.id(2), JSON.stringify(w));
    check('승리 사유 기록', g.c[0].state.result.reason.includes('맞혔'), g.c[0].state.result.reason);
    g.close();
  }

  {
    head('삼둥이 셋째 — 몇 명 맞혔는지 알려준다');
    const mk = () => setup([
      'triplet_mafia', 'triplet_citizen', 'triplet_neutral',
      'mafia', 'citizen', 'citizen', 'citizen', 'citizen',
    ]);

    // 둘 다 형제가 아닌 경우
    const a = await mk();
    await a.toNight();
    await a.act(2, { targetId: a.id(4), secondId: a.id(5) });
    await a.passRest();
    await a.dawn();
    check('둘 다 틀리면 「둘 다 아니다」', a.info(2).includes('둘 다 형제가 아닙니다'), a.info(2));
    check('아직 승리하지 않음', a.c[0].state.room.phase !== 'END');
    a.close();

    // 한 명만 형제인 경우
    const b = await mk();
    await b.toNight();
    await b.act(2, { targetId: b.id(0), secondId: b.id(4) });
    await b.passRest();
    await b.dawn();
    check('한 명만 맞으면 「한 명만」', b.info(2).includes('한 명만 형제입니다'), b.info(2));
    check('누가 맞았는지는 숨김', b.info(2).includes('알 수 없습니다'));
    b.close();
  }

  // ── 관종 ─────────────────────────────────────────────────────
  {
    head('관종 — 과반 득표 단독 승리');
    const g = await setup(['attention', 'mafia', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    await g.pass(1);
    await g.dawn();
    await g.toVote();
    await g.voteAll(0);
    await g.end();
    const w = g.c[1].state.result.winners;
    check('관종 단독 승리', w.length === 1 && w[0].playerId === g.id(0), JSON.stringify(w));
    check('진영 승리 아님', g.c[1].state.result.winner === null);
    g.close();
  }

  // ── 삐에로 ───────────────────────────────────────────────────
  {
    head('삐에로 — 가짜 총성과 점수');
    const g = await setup(['clown', 'mafia', 'citizen', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    check('지목 없이 발동하는 능력', g.you(0).actionNoTarget === true);
    await g.act(0, { targetId: 'FIRE' });
    await g.pass(1);
    await g.dawn();
    check('총소리가 전체에 들림', g.c[4].cues.includes('sfx.gunshot'));
    check('가짜 총성으로는 아무도 죽지 않음', g.c[4].state.deaths.length === 0,
      JSON.stringify(g.c[4].state.deaths));
    await g.toVote();
    await g.voteAll(4);
    await g.execution();
    check('투표 처형 발생', !g.alive(4));
    check('삐에로 1점 획득', g.you(0).clownCredits === 1, `credits=${g.you(0).clownCredits}`);
    check('본인에게 진행도 안내', g.info(0).includes('1 / 3'), g.info(0));
    g.close();
  }

  // ── 연쇄살인마 ───────────────────────────────────────────────
  {
    head('연쇄살인마 — 총성 없음 + 진영 승리 저지');
    const g = await setup(['serial_killer', 'mafia', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    await g.act(0, { targetId: g.id(1) });  // 마피아를 제거
    await g.pass(1);
    await g.dawn();
    check('마피아 사망', !g.alive(1));
    check('총소리가 나지 않음', !g.c[3].cues.includes('sfx.gunshot'), g.c[3].cues.join(','));
    await g.next();  // 아침 → 승패 판정
    check('중립이 살아 있으면 시민이 이기지 않음',
      g.c[0].state.room.phase !== 'END', g.c[0].state.room.phase);
    g.close();
  }

  // ── 죽일 수단이 없는 중립은 진영 승리를 막지 않는다 ─────────
  {
    head('관종 — strictNeutralElimination 을 끄면 진영 승리를 막지 않음');
    const g = await setup(
      ['mafia', 'attention', 'citizen', 'citizen', 'citizen'],
      { strictNeutralElimination: false }
    );
    await g.toNight();
    await g.pass(0);
    await g.dawn();
    await g.toVote();
    // 마피아(1번)를 처형한다. 관종은 과반을 못 받으므로 단독 승리 조건은 성립하지 않는다.
    await g.voteAll(0);
    await g.end();
    const res = g.c[1].state.result;
    check('마피아 처형됨', !g.alive(0));
    check('관종 생존', g.alive(1));
    check('시민 진영 승리', res.winner === 'CITIZEN', JSON.stringify(res.winners));
    check('관종은 패배 처리', !res.roles.find((r) => r.id === g.id(1)).won);
    g.close();
  }

  {
    head('strictNeutralElimination — 기본값에서는 중립도 전부 잡아야 함');
    const g = await setup(['mafia', 'attention', 'citizen', 'citizen', 'citizen']);
    await g.toNight();
    await g.pass(0);
    await g.dawn();
    await g.toVote();
    await g.voteAll(0);
    await g.execution();
    await sleep(400);
    await g.next();
    check('마피아 처형됨', !g.alive(0));
    check('관종이 살아 있어 게임이 끝나지 않음',
      g.c[1].state.room.phase !== 'END', g.c[1].state.room.phase);
    g.close();
  }

  // ── 제한 일수 도달 처리 ──────────────────────────────────────
  {
    head('제한 일수 초과 — 마피아가 못 이기면 시민 진영 승리');
    const g = await setup(
      ['mafia', 'citizen', 'citizen', 'citizen', 'citizen'],
      { maxDays: 1 }
    );
    // 1일차: 아무도 죽지 않고 전원 기권 → 2일차로 넘어가면 제한 일수 초과
    await g.toNight();
    await g.pass(0);
    await g.dawn();
    await g.toVote();
    await g.abstainAll();
    await g.execution();
    check('1일차에는 아직 안 끝남', g.c[0].state.room.phase === 'EXECUTION', g.c[0].state.room.phase);
    await g.next();          // 2일차 밤으로
    await g.pass(0);
    await g.end();
    const res = g.c[0].state.result;
    check('시민 진영 승리로 종결', res.winner === 'CITIZEN', JSON.stringify(res.winners));
    check('사유에 제한 일수가 명시됨', res.reason.includes('이기지 못해'), res.reason);
    check('마피아는 패배 처리', !res.roles.find((r) => r.id === g.id(0)).won);
    g.close();
  }

  {
    head('제한 일수 초과 — maxDaysWinner 를 NONE 으로 두면 무승부');
    const g = await setup(
      ['mafia', 'citizen', 'citizen', 'citizen', 'citizen'],
      { maxDays: 1, maxDaysWinner: 'NONE' }
    );
    await g.toNight();
    await g.pass(0);
    await g.dawn();
    await g.toVote();
    await g.abstainAll();
    await g.execution();
    await g.next();
    await g.pass(0);
    await g.end();
    const res = g.c[0].state.result;
    check('무승부로 종결', res.winner === null && res.winners.length === 0, JSON.stringify(res.winners));
    check('사유가 무승부', res.reason.includes('무승부'), res.reason);
    g.close();
  }

  // ── 진돗개 ───────────────────────────────────────────────────
  {
    head('진돗개 — 각인과 연쇄 사망');
    const g = await setup(['jindo', 'mafia', 'citizen', 'citizen', 'citizen']);
    check('시작 능력 제공', g.you(0).startAction?.kind === 'IMPRINT');
    const im = await g.c[0].emit('start:action', { targetId: g.id(2) });
    await sleep(250);
    check('각인 성공', im.ok, im.error || '');
    check('주인의 직업을 알게 됨', g.info(0).includes('시민'), g.info(0));
    check('주인을 직업까지 인식', g.seeRole(0, 2) === '시민', String(g.seeRole(0, 2)));

    await g.toNight();
    await g.act(1, { targetId: g.id(2) });  // 마피아(자리2)가 주인(자리3)을 죽인다
    await g.dawn();
    check('주인 사망', !g.alive(2));
    check('진돗개도 함께 사망', !g.alive(0));
    check('연쇄 사망으로 기록됨',
      g.c[3].state.deaths.some((d) => d.cause === 'JINDO_CHAIN'),
      JSON.stringify(g.c[3].state.deaths.map((d) => d.cause)));
    g.close();
  }

  await sleep(300);
  console.log(`\n${failures === 0 ? '전체 통과' : `${failures}개 실패`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((e) => { console.error(`\n예외 발생 [${scenario}]:`, e.message, '\n'); process.exit(1); });
