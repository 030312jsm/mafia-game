/**
 * 나레이션 음성 일괄 생성기.
 *
 * AI Studio 에서 발급한 Gemini API 키로 나레이션 전체를 한 번에 만들어
 * public/audio/ 에 넣고 manifest.json 까지 갱신한다.
 *
 *   $env:GEMINI_API_KEY='...'        (PowerShell)
 *   npm run narration
 *
 * 옵션
 *   --voice <이름>   목소리 (기본 Charon). Kore / Puck / Enceladus 등
 *   --model <이름>   모델 (기본 gemini-2.5-flash-preview-tts)
 *   --only <키,키>   특정 키만 다시 만들기
 *   --force          이미 있는 파일도 다시 만들기
 *   --dry            실제 호출 없이 무엇을 만들지만 출력
 *
 * 키는 이 스크립트가 환경변수에서 직접 읽는다. 파일에 적어 두지 말 것.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { narrationJobs } from './narration-script.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, '..', 'public', 'audio');

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const VOICE = flag('voice', 'Charon');
const MODEL = flag('model', 'gemini-2.5-flash-preview-tts');
const ONLY = flag('only') ? new Set(flag('only').split(',').map((s) => s.trim())) : null;
const FORCE = has('force');
const DRY = has('dry');

const C = { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m' };

if (!API_KEY && !DRY) {
  console.error(`
${C.red}GEMINI_API_KEY 가 없습니다.${C.r}

  1. https://aistudio.google.com/apikey 에서 키를 발급받으세요
  2. 아래처럼 넣고 다시 실행하세요 (PowerShell)

     $env:GEMINI_API_KEY='발급받은키'
     npm run narration

  무엇이 만들어질지만 먼저 보려면:  npm run narration -- --dry
`);
  process.exit(1);
}

/** 24kHz 16bit 모노 PCM 을 WAV 로 감싼다 (변환 도구 없이 브라우저가 바로 재생한다) */
function pcmToWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt 청크 크기
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // 모노
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // 바이트/초
  header.writeUInt16LE(2, 32);           // 블록 정렬
  header.writeUInt16LE(16, 34);          // 비트 심도
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/** 응답에서 오디오와 실제 샘플레이트를 꺼낸다 */
function extractAudio(json) {
  const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) {
    const reason = json?.candidates?.[0]?.finishReason || json?.error?.message || '알 수 없는 응답';
    throw new Error(`오디오가 없습니다: ${reason}`);
  }
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || 24000;
  return { pcm: Buffer.from(part.inlineData.data, 'base64'), rate };
}

async function synthesize(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return extractAudio(await res.json());
}

// ── 실행 ─────────────────────────────────────────────────────────
fs.mkdirSync(AUDIO_DIR, { recursive: true });

let jobs = narrationJobs();
if (ONLY) jobs = jobs.filter((j) => ONLY.has(j.key));

console.log(`\n${C.b}나레이션 생성${C.r}  ${jobs.length}개  ·  목소리 ${VOICE}  ·  ${MODEL}\n`);

if (DRY) {
  for (const j of jobs) console.log(`  ${j.key.padEnd(22)} ${C.dim}${j.line}${C.r}`);
  console.log(`\n${C.y}--dry 모드라 실제로 만들지는 않았습니다.${C.r}\n`);
  process.exit(0);
}

let made = 0;
let skipped = 0;
const failed = [];

for (const job of jobs) {
  const file = `${job.key}.wav`;
  const dest = path.join(AUDIO_DIR, file);

  if (!FORCE && fs.existsSync(dest)) {
    skipped++;
    console.log(`  ${C.dim}건너뜀${C.r} ${job.key}  ${C.dim}(이미 있음)${C.r}`);
    continue;
  }
  try {
    const { pcm, rate } = await synthesize(job.prompt);
    fs.writeFileSync(dest, pcmToWav(pcm, rate));
    made++;
    const kb = (fs.statSync(dest).size / 1024).toFixed(0);
    console.log(`  ${C.g}완료${C.r}   ${job.key.padEnd(22)} ${kb}KB  ${C.dim}${job.line}${C.r}`);
  } catch (e) {
    failed.push({ key: job.key, error: e.message });
    console.log(`  ${C.red}실패${C.r}   ${job.key.padEnd(22)} ${e.message}`);
  }
  // 무료 등급 분당 요청 제한에 걸리지 않게 살짝 쉬어 간다
  await new Promise((r) => setTimeout(r, 1200));
}

// ── manifest 갱신 ────────────────────────────────────────────────
// 실제로 존재하는 파일만 등록한다. 등록되지 않은 키는 게임이 알아서 TTS 로 대체한다.
const manifestPath = path.join(AUDIO_DIR, 'manifest.json');
const manifest = {};
for (const job of narrationJobs()) {
  for (const ext of ['wav', 'mp3']) {
    const f = `${job.key}.${ext}`;
    if (fs.existsSync(path.join(AUDIO_DIR, f))) { manifest[job.key] = f; break; }
  }
}
// 손으로 넣어둔 총성 파일이 있으면 유지한다
for (const ext of ['mp3', 'wav']) {
  const f = `sfx.gunshot.${ext}`;
  if (fs.existsSync(path.join(AUDIO_DIR, f))) { manifest['sfx.gunshot'] = f; break; }
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n${C.b}── 결과 ──${C.r}`);
console.log(`생성 ${made} · 건너뜀 ${skipped}${failed.length ? ` · ${C.red}실패 ${failed.length}${C.r}` : ''}`);
console.log(`manifest 등록 ${Object.keys(manifest).length}개`);
if (failed.length) {
  console.log(`\n${C.red}실패한 항목${C.r}`);
  for (const f of failed) console.log(`  ${f.key}: ${f.error}`);
  console.log(`\n다시 시도: npm run narration -- --only ${failed.map((f) => f.key).join(',')}`);
}
console.log('');
process.exit(failed.length ? 1 : 0);
