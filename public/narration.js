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

  /** 모바일 브라우저는 사용자 조작 이후에만 소리를 허용한다 */
  function unlock() {
    if (unlocked) return;
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

      const file = manifest[c.key];
      let ok = false;
      if (file) ok = await playFile(`/audio/${file}`);
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
