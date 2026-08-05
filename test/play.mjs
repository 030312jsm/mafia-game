/**
 * 봇으로 한 판 돌려보기.
 *
 *   node test/play.mjs 8                      8명 전원 봇, 자동으로 끝까지 진행
 *   node test/play.mjs 8 --humans 1           봇 7 + 사람 1 (브라우저로 참가)
 *   node test/play.mjs 8 --roles random       무작위 특수 직업 편성
 *   node test/play.mjs 6 --roles '["mafia","police","guardian","citizen","citizen","clown"]'
 *
 * 옵션
 *   --humans N   사람이 앉을 자리 수 (기본 0). 봇이 낮은 번호 자리부터 채운다.
 *   --roles      auto(기본) | random | JSON 배열
 *   --hold 초    각 단계에서 방장 봇이 기다리는 시간 (사람이 있으면 기본 12초, 없으면 1초)
 *   --url        서버 주소 (기본 http://localhost:3000)
 *   --quiet      봇의 개별 행동 로그를 숨긴다
 */
import QRCode from 'qrcode';
import { createBot, BOT_NAMES } from './bot.mjs';
import { randomComposition, defaultComposition } from './compose.mjs';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const total = Number(argv.find((a) => /^\d+$/.test(a)) || 8);
const humans = Number(flag('humans', 0));
const url = flag('url', 'http://localhost:3000');
const rolesOpt = flag('roles', 'auto');
const holdSec = Number(flag('hold', humans > 0 ? 12 : 1));
const godView = !has('quiet') && humans === 0;

const botCount = total - humans;
if (botCount < 1) { console.error('봇이 최소 1명은 있어야 방장을 맡습니다.'); process.exit(1); }
if (total < 4) { console.error('최소 4명이 필요합니다.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', y: '\x1b[33m', c: '\x1b[36m', g: '\x1b[32m', m: '\x1b[35m' };

const logAction = ({ bot, text }) => {
  if (!godView) return;
  const you = bot.state?.you;
  const who = `${you?.seat ?? '?'}번 ${bot.nickname}`;
  const role = you?.role?.name ?? '?';
  console.log(`   ${C.dim}${who} (${role}) — ${text}${C.r}`);
};

const bots = [];
const cleanup = () => { for (const b of bots) b.close(); };
process.on('SIGINT', () => { cleanup(); process.exit(0); });

// ── 편성표 결정 ──────────────────────────────────────────────
function buildRoles() {
  if (rolesOpt === 'auto') return defaultComposition(total);
  if (rolesOpt === 'random') return randomComposition(total);
  try {
    const parsed = JSON.parse(rolesOpt);
    if (!Array.isArray(parsed) || parsed.length !== total) {
      throw new Error(`직업 ${parsed.length}개 / 인원 ${total}명 — 개수가 맞아야 합니다.`);
    }
    return parsed;
  } catch (e) {
    console.error(`--roles 파싱 실패: ${e.message}`);
    process.exit(1);
  }
}

// ── 진행 ─────────────────────────────────────────────────────
const host = await createBot({
  url, nickname: BOT_NAMES[0], holdMs: holdSec * 1000, autoAdvance: true,
  claimSeat: false, // 자리는 아래에서 번호를 지정해 직접 배정한다
  log: logAction,
});
bots.push(host);

for (let i = 1; i < botCount; i++) {
  const b = await createBot({
    url, nickname: BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? i : ''),
    roomCode: host.roomCode, claimSeat: false, log: logAction,
  });
  bots.push(b);
}

console.log(`\n${C.b}방 ${host.roomCode}${C.r}  ·  봇 ${botCount}명${humans ? ` + 사람 ${humans}명` : ''}`);

if (humans > 0) {
  const joinUrl = host.joinUrl || `${url}/?r=${host.roomCode}`;
  console.log(`\n입장 주소: ${C.c}${joinUrl}${C.r}`);
  console.log(await QRCode.toString(joinUrl, { type: 'terminal', small: true }));
  console.log(`${C.y}봇이 1~${botCount}번 자리를 잡습니다. 사람은 ${botCount + 1}번 이후 자리를 고르세요.${C.r}`);
  console.log(`${C.dim}(localhost 주소는 같은 PC 의 브라우저에서만 열립니다. 폰으로 붙으려면 PUBLIC_URL 을 지정해 배포하세요)${C.r}\n`);
  console.log('사람 입장 대기 중…');
  while (host.state.room.playerCount < total) await sleep(400);
  console.log('전원 입장 완료.\n');
}

// 편성표는 서버 검증을 통과할 때까지 다시 뽑는다
let roles = buildRoles();
for (let tries = 0; tries < 60; tries++) {
  const res = await host.emit('host:config', {
    patch: { roles, nightSeconds: 600, discussSeconds: humans ? 90 : 600, voteSeconds: 600 },
  });
  if (res.validation?.ok) break;
  if (rolesOpt !== 'random') {
    console.error(`편성 오류:\n  ${res.validation?.errors.join('\n  ')}`);
    cleanup(); process.exit(1);
  }
  roles = randomComposition(total);
}

console.log(`${C.b}편성${C.r} ${roles.map((r) => r).join(', ')}\n`);

await host.emit('host:seating', {});
await sleep(300);
for (let i = 0; i < botCount; i++) {
  const r = await bots[i].emit('seat:claim', { seat: i + 1 });
  if (!r.ok) console.error(`자리 ${i + 1}: ${r.error}`);
}

if (humans > 0) {
  console.log('사람이 자리를 고를 때까지 대기 중…');
  while (host.state.players.some((p) => p.seat == null)) await sleep(400);
}

const started = await host.emit('host:start', {});
if (!started.ok) { console.error(`시작 실패: ${started.error}`); cleanup(); process.exit(1); }
await sleep(400);

if (godView) {
  console.log(`${C.b}── 실제 직업 (관전자 시점) ──${C.r}`);
  for (const b of [...bots].sort((x, y) => x.state.you.seat - y.state.you.seat)) {
    const you = b.state.you;
    const tag = you.tripletOrder ? ` [${['첫째', '둘째', '셋째'][you.tripletOrder - 1]}]` : '';
    console.log(`  ${String(you.seat).padStart(2)}번 ${b.nickname.padEnd(6)} ${you.role.name}${tag}`);
  }
  console.log('');
}

// 공개 로그를 따라가며 출력
let logLen = 0;
const tick = setInterval(() => {
  const log = host.state?.publicLog ?? [];
  for (const line of log.slice(logLen)) console.log(`${C.g}▸${C.r} ${line.text}`);
  logLen = log.length;
}, 300);

// 종료 대기 (진행이 멈추면 알려준다)
let lastChange = Date.now();
let lastKey = '';
while (!host.done) {
  const key = `${host.state.room.phase}:${host.state.room.day}:${host.state.players.filter((p) => p.alive).length}`;
  if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
  if (Date.now() - lastChange > 120000) {
    console.error(`\n${C.y}2분 동안 진행이 없습니다. 현재: ${host.state.room.phase} ${host.state.room.day}일차${C.r}`);
    break;
  }
  await sleep(300);
}
await sleep(600);
clearInterval(tick);

const res = host.done;
if (res) {
  const title = res.winners.length ? `🏁 ${res.winners.map((w) => w.label).join(' · ')} 승리` : '🤝 무승부';
  console.log(`\n${C.b}${C.m}${title}${C.r}`);
  console.log(`${C.dim}${res.reason}${C.r}\n`);
  for (const r of [...res.roles].sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99))) {
    const mark = r.won ? `${C.y}★${C.r}` : ' ';
    const life = r.alive ? '생존' : '사망';
    const fake = r.fakeRoleName ? ` ${C.dim}(「${r.fakeRoleName}」인 줄 알았음)${C.r}` : '';
    const tri = r.tripletOrder ? ` [${['첫째', '둘째', '셋째'][r.tripletOrder - 1]}]` : '';
    console.log(`  ${mark} ${String(r.seat).padStart(2)}번 ${r.nickname.padEnd(6)} ${r.roleName}${tri} ${C.dim}${life}${C.r}${fake}`);
  }
  console.log('');
}

cleanup();
process.exit(res ? 0 : 1);
