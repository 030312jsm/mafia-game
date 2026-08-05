/**
 * 봇으로 여러 판을 연속으로 돌려 밸런스와 안정성을 본다.
 *
 *   node test/simulate.mjs                     8인 20판, 무작위 편성
 *   node test/simulate.mjs --games 100 --players 10
 *   node test/simulate.mjs --roles auto        기본 편성으로만
 *
 * 확인하는 것
 *   - 진영별 승률과 평균 진행 일수 (밸런스 감)
 *   - 직업별 승률 (특정 직업이 너무 강하거나 무의미한지)
 *   - 진행이 멈추거나 예외가 나는 조합 (안정성)
 */
import { createBot, BOT_NAMES } from './bot.mjs';
import { randomComposition, defaultComposition } from './compose.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const games = Number(flag('games', 20));
const players = Number(flag('players', 8));
const url = flag('url', 'http://localhost:3000');
const rolesOpt = flag('roles', 'random');
const STALL_MS = Number(flag('stall', 45000));
// 동시에 돌릴 판 수. 서버는 방을 여러 개 동시에 굴릴 수 있으므로
// 밸런스 측정처럼 판수가 많이 필요할 때 실행 시간을 크게 줄여준다.
const parallel = Math.max(1, Number(flag('parallel', 4)));
// 규칙 A/B 비교용 추가 설정. 예: --config '{"strictNeutralElimination":false}'
const extraConfig = JSON.parse(flag('config', '{}'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', y: '\x1b[33m', g: '\x1b[32m', red: '\x1b[31m' };

const stats = {
  teamWins: {},                 // 진영별 승수
  soloWins: {},                 // 개인 승리한 직업별 승수
  roleAppear: {},               // 직업별 등장 판수
  roleWin: {},                  // 직업별 승리 판수
  days: [],
  failures: [],
  drawSurvivors: [],
};

async function playOne(index) {
  const bots = [];
  const cleanup = () => { for (const b of bots) b.close(); };
  let roles = null;

  /** 실패했을 때 원인을 추적할 수 있도록 각 봇의 실제 직업과 생존 여부를 모은다 */
  const snapshot = () =>
    bots
      .filter((b) => b.state?.you?.role)
      .sort((a, b) => (a.state.you.seat ?? 99) - (b.state.you.seat ?? 99))
      .map((b) => {
        const y = b.state.you;
        const tri = y.tripletOrder ? `[${y.tripletOrder}]` : '';
        return `${y.seat}${y.alive ? '' : '†'}${b.nickname}:${y.role.name}${tri}`;
      })
      .join(' ');

  try {
    // 자리는 아래에서 번호를 지정해 직접 배정하므로 봇의 자동 착석은 끈다
    const host = await createBot({
      url, nickname: BOT_NAMES[0], holdMs: 0, autoAdvance: true, claimSeat: false,
    });
    bots.push(host);
    for (let i = 1; i < players; i++) {
      bots.push(await createBot({
        url, roomCode: host.roomCode, claimSeat: false,
        nickname: BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? i : ''),
      }));
    }

    roles = makeRoles();
    let ok = false;
    for (let t = 0; t < 60; t++) {
      // 실제 플레이와 마찬가지로 서버의 페이즈 타이머를 안전망으로 남겨둔다.
      // (봇이 어떤 이유로 손을 놓아도 방이 영원히 멈추지는 않아야 한다)
      const res = await host.emit('host:config', {
        patch: { roles, nightSeconds: 25, discussSeconds: 25, voteSeconds: 25, ...extraConfig },
      });
      if (res.validation?.ok) { ok = true; break; }
      if (rolesOpt !== 'random') { throw new Error(`편성 오류: ${res.validation?.errors.join(' / ')}`); }
      roles = randomComposition(players);
    }
    if (!ok) throw new Error('유효한 편성표를 만들지 못했습니다.');

    await host.emit('host:seating', {});
    await sleep(150);
    for (let i = 0; i < players; i++) {
      const r = await bots[i].emit('seat:claim', { seat: i + 1 });
      if (!r.ok) throw new Error(`자리 ${i + 1}: ${r.error}`);
    }
    const started = await host.emit('host:start', {});
    if (!started.ok) throw new Error(started.error);

    // 종료 또는 정체 감지
    let lastKey = '';
    let lastChange = Date.now();
    while (!host.done) {
      const st = host.state;
      const key = `${st.room.phase}:${st.room.day}:${st.players.filter((p) => p.alive).length}`;
      if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
      if (Date.now() - lastChange > STALL_MS) {
        throw new Error(`진행 정체 — ${st.room.phase} / ${st.room.day}일차 / 생존 ${st.players.filter((p) => p.alive).length}명`);
      }
      // 서버의 maxDays 무승부 안전망(기본 20일)보다 넉넉하게 잡는다.
      // 여기에 걸린다면 무승부 처리 자체가 동작하지 않은 것이다.
      if (st.room.day > 30) throw new Error('30일을 넘겨도 끝나지 않음 (무승부 처리 미동작)');
      await sleep(120);
    }

    const result = host.done;
    const days = host.state.room.day;
    cleanup();
    return { roles, result, days };
  } catch (e) {
    const snap = snapshot();
    const phase = bots[0]?.state?.room;
    cleanup();
    return { error: e.message, roles, snapshot: snap, at: phase ? `${phase.phase} ${phase.day}일차` : '?' };
  }
}

function makeRoles() {
  if (rolesOpt === 'auto') return defaultComposition(players);
  if (rolesOpt === 'random') return randomComposition(players);
  const parsed = JSON.parse(rolesOpt);
  if (!Array.isArray(parsed) || parsed.length !== players) {
    throw new Error(`--roles 는 ${players}개짜리 배열이어야 합니다 (현재 ${parsed.length}개)`);
  }
  return parsed;
}

const cfgNote = Object.keys(extraConfig).length ? `  ${JSON.stringify(extraConfig)}` : '';
console.log(`\n${C.b}시뮬레이션${C.r}  ${players}인 × ${games}판  (${rolesOpt} 편성, 동시 ${parallel}판)${cfgNote}  → ${url}\n`);

function record(i, { roles, result, days, error, snapshot, at }) {
  if (error) {
    stats.failures.push({ game: i + 1, error, roles, snapshot, at });
    console.log(`${String(i + 1).padStart(3)}. ${C.red}실패${C.r} — ${error}`);
    return;
  }

  stats.days.push(days);

  for (const r of result.roles) {
    stats.roleAppear[r.roleName] = (stats.roleAppear[r.roleName] || 0) + 1;
    if (r.won) stats.roleWin[r.roleName] = (stats.roleWin[r.roleName] || 0) + 1;
  }
  for (const w of result.winners) {
    if (w.kind === 'TEAM') stats.teamWins[w.label] = (stats.teamWins[w.label] || 0) + 1;
    else {
      const name = (w.label.match(/^([^(]+)/) || [])[1]?.trim() || w.label;
      stats.soloWins[name] = (stats.soloWins[name] || 0) + 1;
    }
  }

  if (!result.winners.length) {
    stats.draws = (stats.draws || 0) + 1;
    // 무승부는 왜 끝나지 않았는지가 중요하다. 남아 있던 사람들의 직업을 남겨둔다.
    stats.drawSurvivors.push(
      result.roles.filter((r) => r.alive).map((r) => r.roleName).sort().join(' + ') || '(전멸)'
    );
  }
  const label = result.winners.map((w) => w.label).join(' · ') || `${C.y}무승부${C.r}`;
  console.log(`${String(i + 1).padStart(3)}. ${C.g}${label}${C.r} ${C.dim}${days}일 · ${result.reason}${C.r}`);
}

// 여러 판을 동시에 굴린다. 방끼리는 완전히 독립적이라 서로 간섭하지 않는다.
let nextGame = 0;
async function worker() {
  for (;;) {
    const i = nextGame++;
    if (i >= games) return;
    record(i, await playOne(i));
  }
}
await Promise.all(Array.from({ length: Math.min(parallel, games) }, worker));

// ── 요약 ─────────────────────────────────────────────────────
const done = games - stats.failures.length;
console.log(`\n${C.b}── 요약 ──${C.r}`);
console.log(`완주 ${done} / ${games} 판${stats.failures.length ? `  ${C.red}실패 ${stats.failures.length}판${C.r}` : ''}`);
if (stats.days.length) {
  const avg = stats.days.reduce((a, b) => a + b, 0) / stats.days.length;
  console.log(`평균 진행 ${avg.toFixed(1)}일  (최단 ${Math.min(...stats.days)} · 최장 ${Math.max(...stats.days)})`);
}
if (stats.draws) {
  console.log(`${C.y}무승부 ${stats.draws}판${C.r}`);
  const byPattern = {};
  for (const s of stats.drawSurvivors) byPattern[s] = (byPattern[s] || 0) + 1;
  console.log(`${C.b}무승부로 끝났을 때 남아 있던 사람${C.r}`);
  for (const [k, v] of Object.entries(byPattern).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}판  ${k}`);
  }
}

if (done) {
  console.log(`\n${C.b}진영 승리${C.r}`);
  for (const [k, v] of Object.entries(stats.teamWins).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(3)}판  ${bar(v / done)} ${(v / done * 100).toFixed(0)}%`);
  }
  if (Object.keys(stats.soloWins).length) {
    console.log(`\n${C.b}개인 승리${C.r}`);
    for (const [k, v] of Object.entries(stats.soloWins).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(14)} ${String(v).padStart(3)}판`);
    }
  }

  console.log(`\n${C.b}직업별 승률${C.r} ${C.dim}(등장 3판 이상)${C.r}`);
  const rows = Object.entries(stats.roleAppear)
    .filter(([, n]) => n >= 3)
    .map(([name, n]) => ({ name, n, w: stats.roleWin[name] || 0, rate: (stats.roleWin[name] || 0) / n }))
    .sort((a, b) => b.rate - a.rate);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(16)} ${String(r.w).padStart(3)}/${String(r.n).padEnd(3)}  ${bar(r.rate)} ${(r.rate * 100).toFixed(0)}%`);
  }
}

if (stats.failures.length) {
  console.log(`\n${C.red}${C.b}실패한 판${C.r}`);
  for (const f of stats.failures) {
    console.log(`  ${f.game}판 (${f.at}): ${f.error}`);
    if (f.roles) console.log(`     ${C.dim}편성: ${f.roles.join(', ')}${C.r}`);
    if (f.snapshot) console.log(`     ${C.dim}상황: ${f.snapshot}   († = 사망)${C.r}`);
  }
}

function bar(rate) {
  const n = Math.round(rate * 20);
  return `${'█'.repeat(n)}${'·'.repeat(20 - n)}`;
}

console.log('');
process.exit(stats.failures.length ? 1 : 0);
