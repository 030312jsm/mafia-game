/**
 * 스모크 테스트: 5인 게임을 밤 1턴 → 아침 → 투표 → 종료까지 실제 소켓으로 돌린다.
 * 실행: node test/smoke.mjs   (서버가 :3000 에 떠 있어야 함)
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const NAMES = ['가나', '다라', '마바', '사아', '자차'];
// 평마피아·평시민은 편성에서 빠졌으므로 실제로 고를 수 있는 직업만 쓴다.
// 저격수 = 마피아 진영(밤에 양옆 살해), 무소속당(시민) = 밤 능력이 없는 시민.
const ROLES = ['sniper', 'police', 'guardian', 'detective', 'independent_citizen'];

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  OK  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    const client = {
      name, socket: s, state: null, cues: [], id: null,
      emit: (ev, data) => new Promise((res) => s.emit(ev, data, (r) => res(r || { ok: false }))),
      waitPhase: (phase, timeout = 15000) =>
        new Promise((res, rej) => {
          if (client.state?.room.phase === phase) return res(client.state);
          const t = setTimeout(() => rej(new Error(`${name}: ${phase} 대기 시간 초과 (현재 ${client.state?.room.phase})`)), timeout);
          const h = (st) => {
            if (st.room.phase === phase) { clearTimeout(t); s.off('state', h); res(st); }
          };
          s.on('state', h);
        }),
    };
    s.on('state', (st) => { client.state = st; });
    s.on('cue', ({ cues }) => client.cues.push(...cues.map((c) => c.key)));
    s.on('connect', () => resolve(client));
  });
}

const run = async () => {
  console.log(`\n마피아 스모크 테스트 → ${URL}\n`);

  // 1) 방 생성 + 입장
  const host = await connect(NAMES[0]);
  const created = await host.emit('room:create', { nickname: NAMES[0] });
  await sleep(200); // 첫 state 브로드캐스트 대기
  check('방 생성', created.ok, created.roomCode);
  check('QR 데이터 생성', !!host.state?.room.qr && host.state.room.qr.startsWith('data:image'));
  check('입장 URL 생성', /\/\?r=[A-Z0-9]{4}$/.test(created.joinUrl || ''), created.joinUrl);
  host.id = created.playerId;
  const code = created.roomCode;

  const players = [host];
  for (let i = 1; i < NAMES.length; i++) {
    const c = await connect(NAMES[i]);
    const res = await c.emit('room:join', { roomCode: code, nickname: NAMES[i] });
    if (!res.ok) throw new Error(`입장 실패: ${res.error}`);
    c.id = res.playerId;
    players.push(c);
  }
  await sleep(200);
  check('5명 입장 완료', host.state.room.playerCount === 5, `${host.state.room.playerCount}명`);

  // 중복 닉네임 거부
  const dup = await connect('임시');
  const dupRes = await dup.emit('room:join', { roomCode: code, nickname: NAMES[1] });
  check('중복 닉네임 거부', !dupRes.ok, dupRes.error);
  dup.socket.close();

  // 방장이 아닌 사람의 방장 명령 거부
  const notHost = await players[1].emit('host:start', {});
  check('비방장 시작 명령 거부', !notHost.ok, notHost.error);

  // 2) 직업 편성
  const cfg = await host.emit('host:config', { patch: { roles: ROLES, nightSeconds: 600, discussSeconds: 600, voteSeconds: 600 } });
  check('직업 편성 저장', cfg.ok && cfg.validation.ok, (cfg.validation?.errors || []).join(' / '));

  const badCfg = await host.emit('host:config', {
    patch: { roles: ['sniper', 'rigger', 'chairman', 'police', 'guardian'] },
  });
  check('마피아 과반 편성 거부', !badCfg.validation.ok,
    badCfg.validation.errors.find((e) => e.includes('과반')) || '');
  await host.emit('host:config', { patch: { roles: ROLES } });

  // 3) 자리 배치
  await host.emit('host:seating', {});
  await sleep(150);
  check('자리 정하기 단계 진입', host.state.room.phase === 'SEATING');

  for (let i = 0; i < players.length; i++) {
    const r = await players[i].emit('seat:claim', { seat: i + 1 });
    if (!r.ok) throw new Error(`자리 선택 실패: ${r.error}`);
  }
  const dupSeat = await players[1].emit('seat:claim', { seat: 1 });
  check('이미 찬 자리 거부', !dupSeat.ok, dupSeat.error);

  // 4) 게임 시작
  const started = await host.emit('host:start', {});
  check('게임 시작', started.ok, started.error || '');
  await sleep(200);

  const roleNames = players.map((p) => p.state.you.role?.id);
  check('전원 직업 배정', roleNames.every(Boolean), roleNames.join(', '));
  check('배정 직업 = 편성 직업', [...roleNames].sort().join() === [...ROLES].sort().join());

  const byRole = (id) => players.find((p) => p.state.you.role.id === id);
  const mafia = byRole('sniper');
  const police = byRole('police');
  const guardian = byRole('guardian');
  const detective = byRole('detective');

  // 마피아는 서로/자기 팀을 알고, 시민은 남의 직업을 모른다
  const citizenView = byRole('independent_citizen').state.players.filter((p) => !p.isYou && p.revealedRole);
  check('시민은 남의 직업을 모름', citizenView.length === 0);

  // 5) 밤
  await host.emit('host:next', {});
  await mafia.waitPhase('NIGHT');
  check('밤 진입', mafia.state.room.phase === 'NIGHT');

  // 마피아 양옆 제약
  const mSeat = mafia.state.you.seat;
  const targets = mafia.state.you.actionTargets;
  const targetSeats = targets
    .map((id) => mafia.state.players.find((p) => p.id === id).seat)
    .sort((a, b) => a - b);
  const expectLeft = ((mSeat - 2 + 5) % 5) + 1;
  const expectRight = (mSeat % 5) + 1;
  check('마피아는 양옆만 지목 가능',
    targetSeats.length === 2 && targetSeats.includes(expectLeft) && targetSeats.includes(expectRight),
    `${mSeat}번 → [${targetSeats}] (기대 [${[expectLeft, expectRight].sort()}])`);

  const illegal = mafia.state.players.find((p) => !targets.includes(p.id) && !p.isYou);
  const illegalRes = await mafia.emit('night:action', { targetId: illegal.id });
  check('양옆 아닌 대상 거부', !illegalRes.ok, illegalRes.error);

  // 수호자가 마피아의 타깃을 보호 → 아무도 안 죽어야 한다
  const victimId = targets[0];
  const victim = players.find((p) => p.id === victimId);
  await guardian.emit('night:action', { targetId: victimId });
  await mafia.emit('night:action', { targetId: victimId });
  // 경찰은 마피아를 감시 → 살인 목격 → 마피아 사살
  await police.emit('night:action', { targetId: mafia.id });
  // 탐정은 아무나 조사
  const detTarget = detective.state.you.actionTargets[0];
  await detective.emit('night:action', { targetId: detTarget });

  await host.waitPhase('DAWN');
  await sleep(300); // 나머지 소켓의 state 도착 대기
  const deaths = host.state.deaths;
  check('수호자 보호 성공 (지목당한 사람 생존)',
    !deaths.some((d) => d.playerId === victimId),
    `사망: ${deaths.map((d) => d.nickname).join(',') || '없음'}`);
  check('경찰이 살인자 목격 후 사살', deaths.some((d) => d.playerId === mafia.id && d.cause === 'POLICE'));
  check('경찰 개인 로그 생성', (police.state.you.info || []).some((i) => i.text.includes('목격')));
  check('탐정 2지선다 정보 수신', (detective.state.you.info || []).some((i) => i.text.includes('중 하나')));
  check('탐정 정보에 정답 포함',
    (detective.state.you.info || []).some((i) =>
      i.text.includes(players.find((p) => p.id === detTarget).state.you.role.name)));

  // 마피아가 죽었으므로 시민 승리로 게임이 끝나야 한다
  await host.emit('host:next', {});
  await host.waitPhase('END');
  check('시민 승리 판정', host.state.result?.winner === 'CITIZEN', host.state.result?.reason);
  check('종료 시 전원 직업 공개', host.state.result.roles.every((r) => r.roleName && r.roleName !== '?'));
  check('보호받은 사람 생존', host.state.result.roles.find((r) => r.id === victimId).alive);

  // 나레이션 큐가 실제로 흘렀는지
  check('공통 나레이션 큐 수신',
    host.cues.includes('night.begin') && host.cues.includes('day.begin') && host.cues.includes('game.end.citizen'),
    host.cues.join(' → '));
  check('개인 나레이션 큐 수신 (마피아)', mafia.cues.includes('night.mafia'));
  check('능력 없는 시민은 대기 큐 수신', byRole('independent_citizen').cues.includes('night.wait'));

  // 6) 재시작
  await host.emit('host:reset', {});
  await sleep(150);
  check('대기실 복귀', host.state.room.phase === 'LOBBY' && host.state.room.day === 0);

  // 7) 재접속 복구
  const rejoin = await connect(NAMES[2]);
  const rj = await rejoin.emit('room:join', { roomCode: code, playerId: players[2].id });
  check('playerId 로 재접속 성공', rj.ok && rj.playerId === players[2].id, rj.error || '');
  rejoin.socket.close();

  for (const p of players) p.socket.close();
  await sleep(200);

  console.log(`\n${failures === 0 ? '전체 통과' : `${failures}개 실패`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((e) => { console.error('\n예외 발생:', e.message, '\n'); process.exit(1); });
