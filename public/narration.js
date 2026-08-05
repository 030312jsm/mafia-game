/* 나레이션 재생기.
 *
 * 서버가 { key, text } 큐를 보내면
 *   1) /audio/manifest.json 에 해당 key 가 있으면 그 음성 파일을 재생하고
 *   2) 없으면 브라우저 TTS 로 text 를 읽는다.
 *
 * 녹음한 음성이 준비되면 public/audio/ 에 <key>.mp3 를 넣고
 * manifest.json 에 key 를 추가하기만 하면 자동으로 그쪽이 쓰인다.
 */
window.Narrator = (() => {
  let manifest = null;       // { "night.begin": "night.begin.mp3", ... }
  let unlocked = false;
  let muted = false;
  const queue = [];
  let playing = false;
  const cache = new Map();

  async function loadManifest() {
    try {
      const res = await fetch('/audio/manifest.json', { cache: 'no-store' });
      manifest = res.ok ? await res.json() : {};
    } catch {
      manifest = {};
    }
  }
  loadManifest();

  // ── 효과음 합성 ───────────────────────────────────────────
  // 총소리를 "탕!" 이라고 읽어주면 분위기가 완전히 죽는다.
  // 음성 파일을 따로 받지 않아도 되도록 브라우저에서 직접 만들어 낸다.
  // (public/audio 에 mp3 를 넣고 manifest 에 등록하면 그쪽이 우선한다)
  let audioCtx = null;
  const liveNodes = new Set();

  function ctx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch { return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function stopSfx() {
    for (const n of liveNodes) { try { n.stop(); } catch { /* 이미 끝남 */ } }
    liveNodes.clear();
  }

  /** 총성: 순간적인 노이즈 폭발 + 저역 쿵 */
  function playGunshot() {
    const ac = ctx();
    if (!ac) return Promise.resolve(false);
    const now = ac.currentTime;
    const dur = 0.45;

    // 총구 폭발음의 몸통 — 뒤로 갈수록 빠르게 잦아드는 백색 잡음
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3);
    }
    const noise = ac.createBufferSource();
    noise.buffer = buf;

    // 밝은 「탕」에서 둔탁한 잔향으로 떨어지게 저역통과를 쓸어내린다
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(9000, now);
    lp.frequency.exponentialRampToValueAtTime(320, now + 0.3);

    const noiseGain = ac.createGain();
    noiseGain.gain.setValueAtTime(0.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(1, now + 0.004);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    // 저역 쿵 — 무게감을 준다
    const thump = ac.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(150, now);
    thump.frequency.exponentialRampToValueAtTime(45, now + 0.18);
    const thumpGain = ac.createGain();
    thumpGain.gain.setValueAtTime(0.9, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    const master = ac.createGain();
    master.gain.value = 0.85;

    noise.connect(lp); lp.connect(noiseGain); noiseGain.connect(master);
    thump.connect(thumpGain); thumpGain.connect(master);
    master.connect(ac.destination);

    noise.start(now);
    thump.start(now);
    thump.stop(now + 0.25);
    noise.stop(now + dur);
    liveNodes.add(noise); liveNodes.add(thump);

    return new Promise((resolve) => {
      const t = setTimeout(() => {
        liveNodes.delete(noise); liveNodes.delete(thump);
        resolve(true);
      }, dur * 1000 + 60);
      noise.onended = () => { clearTimeout(t); liveNodes.delete(noise); resolve(true); };
    });
  }

  /** 말이 아니라 소리로 내보내야 하는 큐들 */
  const SFX = { 'sfx.gunshot': playGunshot };

  /** 모바일 브라우저는 사용자 조작 이후에만 소리를 허용한다 */
  function unlock() {
    if (unlocked) return;
    ctx(); // 사용자 조작 시점에 오디오 컨텍스트를 열어둔다
    try {
      const a = new Audio(
        'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7v///////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYbUyV1cAAAAAAAAAAAAAAAAAAAA//sQxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV'
      );
      a.volume = 0;
      a.play().catch(() => {});
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
      unlocked = true;
    } catch { /* 무시 */ }
  }

  function playFile(src) {
    return new Promise((resolve) => {
      let a = cache.get(src);
      if (!a) { a = new Audio(src); cache.set(src, a); }
      a.currentTime = 0;
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      a.onended = () => finish(true);
      a.onerror = () => finish(false);
      // 중간에 끊겼을 때도 반드시 프라미스를 풀어준다.
      // 안 그러면 재생 루프가 영원히 멈춘 채로 남는다.
      a.onpause = () => finish(true);
      a.play().catch(() => finish(false));
    });
  }

  function speak(text) {
    return new Promise((resolve) => {
      if (!text || !('speechSynthesis' in window)) return resolve(false);
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR';
        u.rate = 0.95;
        u.onend = () => finish(true);
        u.onerror = () => finish(false);
        // cancel() 로 끊겼는데 이벤트가 안 오는 브라우저가 있어 보험을 둔다
        const guard = setInterval(() => {
          if (!speechSynthesis.speaking && !speechSynthesis.pending) {
            clearInterval(guard); finish(true);
          }
        }, 400);
        setTimeout(() => clearInterval(guard), 30000);
        speechSynthesis.speak(u);
      } catch { finish(false); }
    });
  }

  // stopAll 이 불릴 때마다 올라간다. 진행 중이던 재생 루프는 세대가 바뀐 걸 보고 빠져나온다.
  let gen = 0;

  async function drain() {
    if (playing) return;
    playing = true;
    const myGen = gen;
    while (queue.length && gen === myGen) {
      const c = queue.shift();
      if (muted) continue;
      if (manifest === null) await loadManifest();
      if (gen !== myGen) break;

      // 우선순위: 등록된 음성 파일 → 내장 효과음 → 브라우저 TTS
      const file = manifest[c.key];
      let ok = false;
      if (file) ok = await playFile(`/audio/${file}`);
      if (gen !== myGen) break;
      if (!ok && SFX[c.key]) ok = await SFX[c.key]();
      if (gen !== myGen) break;
      if (!ok) await speak(c.text);
      if (gen !== myGen) break;
      await new Promise((r) => setTimeout(r, 180));
    }
    playing = false;
    // 끊긴 사이에 새로 쌓인 게 있으면 이어서 돈다
    if (queue.length) drain();
  }

  /** 재생 중인 음성과 대기 중인 큐를 전부 버린다 */
  function stopAll() {
    gen++;
    queue.length = 0;
    stopSfx();
    try { speechSynthesis.cancel(); } catch { /* 무시 */ }
    for (const a of cache.values()) {
      try { a.pause(); a.currentTime = 0; } catch { /* 무시 */ }
    }
  }

  let lastKey = null;

  return {
    unlock,
    isUnlocked: () => unlocked,
    stopAll,
    setMuted(v) {
      muted = v;
      if (v) stopAll();
    },
    isMuted: () => muted,
    /** 대기 중인 큐 길이 (동작 확인용) */
    queueLength: () => queue.length,
    /** 내장 효과음 상태 (동작 확인용) */
    audioState: () => (audioCtx ? audioCtx.state : 'none'),
    hasSfx: (key) => !!SFX[key],
    /** 효과음을 한 번 들어본다 (설정 화면에서 미리듣기 용도) */
    preview: (key) => (SFX[key] ? SFX[key]() : Promise.resolve(false)),
    /**
     * 큐를 밀어 넣는다.
     * key(단계+일차)가 바뀌면 이전 단계의 음성은 버린다.
     * 안 그러면 밤 안내가 아침까지 흘러나와서 진행과 어긋난다.
     */
    push(cues, key = null) {
      if (key != null && key !== lastKey) {
        stopAll();
        lastKey = key;
      }
      for (const c of cues) queue.push(c);
      drain();
    },
    /** 준비된 음성 파일 목록 (설정 화면 표시용) */
    manifest: () => manifest || {},
  };
})();
