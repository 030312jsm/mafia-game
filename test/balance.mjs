/**
 * 인원수별 밸런스 스윕.
 *
 * (인원, 마피아 수, 중립 수) 조합을 하나씩 대입해 여러 판을 돌리고,
 * 어느 조합이 가장 균형에 가까운지 표로 뽑는다.
 *
 *   node test/balance.mjs --games 60 --parallel 20
 *   node test/balance.mjs --plan "8:2:1,8:3:1" --games 40     조합 직접 지정
 *
 * 편성은 매번 같은 규칙으로 만들어 고정한다. 무작위 편성으로 재면
 * 편성 자체가 가장 큰 변수라 60판으로도 15%p 차이를 판별할 수 없다.
 */
import { createBot, BOT_NAMES } from './bot.mjs';
import { MAFIA_POOL, CITIZEN_POOL, NEUTRAL_POOL, isTriplet } from '../server/roles.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const GAMES = Number(flag('games', 60));
const PARALLEL = Math.max(1, Number(flag('parallel', 20)));
const URL = flag('url', 'http://localhost:3000');
const STALL_MS = Number(flag('stall', 60000));

const C = { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', y: '\x1b[33m', g: '\x1b[32m', red: '\x1b[31m' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const noTri = (pool) => pool.filter((id) => !isTriplet(id));
const M_POOL = noTri(MAFIA_POOL);
const C_POOL = noTri(CITIZEN_POOL);
const N_POOL = noTri(NEUTRAL_POOL);

/** (인원, 마피아, 중립) → 구체적인 편성표 */
function composition(n, mafia, neutral) {
  const citizens = n - mafia - neutral;
  if (mafia < 1 || neutral < 0 || citizens < 1) return null;
  if (mafia > M_POOL.length || neutral > N_POOL.length || citizens > C_POOL.length) return null;
  if (mafia * 2 >= n) return null; // 처음부터 마피아 과반이면 게임이 성립하지 않는다
  return [...M_POOL.slice(0, mafia), ...N_POOL.slice(0, neutral), ...C_POOL.slice(0, citizens)];
}

/** 기본으로 훑어볼 조합들 */
function defaultPlan() {
  const plan = [];
  for (const n of [5, 6, 7, 8, 9, 10, 12]) {
    const maxM = Math.min(M_POOL.length, Math.ceil(n / 2) - 1);
    for (let m = 1; m <= maxM; m++) {
      for (const k of n >= 6 ? [0, 1, 2] : [0, 1]) {
        if (composition(n, m, k)) plan.push({ n, m, k });
      }
    }
  }
  return plan;
}

function parsePlan(text) {
  return text.split(',').map((s) => {
    const [n, m, k] = s.split(':').map(Number);
    return { n, m, k };
  });
}

/**
 * 편성표를 직접 지정해 비교할 때 쓴다.
 * --sets '이름=역할,역할,...;이름=...' 형태
 * 인원수별 권장 「수」가 아니라 「어떤 직업을 넣느냐」의 영향을 볼 때 필요하다.
 */
function parseSets(text) {
  return text.split(';').map((chunk) => {
    const [label, list] = chunk.split('=');
    const roles = list.split(',').map((s) => s.trim());
    return { label: label.trim(), roles, n: roles.length };
  });
}

// ── 한 판 ────────────────────────────────────────────────────────
async function playOne(n, roles) {
  const bots = [];
  const cleanup = () => { for (const b of bots) b.close(); };
  try {
    const host = await createBot({
      url: URL, nickname: BOT_NAMES[0], holdMs: 0, autoAdvance: true, claimSeat: false,
    });
    bots.push(host);
    for (let i = 1; i < n; i++) {
      bots.push(await createBot({
        url: URL, roomCode: host.roomCode, claimSeat: false,
        nickname: BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? i : ''),
      }));
    }

    const cfg = await host.emit('host:config', {
      patch: { roles, nightSeconds: 25, discussSeconds: 25, voteSeconds: 25 },
    });
    if (!cfg.validation?.ok) throw new Error(`편성 오류: ${cfg.validation?.errors.join(' / ')}`);

    await host.emit('host:seating', {});
    await sleep(120);
    for (let i = 0; i < n; i++) {
      const r = await bots[i].emit('seat:claim', { seat: i + 1 });
      if (!r.ok) throw new Error(`자리 ${i + 1}: ${r.error}`);
    }
    const started = await host.emit('host:start', {});
    if (!started.ok) throw new Error(started.error);

    let lastKey = '';
    let lastChange = Date.now();
    while (!host.done) {
      const st = host.state;
      const key = `${st.room.phase}:${st.room.day}:${st.players.filter((p) => p.alive).length}`;
      if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
      if (Date.now() - lastChange > STALL_MS) throw new Error(`정체 ${st.room.phase}/${st.room.day}일차`);
      await sleep(120);
    }
    const result = host.done;
    const days = host.state.room.day;
    cleanup();
    return { result, days };
  } catch (e) {
    cleanup();
    return { error: e.message };
  }
}

// ── 한 조합 ──────────────────────────────────────────────────────
async function runCombo({ n, m, k, roles: given }) {
  const roles = given ?? composition(n, m, k);
  const tally = { mafia: 0, citizen: 0, neutral: 0, draw: 0, fail: 0, days: [] };

  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= GAMES) return;
      const { result, days, error } = await playOne(n, roles);
      if (error) { tally.fail++; continue; }
      tally.days.push(days);
      const teams = result.winners.filter((w) => w.kind === 'TEAM').map((w) => w.team);
      const solos = result.winners.filter((w) => w.kind === 'SOLO');
      if (teams.includes('MAFIA')) tally.mafia++;
      else if (teams.includes('CITIZEN')) tally.citizen++;
      else if (solos.length) tally.neutral++;
      else tally.draw++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, GAMES) }, worker));
  return { n, m, k, roles, tally };
}

// ── 실행 ─────────────────────────────────────────────────────────
const plan = flag('sets') ? parseSets(flag('sets'))
  : flag('plan') ? parsePlan(flag('plan'))
  : defaultPlan();
console.log(`\n${C.b}밸런스 스윕${C.r}  조합 ${plan.length}개 × ${GAMES}판 (동시 ${PARALLEL})  → ${URL}`);
console.log(`${C.dim}주의: 봇은 추리를 못 한다. 시민의 승리는 「마피아를 찾아내는 능력」에 달려 있으므로`);
console.log(`      아래 시민 승률은 실제보다 크게 낮다. 절대값이 아니라 조합 간 상대 비교로만 쓸 것.${C.r}\n`);

const rows = [];
const t0 = Date.now();
for (let i = 0; i < plan.length; i++) {
  const combo = plan[i];
  const r = await runCombo(combo);
  rows.push(r);
  const done = r.tally.mafia + r.tally.citizen + r.tally.neutral + r.tally.draw;
  const pct = (v) => done ? Math.round((v / done) * 100) : 0;
  const gap = Math.abs(pct(r.tally.mafia) - pct(r.tally.citizen));
  const avgDays = r.tally.days.length
    ? (r.tally.days.reduce((a, b) => a + b, 0) / r.tally.days.length).toFixed(1) : '-';
  const eta = ((Date.now() - t0) / (i + 1)) * (plan.length - i - 1) / 60000;
  const label = combo.label ?? `마피아${combo.m} 중립${combo.k}`;
  console.log(
    `${String(i + 1).padStart(3)}/${plan.length}  ` +
    `${C.b}${combo.n}인${C.r} ${label.padEnd(16)}  ` +
    `마피아 ${String(pct(r.tally.mafia)).padStart(3)}%  ` +
    `시민 ${String(pct(r.tally.citizen)).padStart(3)}%  ` +
    `중립 ${String(pct(r.tally.neutral)).padStart(3)}%  ` +
    `무승부 ${String(pct(r.tally.draw)).padStart(3)}%  ` +
    `격차 ${String(gap).padStart(3)}  ${avgDays}일` +
    (r.tally.fail ? `  ${C.red}실패${r.tally.fail}${C.r}` : '') +
    `  ${C.dim}남은 시간 약 ${eta.toFixed(0)}분${C.r}`
  );
}

// ── 인원수별 최선 조합 ───────────────────────────────────────────
if (flag('sets')) process.exit(0); // 편성표 직접 비교 모드에서는 여기까지

console.log(`\n${C.b}── 인원수별 가장 균형 잡힌 조합 ──${C.r}`);
const byN = {};
for (const r of rows) (byN[r.n] ||= []).push(r);

const summary = [];
for (const n of Object.keys(byN).map(Number).sort((a, b) => a - b)) {
  const scored = byN[n].map((r) => {
    const done = r.tally.mafia + r.tally.citizen + r.tally.neutral + r.tally.draw || 1;
    const mp = r.tally.mafia / done, cp = r.tally.citizen / done, dp = r.tally.draw / done;
    // 마피아와 시민이 비슷할수록 좋고, 무승부는 감점
    return { ...r, mp, cp, dp, score: Math.abs(mp - cp) + dp * 0.5 };
  }).sort((a, b) => a.score - b.score);

  const best = scored[0];
  summary.push({ n, m: best.m, k: best.k, mp: best.mp, cp: best.cp });
  console.log(
    `  ${String(n).padStart(2)}인 → ${C.g}마피아 ${best.m} · 중립 ${best.k} · 시민 ${n - best.m - best.k}${C.r}` +
    `  ${C.dim}(마피아 ${Math.round(best.mp * 100)}% / 시민 ${Math.round(best.cp * 100)}%)${C.r}`
  );
}

console.log(`\n${C.b}recommendCounts 에 넣을 값${C.r}`);
for (const s of summary) {
  console.log(`  n=${s.n}: { mafia: ${s.m}, neutral: ${s.k}, citizen: ${s.n - s.m - s.k} }`);
}
console.log(`\n총 ${((Date.now() - t0) / 60000).toFixed(1)}분 소요\n`);
process.exit(0);
