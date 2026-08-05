/* 마피아 - 클라이언트 */
(() => {
  const socket = io({ transports: ['websocket', 'polling'] });
  const $app = document.getElementById('app');
  const $gate = document.getElementById('audio-gate');
  const $toast = document.getElementById('toast');

  const LS = {
    get k() { return 'mafia.session'; },
    load() { try { return JSON.parse(localStorage.getItem(this.k) || 'null'); } catch { return null; } },
    save(v) { localStorage.setItem(this.k, JSON.stringify(v)); },
    clear() { localStorage.removeItem(this.k); },
  };

  let S = null;                 // 서버가 준 개인화 상태
  let screen = 'home';          // 'home' | 'room'
  let joinCode = new URLSearchParams(location.search).get('r')?.toUpperCase() || '';
  let nickname = LS.load()?.nickname || '';
  let revealed = false;         // 직업 카드 공개 여부 (본인 조작)
  let lastSeq = 0;
  let connected = false;
  let pairPick = [];            // 삼둥이 셋째: 두 명 지목용
  let nightMode = 'KILL';       // 회장: 죽이기 / 포섭
  let snipeTarget = null;       // 저격수: 대상
  let snipeRole = null;         // 저격수: 직업 추측
  let dayPanel = null;          // 'SNIPE' | 'FORCE_VOTE' | null
  let drawerOpen = false;       // 오른쪽 직업 설명 탭
  let drawerTab = 'roles';      // 'roles' | 'log'
  let lobbyTab = 'players';     // 'players' | 'roles' | 'settings'
  let rolePickerOpen = false;   // 편성 탭에서 전체 직업 목록 펼침
  let codeTaps = 0;             // 방 코드 연타로 개발자 옵션 열기
  const DEV_KEY = 'mafia.devMode';
  const isDev = () => localStorage.getItem(DEV_KEY) === '1';

  // ── 유틸 ───────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 어떤 직업을 이미 해봤는지 (이 기기에만 저장)
  const TRIED_KEY = 'mafia.triedRoles';
  const loadTried = () => {
    try { return new Set(JSON.parse(localStorage.getItem(TRIED_KEY) || '[]')); }
    catch { return new Set(); }
  };
  const markTried = (roleId) => {
    if (!roleId) return;
    const s = loadTried();
    if (s.has(roleId)) return;
    s.add(roleId);
    localStorage.setItem(TRIED_KEY, JSON.stringify([...s]));
  };

  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, 2600);
  }

  function emit(ev, data) {
    return new Promise((resolve) => socket.emit(ev, data, (res) => resolve(res || { ok: false })));
  }

  const TEAM_LABEL = { MAFIA: '마피아', CITIZEN: '시민', NEUTRAL: '중립' };

  // 직업 아이콘. id 로도, 이름으로도 찾을 수 있게 둘 다 넣어둔다.
  // (남의 직업은 이름만 내려오는 경우가 있다)
  const ROLE_ICONS = {
    // 마피아
    mafia: '🕴️', 마피아: '🕴️',
    sniper: '🎯', 저격수: '🎯',
    rigger: '🗳️', 부정선거자: '🗳️',
    chairman: '💼', 회장: '💼',
    independent_mafia: '🏴', '무소속당 (마피아)': '🏴',
    triplet_mafia: '👶', '삼둥이 (마피아)': '👶',
    converted_mafia: '🤝', '포섭된 마피아': '🤝',
    // 시민
    citizen: '🧍', 시민: '🧍',
    police: '👮', 경찰: '👮',
    guardian: '🛡️', 수호자: '🛡️',
    detective: '🔍', 탐정: '🔍',
    gymrat: '💪', 헬창: '💪',
    soldier: '🔫', 군인: '🔫',
    politician: '🏛️', 정치인: '🏛️',
    reporter: '📰', 기자: '📰',
    independent_citizen: '🏳️', '무소속당 (시민)': '🏳️',
    lunatic: '🌀', 정신병자: '🌀',
    triplet_citizen: '👶', '삼둥이 (시민)': '👶',
    // 중립
    jindo: '🐕', 진돗개: '🐕',
    attention: '📣', 관종: '📣',
    serial_killer: '🔪', 연쇄살인마: '🔪',
    clown: '🤡', 삐에로: '🤡',
    triplet_neutral: '👶', '삼둥이 (셋째)': '👶',
    // 형제끼리는 순번 없이 「삼둥이」로만 보인다
    삼둥이: '👶',
  };
  const icon = (key) => ROLE_ICONS[key] || '❔';
  const PHASE_LABEL = {
    LOBBY: '대기실', SEATING: '자리 정하기', ROLE_REVEAL: '직업 확인',
    NIGHT: '밤', DAWN: '아침', DISCUSS: '토론', VOTE: '투표',
    EXECUTION: '투표 결과', END: '게임 종료',
  };

  function fmtLeft(deadline) {
    if (!deadline) return '';
    const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  // ── 오디오 게이트 ──────────────────────────────────────────
  document.getElementById('audio-gate-btn').addEventListener('click', () => {
    Narrator.unlock();
    $gate.hidden = true;
  });
  function maybeShowGate() {
    $gate.hidden = Narrator.isUnlocked() || screen !== 'room';
  }

  // ── 소켓 ───────────────────────────────────────────────────
  socket.on('connect', async () => {
    connected = true;
    const sess = LS.load();
    if (sess?.roomCode && sess?.playerId) {
      const res = await emit('room:join', {
        roomCode: sess.roomCode, playerId: sess.playerId, nickname: sess.nickname,
      });
      if (res.ok) { screen = 'room'; }
      else { LS.clear(); screen = 'home'; render(); }
    } else {
      render();
    }
  });

  socket.on('disconnect', () => { connected = false; render(); });

  socket.on('state', (state) => {
    const phaseChanged = S?.room?.phase !== state.room.phase;
    S = state;
    screen = 'room';
    // 어떤 직업을 해봤는지 기록해둔다 (정신병자는 진짜 직업이 밝혀질 때 다시 기록된다)
    if (S.room.phase === 'ROLE_REVEAL' && S.you?.role) markTried(S.you.role.id);
    if (S.room.phase === 'END' && S.result) {
      const me = S.result.roles.find((r) => r.id === S.you?.id);
      if (me) markTried(me.roleId);
    }
    if (phaseChanged) {
      revealed = false;
      pairPick = [];
      nightMode = 'KILL';
      snipeTarget = null;
      snipeRole = null;
      dayPanel = null;
    }
    render();
  });

  socket.on('cue', ({ seq, cues, phase, day }) => {
    if (seq <= lastSeq) return;
    lastSeq = seq;
    // 단계가 바뀌면 이전 단계의 음성은 버린다 (밤 안내가 아침까지 흘러나오지 않도록)
    Narrator.push(cues, phase ? `${phase}:${day}` : null);
  });

  // ── 렌더 ───────────────────────────────────────────────────
  /** 헤더 / 본문 / 하단을 고정하고 본문만 스크롤시킨다 */
  const shell = (head, main, foot, extra = '') => `
    ${head ? `<div class="app-head">${head}</div>` : ''}
    <div class="app-main">${main}</div>
    ${foot ? `<div class="app-foot">${foot}</div>` : ''}
    ${extra}`;

  function render() {
    $app.innerHTML = screen === 'home' ? viewHome() : viewRoom();
    maybeShowGate();
  }

  setInterval(() => {
    const t = document.querySelector('[data-timer]');
    if (t && S?.room?.deadline) t.textContent = fmtLeft(S.room.deadline);
  }, 500);

  // ── 홈 ─────────────────────────────────────────────────────
  function viewHome() {
    return shell('', viewHomeBody(), '');
  }

  function viewHomeBody() {
    return `
      <div style="padding-top:10vh">
        <h1 class="center">마피아</h1>
        <p class="center dim small" style="margin-bottom:26px">
          둥글게 앉아서 하는 오프라인 마피아<br/>한쪽 이어폰을 끼고 진행하세요
        </p>

        ${joinCode ? `
          <div class="card center">
            <div class="dim small">초대받은 방</div>
            <div class="code mono" style="font-size:30px;letter-spacing:.2em">${esc(joinCode)}</div>
          </div>` : ''}

        <div class="card">
          <input type="text" id="nick" placeholder="닉네임 (최대 12자)" maxlength="12"
                 value="${esc(nickname)}" autocomplete="off" />
          ${joinCode
            ? `<button class="btn btn-primary" data-action="join">${esc(joinCode)} 방 입장</button>
               <button class="btn btn-ghost" data-action="clear-code">다른 방 / 새 방 만들기</button>`
            : `<button class="btn btn-primary" data-action="create">방 만들기</button>
               <div class="row" style="margin-top:12px">
                 <input type="text" id="code" placeholder="방 코드 4자리" maxlength="4"
                        style="text-transform:uppercase" autocomplete="off" />
                 <button class="btn btn-sm" data-action="join-code" style="white-space:nowrap">입장</button>
               </div>`}
        </div>

        <p class="center small dim">${connected ? '' : '서버 연결 중…'}</p>
      </div>`;
  }

  // ── 방 ─────────────────────────────────────────────────────
  function viewRoom() {
    if (!S) return '<div class="boot">불러오는 중…</div>';
    const { room, you } = S;
    const body = {
      LOBBY: viewLobby, SEATING: viewSeating, ROLE_REVEAL: viewRoleReveal,
      NIGHT: viewNight, DAWN: viewDawn, DISCUSS: viewDiscuss,
      VOTE: viewVote, EXECUTION: viewExecution, END: viewEnd,
    }[room.phase] || (() => '');

    const inGame = !['LOBBY', 'SEATING'].includes(room.phase);
    const aliveCount = S.players.filter((p) => p.alive).length;
    const myRole = you?.role;

    const head = `
      <div class="topbar">
        <div data-action="code-tap" style="cursor:pointer">
          <div class="code mono">${esc(room.code)}</div>
          <div class="small dim">${inGame ? `${room.day}일차 · 생존 ${aliveCount}/${room.playerCount}`
                                          : `${room.playerCount}명`}</div>
        </div>
        <div class="center">
          <span class="phase-pill phase-${room.phase}">${PHASE_LABEL[room.phase] || room.phase}</span>
          ${room.deadline ? `<div class="timer" data-timer>${fmtLeft(room.deadline)}</div>` : ''}
        </div>
      </div>

      ${inGame && myRole ? `
        <div class="mybar ${you.alive ? '' : 'is-dead'}">
          <span class="mybar-icon">${icon(myRole.id)}</span>
          <span class="mybar-name">${esc(myRole.name)}</span>
          <span class="rteam team-${myRole.team}">${TEAM_LABEL[myRole.team]}</span>
          ${you.seat ? `<span class="mybar-seat">${you.seat}번</span>` : ''}
          ${you.alive ? '' : '<span class="mybar-dead">사망 · 관전</span>'}
        </div>` : ''}
      ${room.phase === 'LOBBY' ? `
        <div class="segbar">
          <button class="${lobbyTab === 'players' ? 'on' : ''}" data-action="lobby-tab" data-tab="players">
            참가자 ${room.playerCount}</button>
          ${you?.isHost ? `
            <button class="${lobbyTab === 'roles' ? 'on' : ''}" data-action="lobby-tab" data-tab="roles">
              편성 ${room.config.compositionMode === 'counts'
                ? (() => { const c = room.config.teamCounts || {};
                    return (c.mafia || 0) + (c.citizen || 0) + (c.neutral || 0); })()
                : room.config.roles.length}/${room.playerCount}</button>
            <button class="${lobbyTab === 'settings' ? 'on' : ''}" data-action="lobby-tab" data-tab="settings">
              설정</button>` : ''}
        </div>` : ''}`;

    const foot = `
      ${viewHostControls()}
      <p class="foot-links dim">
        <a href="#" data-action="leave" class="dim">방 나가기</a>
        · <a href="#" data-action="mute" class="dim">${Narrator.isMuted() ? '소리 켜기' : '소리 끄기'}</a>
      </p>`;

    return shell(head, `${body()}${viewInfoLog()}`, foot, viewDrawer());
  }

  /** 오른쪽에서 열리는 참고 탭 — 직업 설명과 기록을 여기에 몰아넣는다 */
  function viewDrawer() {
    const inLobby = S?.room?.phase === 'LOBBY';
    // 대기실에서는 전체 직업 도감을, 게임 중에는 이번 판 라인업을 보여준다
    const hasLineup = inLobby ? !!S?.catalog?.length : !!S?.lineup?.length;
    const hasLog = !inLobby && !!S?.publicLog?.length;
    if (!hasLineup && !hasLog) return '';

    const tab = (!hasLineup && drawerTab === 'roles') ? 'log' : drawerTab;
    return `
      <button class="drawer-tab" data-action="open-drawer" aria-label="직업 설명 열기">
        <span>📖</span><span class="drawer-tab-label">${inLobby ? '도감' : '직업'}</span>
      </button>
      <div class="drawer-scrim ${drawerOpen ? 'on' : ''}" data-action="close-drawer"></div>
      <aside class="drawer ${drawerOpen ? 'on' : ''}">
        <div class="drawer-head">
          <div class="drawer-tabs">
            ${hasLineup ? `<button class="${tab === 'roles' ? 'on' : ''}"
              data-action="drawer-tab" data-tab="roles">직업</button>` : ''}
            ${hasLog ? `<button class="${tab === 'log' ? 'on' : ''}"
              data-action="drawer-tab" data-tab="log">기록</button>` : ''}
          </div>
          <button class="drawer-close" data-action="close-drawer" aria-label="닫기">✕</button>
        </div>
        <div class="drawer-body">
          ${tab === 'roles' ? (inLobby ? viewRoleBook() : viewLineup()) : viewPublicLog()}
        </div>
      </aside>`;
  }

  function viewLobby() {
    const { room, you } = S;
    const isHost = you?.isHost;
    const counts = {};
    for (const r of room.config.roles) counts[r] = (counts[r] || 0) + 1;

    // 방장이 아니면 탭이 없으므로 참가자 화면만 보여준다
    const tab = isHost ? lobbyTab : 'players';
    if (tab === 'roles') {
      return room.config.compositionMode === 'counts'
        ? viewCountSetup()
        : viewRoleSetup(counts) + viewRolePicker();
    }
    if (tab === 'settings') return viewLobbySettings();
    return viewLobbyPlayers();
  }

  function viewLobbyPlayers() {
    const { room, you, players } = S;
    const isHost = you?.isHost;
    return `
      ${isHost && room.qr ? `
        <div class="card qr-wrap">
          <img src="${room.qr}" alt="방 입장 QR" />
          <div class="small dim">이 QR을 찍으면 바로 입장합니다</div>
        </div>` : ''}

      <div class="card">
        <div class="spread">
          <h2 style="margin:0">참가자 ${players.length}명
            ${room.botCount ? `<span class="dim small">(봇 ${room.botCount})</span>` : ''}</h2>
        </div>
        <div class="plist" style="margin-top:10px">
          ${players.map((p) => `
            <div class="pitem ${p.isYou ? 'you' : ''}">
              <div class="seatno">${p.isHost ? '👑' : (p.isBot ? '🤖' : '·')}</div>
              <div class="name">${esc(p.nickname)}${p.isYou ? ' <span class="tag">(나)</span>' : ''}</div>
              ${p.isBot && isHost
                ? `<button class="btn btn-sm btn-ghost" data-action="remove-bot" data-id="${p.id}"
                     style="margin:0;padding:4px 10px">빼기</button>`
                : ''}
              ${p.connected || p.isBot ? '' : '<span class="offline">오프라인</span>'}
            </div>`).join('')}
        </div>
        ${isHost ? `
          <div class="row" style="margin-top:12px">
            <button class="btn btn-sm" data-action="add-bot" data-count="1" style="flex:1;margin:0">🤖 봇 +1</button>
            <button class="btn btn-sm" data-action="add-bot" data-count="3" style="flex:1;margin:0">+3</button>
            <button class="btn btn-sm" data-action="add-bot" data-count="7" style="flex:1;margin:0">+7</button>
            ${room.botCount ? `<button class="btn btn-sm btn-ghost" data-action="remove-bot"
                                 style="flex:1;margin:0">−1</button>` : ''}
          </div>
          <p class="small dim" style="margin:8px 0 0">
            봇은 자리 선택·밤 능력·투표를 알아서 합니다. 혼자 규칙을 확인할 때 쓰세요.
          </p>` : ''}
      </div>
      ${isHost ? '' : `
        <div class="card center dim small">방장이 직업을 편성하고 있습니다. 잠시만 기다려 주세요.</div>`}
    `;
  }

  /**
   * 직업 체험 — 원하는 직업을 찜해두면 게임 시작 시 그 직업을 받는다.
   * 일반 플레이에서는 보이면 안 되므로 개발자 모드에서만 노출한다.
   * (방 코드를 다섯 번 두드리면 열린다)
   */
  function viewRolePicker() {
    const { room, catalog, you } = S;
    if (!catalog || !isDev()) return '';
    const mine = room.config.pinnedRoles?.[you.id] ?? null;
    const tried = loadTried();
    const usable = catalog.filter((r) => r.implemented);
    const byTeam = { MAFIA: [], CITIZEN: [], NEUTRAL: [] };
    for (const r of usable) byTeam[r.team].push(r);

    const chip = (r) => {
      const locked = r.minPlayers > room.playerCount;
      const on = mine === r.id;
      return `<button class="rolechip ${on ? 'on' : ''} ${tried.has(r.id) ? 'done' : ''}"
        data-action="pin-role" data-id="${r.id}" ${locked ? 'disabled' : ''}
        title="${esc(r.desc)}">${icon(r.id)} ${tried.has(r.id) ? '✓ ' : ''}${esc(r.name)}${
          locked ? ` <span class="dim">${r.minPlayers}인+</span>` : ''}</button>`;
    };

    return `
      <div class="card">
        <div class="spread">
          <h2 style="margin:0">🧪 직업 체험 <span class="badge">개발자</span></h2>
          <span class="small dim">${tried.size} / ${usable.length} 해봄</span>
        </div>
        <p class="small dim" style="margin:6px 0 10px">
          받고 싶은 직업을 누르면 <b>게임 시작 때 그 직업을 받습니다.</b>
          편성표에 없으면 자동으로 넣어줍니다. 봇을 채우고 하나씩 눌러보세요.
        </p>
        ${mine ? `<div class="info-item">이번 판에 받을 직업:
          <b>${esc(usable.find((r) => r.id === mine)?.name ?? mine)}</b>
          <button class="btn btn-sm btn-ghost" data-action="pin-role" data-id=""
            style="margin:6px 0 0;padding:4px 10px">고정 해제</button></div>` : ''}
        <h3>마피아</h3><div class="chips">${byTeam.MAFIA.map(chip).join('')}</div>
        <h3>시민</h3><div class="chips">${byTeam.CITIZEN.map(chip).join('')}</div>
        <h3>중립</h3><div class="chips">${byTeam.NEUTRAL.map(chip).join('')}</div>
        <div class="row" style="margin-top:10px">
          ${tried.size ? `<button class="btn btn-sm btn-ghost" data-action="clear-tried"
            style="margin:0">체험 기록 지우기</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-action="dev-off" style="margin:0">개발자 옵션 끄기</button>
        </div>
      </div>`;
  }

  function viewRoleSetup(counts) {
    const { room, catalog } = S;
    const total = room.config.roles.length;
    const n = room.playerCount;
    const groups = { MAFIA: [], CITIZEN: [], NEUTRAL: [] };
    for (const r of catalog || []) groups[r.team].push(r);

    const rec = S.recommend || { mafia: 0, citizen: 0, neutral: 0 };
    const teamCount = { MAFIA: 0, CITIZEN: 0, NEUTRAL: 0 };
    for (const [id, c] of Object.entries(counts)) {
      const r = (catalog || []).find((x) => x.id === id);
      if (r) teamCount[r.team] += c;
    }

    const rowsFor = (team) => groups[team].map((r) => {
      const c = counts[r.id] || 0;
      const locked = !r.implemented || (r.minPlayers > n);
      return `
        <div class="rolerow ${locked ? 'off' : ''}">
          <div class="rn">${icon(r.id)} ${esc(r.name)}
            ${!r.implemented ? '<span class="badge">준비중</span>' : ''}
            ${r.minPlayers > 0 ? `<span class="badge">${r.minPlayers}인+</span>` : ''}
          </div>
          <div class="stepper">
            <button data-action="role-dec" data-role="${r.id}" ${c === 0 ? 'disabled' : ''}>−</button>
            <div class="cnt">${c}</div>
            <button data-action="role-inc" data-role="${r.id}"
              ${locked || total >= n || (r.unique && c >= 1) ? 'disabled' : ''}>+</button>
          </div>
        </div>`;
    }).join('');

    const v = validateLocal();
    const chosen = Object.entries(counts).filter(([, c]) => c > 0);

    return `
      <div class="card">
        <div class="spread">
          <h2 style="margin:0">편성 <span class="dim small">${total} / ${n}</span></h2>
          <button class="btn btn-sm" data-action="auto-roles" style="margin:0">자동 편성</button>
        </div>
        <div class="small" style="margin:6px 0 10px">
          <b class="${teamCount.MAFIA === rec.mafia ? '' : 'off-rec'}">마피아 ${teamCount.MAFIA}</b> ·
          <b class="${teamCount.CITIZEN === rec.citizen ? '' : 'off-rec'}">시민 ${teamCount.CITIZEN}</b> ·
          <b class="${teamCount.NEUTRAL === rec.neutral ? '' : 'off-rec'}">중립 ${teamCount.NEUTRAL}</b>
          <span class="dim"> · ${n}인 권장 ${rec.mafia}/${rec.citizen}/${rec.neutral}</span>
        </div>

        <div class="chips">
          ${chosen.length
            ? chosen.map(([id, c]) => {
                const r = (catalog || []).find((x) => x.id === id);
                return `<button class="rolechip on" data-action="role-dec" data-role="${id}"
                  title="눌러서 빼기">${icon(id)} ${esc(r?.name ?? id)}${c > 1 ? ` ×${c}` : ''} ✕</button>`;
              }).join('')
            : '<span class="small dim">아직 아무 직업도 없습니다.</span>'}
        </div>

        <button class="btn btn-sm btn-ghost" data-action="toggle-picker" style="margin-top:10px">
          ${rolePickerOpen ? '직업 목록 접기' : '＋ 직업 추가'}
        </button>
        <button class="btn btn-sm btn-ghost" data-action="comp-mode" data-mode="counts">
          ← 인원수만 정하기
        </button>

        ${rolePickerOpen ? `
          <h3>마피아</h3>${rowsFor('MAFIA')}
          <h3>시민</h3>${rowsFor('CITIZEN')}
          <h3>중립</h3>${rowsFor('NEUTRAL')}` : ''}
      </div>

      ${v.errors.length ? `<div class="card errors">${v.errors.map((e) => `<div>· ${esc(e)}</div>`).join('')}</div>` : ''}
    `;
  }

  /** 편성 탭 — 진영별 인원수만 정하는 모드 */
  function viewCountSetup() {
    const { room } = S;
    const n = room.playerCount;
    const rec = S.recommend || { mafia: 0, citizen: 0, neutral: 0 };
    const c = room.config.teamCounts || { mafia: 0, citizen: 0, neutral: 0 };
    const total = c.mafia + c.citizen + c.neutral;
    const v = validateLocal();

    const row = (key, label, ico, value, hint) => `
      <div class="rolerow" style="padding:10px">
        <span class="lineup-icon">${ico}</span>
        <div class="rn">${label}<div class="small dim">${hint}</div></div>
        <div class="stepper">
          <button data-action="count-dec" data-key="${key}" ${value <= 0 ? 'disabled' : ''}>−</button>
          <div class="cnt">${value}</div>
          <button data-action="count-inc" data-key="${key}" ${total >= n ? 'disabled' : ''}>+</button>
        </div>
      </div>`;

    return `
      <div class="card">
        <div class="spread">
          <h2 style="margin:0">진영 인원 <span class="dim small">${total} / ${n}</span></h2>
          <button class="btn btn-sm" data-action="count-auto" style="margin:0">권장값</button>
        </div>
        <p class="small dim" style="margin:6px 0 10px">
          인원수만 정하면 <b>어떤 직업이 들어갈지는 시작할 때 무작위로 정해집니다.</b>
          ${n}인 권장 — 마피아 ${rec.mafia} · 시민 ${rec.citizen} · 중립 ${rec.neutral}
        </p>
        ${row('mafia', '마피아', '🕴️', c.mafia, '밤에 진영 전체가 한 명을 죽입니다')}
        ${row('citizen', '시민', '🧍', c.citizen, '능력으로 마피아를 찾아냅니다')}
        ${row('neutral', '중립', '🃏', c.neutral, '각자의 특수 조건으로 승리합니다')}

        <label class="row small" style="margin-top:12px">
          <input type="checkbox" id="cfg-hidden" ${room.config.hiddenLineup ? 'checked' : ''}
                 data-action="toggle-hidden" style="width:auto;margin:0" />
          <span>🎲 <b>직업 비공개</b> — 어떤 직업이 들어 있는지 게임이 끝날 때까지 아무도 모름</span>
        </label>
        <p class="small dim" style="margin:6px 0 0">
          켜면 탐정의 2지선다와 저격수의 선택지도 전체 직업에서 나옵니다. 난이도가 확 올라갑니다.
        </p>

        <button class="btn btn-sm btn-ghost" data-action="comp-mode" data-mode="manual"
                style="margin-top:12px">직업을 직접 고르기 →</button>
      </div>

      ${v.errors.length ? `<div class="card errors">${v.errors.map((e) => `<div>· ${esc(e)}</div>`).join('')}</div>` : ''}
    `;
  }

  /** 대기실 「설정」 탭 */
  function viewLobbySettings() {
    const { room } = S;
    return `
      <div class="card">
        <h2>진행 설정</h2>
        <div class="row" style="margin-bottom:10px">
          <label class="small dim" style="flex:1">토론 시간(초)</label>
          <input type="number" id="cfg-discuss" value="${room.config.discussSeconds}" style="width:96px;margin:0" />
        </div>
        <div class="row" style="margin-bottom:10px">
          <label class="small dim" style="flex:1">투표 시간(초)</label>
          <input type="number" id="cfg-vote" value="${room.config.voteSeconds}" style="width:96px;margin:0" />
        </div>
        <div class="row" style="margin-bottom:10px">
          <label class="small dim" style="flex:1">밤 시간(초)</label>
          <input type="number" id="cfg-night" value="${room.config.nightSeconds}" style="width:96px;margin:0" />
        </div>
        <div class="row" style="margin-bottom:10px">
          <label class="small dim" style="flex:1">최대 진행 일수</label>
          <input type="number" id="cfg-maxdays" value="${room.config.maxDays}" style="width:96px;margin:0" />
        </div>
        <label class="row small" style="margin-bottom:8px">
          <input type="checkbox" id="cfg-timeout" ${room.config.maxDaysWinner === 'CITIZEN' ? 'checked' : ''}
                 style="width:auto;margin:0" />
          <span>제한 일수를 넘기면 시민 진영 승리 (끄면 무승부)</span>
        </label>
        <label class="row small" style="margin-bottom:8px">
          <input type="checkbox" id="cfg-auto" ${room.config.autoAdvance ? 'checked' : ''}
                 style="width:auto;margin:0" />
          <span>자동 진행 — 방장이 버튼을 누르지 않아도 단계가 넘어감 (혼자 테스트할 때)</span>
        </label>
        <label class="row small" style="margin-bottom:8px">
          <input type="checkbox" id="cfg-open" ${room.config.openVoting ? 'checked' : ''}
                 style="width:auto;margin:0" />
          <span>공개 투표 — 투표 중에도 누가 누구에게 몇 표를 줬는지 보임</span>
        </label>
        <label class="row small" style="margin-bottom:8px">
          <input type="checkbox" id="cfg-lineup" ${room.config.showRoleList ? 'checked' : ''}
                 style="width:auto;margin:0" />
          <span>게임 중 이번 판 직업 목록과 능력 설명 보기</span>
        </label>
        <label class="row small" style="margin-bottom:8px">
          <input type="checkbox" id="cfg-adj" ${room.config.adjacencySkipsDead ? 'checked' : ''}
                 style="width:auto;margin:0" />
          <span>죽은 사람은 원에서 빠짐 (양옆 = 다음 생존자)</span>
        </label>
        <label class="row small" style="margin-bottom:8px">
          <input type="checkbox" id="cfg-tie" ${room.config.tieMeansNoExecution ? 'checked' : ''}
                 style="width:auto;margin:0" />
          <span>동표면 아무도 처형하지 않음</span>
        </label>
        <label class="row small" style="margin-bottom:8px">
          <input type="checkbox" id="cfg-shared" ${room.config.mafiaSharedKill ? 'checked' : ''}
                 style="width:auto;margin:0" />
          <span>마피아는 밤에 한 명만 죽임 (끄면 각자 독립적으로 죽임)</span>
        </label>
        <label class="row small">
          <input type="checkbox" id="cfg-strict" ${room.config.strictNeutralElimination ? 'checked' : ''}
                 style="width:auto;margin:0" />
          <span>중립을 전원 제거해야 진영 승리 (끄면 연쇄살인마만 승리를 막음)</span>
        </label>
        <button class="btn btn-sm" data-action="save-cfg" style="margin-top:12px">설정 저장</button>
      </div>`;
  }

  function validateLocal() {
    const { room, catalog } = S;
    const n = room.playerCount;
    const errors = [];

    // 인원수 편성 모드는 진영별 합계만 본다
    if (room.config.compositionMode === 'counts') {
      const c = room.config.teamCounts || { mafia: 0, citizen: 0, neutral: 0 };
      const total = c.mafia + c.citizen + c.neutral;
      if (n < 4) errors.push('최소 4명이 필요합니다.');
      if (total !== n) errors.push(`진영 인원 합계 ${total}명 / 참가자 ${n}명 — 개수를 맞추세요.`);
      if (c.mafia < 1) errors.push('마피아가 최소 1명은 있어야 합니다.');
      else if (c.mafia * 2 >= n) errors.push('마피아가 처음부터 과반입니다.');
      if (c.citizen < 1) errors.push('시민이 최소 1명은 있어야 합니다.');
      if (c.neutral > c.mafia) errors.push('중립은 마피아보다 많을 수 없습니다.');
      return { ok: errors.length === 0, errors };
    }

    const roles = room.config.roles;
    if (n < 4) errors.push('최소 4명이 필요합니다.');
    if (roles.length !== n) errors.push(`직업 ${roles.length}개 / 참가자 ${n}명 — 개수를 맞추세요.`);
    let mafia = 0;
    for (const id of roles) {
      const r = (catalog || []).find((x) => x.id === id);
      if (r?.team === 'MAFIA') mafia++;
    }
    if (roles.length === n) {
      if (mafia === 0) errors.push('마피아가 최소 1명은 있어야 합니다.');
      else if (mafia * 2 >= n) errors.push('마피아가 처음부터 과반입니다.');
    }
    return { ok: errors.length === 0, errors };
  }

  function viewSeating() {
    const { seats, players, you } = S;
    const n = seats.total;
    const R = 42; // % 반지름
    const nodes = [];
    for (let i = 1; i <= n; i++) {
      const angle = (-90 + (360 / n) * (i - 1)) * (Math.PI / 180);
      const x = 50 + R * Math.cos(angle);
      const y = 50 + R * Math.sin(angle);
      const ownerId = seats.taken[i];
      const owner = players.find((p) => p.id === ownerId);
      const mine = owner?.isYou;
      nodes.push(`
        <button class="seat ${owner ? (mine ? 'mine' : 'taken') : ''}"
                style="left:${x}%;top:${y}%"
                data-action="seat" data-seat="${i}" ${owner && !mine ? 'disabled' : ''}>
          ${i}${owner ? `<small>${esc(owner.nickname.slice(0, 4))}</small>` : ''}
        </button>`);
    }

    return `
      <div class="card">
        <h2>자기 자리를 고르세요</h2>
        <p class="small dim">실제로 둥글게 앉은 순서 그대로 번호를 정하세요. 마피아의 「양옆」이 이 번호 기준입니다.</p>
        <div class="circle">
          <div class="hint">${you?.seat ? `${you.seat}번 자리` : '자리를 탭하세요'}</div>
          ${nodes.join('')}
        </div>
        <div class="small dim center">
          ${players.filter((p) => p.seat != null).length} / ${n} 명 착석
        </div>
      </div>`;
  }

  function viewRoleReveal() {
    const { you, players, startPending } = S;
    if (!you?.role) return '<div class="card center dim">직업 배정 중…</div>';

    const tripletNote = you.tripletOrder
      ? `<div class="info-item">당신은 삼둥이 <b>${['첫째', '둘째', '셋째'][you.tripletOrder - 1]}</b> 입니다.
         ${you.tripletOrder === 3
           ? '다른 두 형제는 당신을 모릅니다. 밤마다 그들을 지목해 맞히면 단독 승리합니다.'
           : '당신보다 순번이 뒤인 형제가 살아 있는 동안에는 죽지 않습니다.'}</div>`
      : '';

    const startBlock = you.startAction ? `
      <div class="card">
        <h2>${esc(you.startAction.prompt)}</h2>
        <div class="plist" style="margin-top:10px">
          ${players.filter((p) => you.startTargets.includes(p.id)).map((p) => `
            <div class="pitem" data-action="start-target" data-id="${p.id}">
              <div class="seatno">${p.seat ?? '?'}</div>
              <div class="name">${esc(p.nickname)}</div>
            </div>`).join('')}
        </div>
      </div>` : '';

    return `
      <div class="card role-card">
        <div class="${revealed ? '' : 'hidden-role'}">
          <div class="ricon">${icon(you.role.id)}</div>
          <div class="rname">${esc(you.role.name)}</div>
          <div class="rteam team-${you.role.team}">${TEAM_LABEL[you.role.team]}</div>
          <div class="rdesc">${esc(you.role.desc)}</div>
        </div>
        ${!revealed ? `<button class="btn btn-primary" data-action="reveal" style="margin-top:16px">
          내 직업 보기 (주변 조심)</button>` : ''}
      </div>
      ${revealed ? tripletNote : ''}
      ${startBlock}
      <div class="card small dim">
        자리: <b>${you.seat}번</b> · 화면을 남에게 보이지 마세요.
        ${startPending ? `<br/>아직 시작 능력을 사용하지 않은 사람이 ${startPending}명 있습니다.` : ''}
      </div>`;
  }

  function viewNight() {
    const { you, players, nightProgress } = S;
    if (!you?.alive) {
      return `<div class="night-veil"><div class="eye">🌙</div><div>밤입니다. 관전 중.</div></div>`;
    }
    if (!you.canAct && !you.submittedAction) {
      return `
        <div class="night-veil">
          <div class="eye">😴</div>
          <div class="big-note">눈을 감고 기다리세요</div>
          <div class="small dim">${nightProgress ? `${nightProgress.done} / ${nightProgress.total} 명 행동 완료` : ''}</div>
        </div>`;
    }
    if (you.submittedAction) {
      return `
        <div class="night-veil">
          <div class="eye">✅</div>
          <div class="big-note">행동 완료</div>
          <div class="small dim">${nightProgress ? `${nightProgress.done} / ${nightProgress.total} 명 행동 완료` : ''}</div>
        </div>
        ${viewMafiaPicks()}`;
    }

    // 삐에로: 지목 없이 발동만
    if (you.actionNoTarget) {
      return `
        <div class="card">
          <div class="rteam team-${you.role.team}">${esc(you.role.name)}</div>
          <h2>${esc(you.actionPrompt)}</h2>
          <p class="small dim">가짜 총성을 낸 다음 날 투표로 누군가 처형되면 1점.
             현재 ${you.clownCredits} / 3 점.</p>
          <button class="btn btn-primary" data-action="night-fire">가짜 총성 발사</button>
          <button class="btn btn-ghost" data-action="night-pass">이번 밤은 넘기기</button>
        </div>`;
    }

    const targets = you.actionTargets;
    const modeBar = you.actionModes ? `
      <div class="row" style="margin:8px 0 4px">
        <button class="btn btn-sm ${nightMode === 'KILL' ? 'btn-primary' : ''}"
                data-action="night-mode" data-mode="KILL">죽이기</button>
        <button class="btn btn-sm ${nightMode === 'CONVERT' ? 'btn-primary' : ''}"
                data-action="night-mode" data-mode="CONVERT" ${you.convertUsed ? 'disabled' : ''}>
          포섭 ${you.convertUsed ? '(사용함)' : '(1회)'}</button>
      </div>` : '';

    const pairBar = you.actionPair ? `
      <p class="small dim">두 명을 고르세요. 선택: ${
        pairPick.length
          ? pairPick.map((id) => {
              const p = players.find((x) => x.id === id);
              return `${p.seat}번 ${esc(p.nickname)}`;
            }).join(', ')
          : '없음'}</p>` : '';

    return `
      <div class="card">
        <div class="rteam team-${you.role.team}">${esc(you.role.name)}</div>
        <h2>${esc(you.actionPrompt || '능력을 사용하세요')}</h2>
        ${modeBar}
        ${pairBar}
        <div class="plist" style="margin-top:10px">
          ${players.filter((p) => targets.includes(p.id)).map((p) => `
            <div class="pitem ${pairPick.includes(p.id) ? 'sel' : ''}"
                 data-action="night-target" data-id="${p.id}">
              <div class="seatno">${p.seat ?? '?'}</div>
              <div class="name">${esc(p.nickname)}</div>
              ${p.revealedRole ? `<span class="tag">${esc(p.revealedRole)}</span>` : ''}
            </div>`).join('') || '<div class="dim small">지목할 수 있는 대상이 없습니다.</div>'}
        </div>
        ${you.actionPair ? `<button class="btn btn-primary" data-action="night-pair-submit"
            ${pairPick.length === 2 ? '' : 'disabled'} style="margin-top:10px">이 두 명으로 확정</button>` : ''}
        <button class="btn btn-ghost" data-action="night-pass" style="margin-top:10px">능력 사용 안 함</button>
      </div>
      ${viewMafiaPicks()}`;
  }

  /** 마피아 진영이 밤에 한 명만 죽일 때, 동료들이 지금 누굴 찍었는지 보여준다 */
  function viewMafiaPicks() {
    const { you, players } = S;
    const picks = (you?.mafiaPicks || []).filter((p) => p.byId !== you.id);
    if (!you?.mafiaPicks?.length) return '';
    const name = (id) => {
      const p = players.find((x) => x.id === id);
      return p ? `${p.seat}번 ${esc(p.nickname)}` : '?';
    };
    return `
      <div class="card">
        <h2>동료 지목 현황</h2>
        <p class="small dim">마피아는 밤에 <b>한 명만</b> 죽입니다. 가장 많이 지목된 사람이 대상이 되고,
           갈리면 그중에서 무작위로 정해집니다.</p>
        ${picks.length
          ? picks.map((p) => `<div class="info-item">${name(p.byId)} →
              ${p.targetId ? `<b>${name(p.targetId)}</b>${p.mode === 'CONVERT' ? ' (포섭)' : ''}` : '<span class="dim">사용 안 함</span>'}</div>`).join('')
          : '<div class="small dim">아직 지목한 동료가 없습니다.</div>'}
      </div>`;
  }

  function viewDawn() {
    const { deaths, reveals } = S;
    return `
      <div class="card center">
        <div style="font-size:40px">${deaths.length ? '💀' : '☀️'}</div>
        ${deaths.length
          ? `<div class="big-note">${deaths.map((d) => `${d.seat}번 ${esc(d.nickname)}`).join(', ')} 사망</div>
             <div class="small dim">사망자의 직업은 공개되지 않습니다.</div>`
          : `<div class="big-note">간밤에 아무도 죽지 않았습니다</div>`}
      </div>
      ${reveals?.length ? `
        <div class="card">
          <h2>📰 기자 특종</h2>
          ${reveals.map((r) => `
            <div class="info-item">${r.seat}번 ${esc(r.nickname)} 의 직업은
              <b>${esc(r.roleName)}</b> 입니다.</div>`).join('')}
        </div>` : ''}`;
  }

  function viewDiscuss() {
    const { players } = S;
    return `
      <div class="card">
        <h2>토론</h2>
        <p class="small dim">시간이 끝나면 자동으로 투표로 넘어갑니다.</p>
        <div class="plist" style="margin-top:10px">
          ${players.map(playerRow).join('')}
        </div>
      </div>`;
  }

  function viewVote() {
    const { you, players, vote } = S;
    const canVote = you?.alive;
    const tally = vote.tally || {};
    const byTarget = {};
    for (const b of vote.ballots || []) {
      if (b.targetId === 'ABSTAIN') continue;
      (byTarget[b.targetId] ||= []).push(b.voterId);
    }
    const nameOf = (id) => {
      const p = players.find((x) => x.id === id);
      return p ? `${p.seat}번 ${esc(p.nickname)}` : '?';
    };
    const top = Math.max(0, ...Object.values(tally));

    return `
      <div class="card">
        <div class="spread">
          <h2 style="margin:0">투표</h2>
          <span class="small dim">${vote.votedCount} / ${vote.totalVoters} 투표${
            vote.open && vote.abstain ? ` · 기권 ${vote.abstain}` : ''}</span>
        </div>
        <p class="small dim">처형할 사람을 고르세요.</p>
        <div class="plist" style="margin-top:10px">
          ${players.map((p) => {
            const n = tally[p.id] || 0;
            const voters = byTarget[p.id] || [];
            return `
            <div class="pitem ${p.alive ? '' : 'dead'} ${you?.votedFor === p.id ? 'sel' : ''} ${canVote && p.alive ? '' : 'disabled'} ${n > 0 && n === top ? 'leading' : ''}"
                 ${canVote && p.alive ? `data-action="vote" data-id="${p.id}"` : ''}>
              <div class="seatno">${p.seat ?? '?'}</div>
              <div class="vcol">
                <div class="vrow">
                  <span class="name">${esc(p.nickname)}${p.isYou ? ' <span class="tag">(나)</span>' : ''}</span>
                  ${p.revealedRole
                    ? `<span class="tag known">${icon(p.revealedRole)} ${esc(p.revealedRole)}</span>` : ''}
                </div>
                ${voters.length
                  ? `<div class="voters">← ${voters.map(nameOf).join(', ')}</div>` : ''}
              </div>
              ${n > 0 ? `<span class="votecount">${n}표</span>` : ''}
            </div>`;
          }).join('')}
        </div>
        ${canVote ? `<button class="btn btn-ghost ${you?.votedFor === 'ABSTAIN' ? 'btn-primary' : ''}"
                       data-action="vote" data-id="ABSTAIN" style="margin-top:10px">기권${
                         vote.open && vote.abstain ? ` (${vote.abstain})` : ''}</button>` : ''}
      </div>
      ${viewDayAbility()}`;
  }

  /** 저격수 / 정치인 — 투표 시간에만 쓰는 능력 */
  function viewDayAbility() {
    const { you, players } = S;
    if (!you?.dayAbility) return '';
    const kind = you.dayAbility.kind;

    if (!dayPanel) {
      return `<div class="card">
        <button class="btn ${kind === 'SNIPE' ? 'btn-danger' : 'btn-primary'}"
                data-action="open-day-panel" data-kind="${kind}">
          ${kind === 'SNIPE' ? '🎯 저격하기 (1회, 틀리면 내가 죽는다)' : '🏛 투표 결과 강제 지정 (1회)'}
        </button>
      </div>`;
    }

    const alive = players.filter((p) => p.alive && !p.isYou);

    if (kind === 'FORCE_VOTE') {
      return `<div class="card">
        <h2>${esc(you.dayAbility.prompt)}</h2>
        <p class="small dim">득표와 상관없이 이 사람이 다수결 지정자가 됩니다. 되돌릴 수 없습니다.</p>
        <div class="plist" style="margin-top:10px">
          ${players.filter((p) => p.alive).map((p) => `
            <div class="pitem" data-action="force-vote" data-id="${p.id}">
              <div class="seatno">${p.seat ?? '?'}</div>
              <div class="name">${esc(p.nickname)}</div>
            </div>`).join('')}
        </div>
        <button class="btn btn-ghost" data-action="close-day-panel" style="margin-top:10px">취소</button>
      </div>`;
    }

    // 저격수
    const target = players.find((p) => p.id === snipeTarget);
    return `<div class="card">
      <h2>${esc(you.dayAbility.prompt)}</h2>
      <h3>1. 대상</h3>
      <div class="plist">
        ${alive.map((p) => `
          <div class="pitem ${snipeTarget === p.id ? 'sel' : ''}" data-action="snipe-target" data-id="${p.id}">
            <div class="seatno">${p.seat ?? '?'}</div>
            <div class="name">${esc(p.nickname)}</div>
          </div>`).join('')}
      </div>
      <h3>2. 그 사람의 직업</h3>
      <div class="tally">
        ${(you.snipeChoices || []).map((c) => `
          <button class="btn btn-sm ${snipeRole === c.key ? 'btn-primary' : ''}"
                  data-action="snipe-role" data-key="${c.key}" style="margin-bottom:6px">${esc(c.name)}</button>`).join('')}
      </div>
      <button class="btn btn-danger" data-action="snipe-fire" style="margin-top:12px"
              ${snipeTarget && snipeRole ? '' : 'disabled'}>
        ${target && snipeRole
          ? `${target.seat}번 ${esc(target.nickname)} 을(를) 「${esc((you.snipeChoices.find((c) => c.key === snipeRole) || {}).name)}」로 저격`
          : '대상과 직업을 모두 고르세요'}
      </button>
      <button class="btn btn-ghost" data-action="close-day-panel">취소</button>
    </div>`;
  }

  function viewExecution() {
    const { deaths, vote, players, survivors } = S;
    const tally = vote?.tally || {};
    const REASON = { VOTE_IMMUNE: '투표로는 죽지 않았습니다', TRIPLET_ORDER: '아직 죽지 않았습니다' };
    return `
      <div class="card center">
        <div style="font-size:40px">${deaths.length ? '⚖️' : '🤝'}</div>
        ${deaths.length
          ? `<div class="big-note">${deaths.map((d) => `${d.seat}번 ${esc(d.nickname)}`).join(', ')} 처형</div>`
          : `<div class="big-note">아무도 처형되지 않았습니다</div>`}
        ${(survivors || []).map((s) => `
          <div class="small dim">${s.seat}번 ${esc(s.nickname)} — ${REASON[s.reason] || '살아남았습니다'}</div>`).join('')}
        <div class="tally">
          ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([id, c]) => {
            const p = players.find((x) => x.id === id);
            return `<span class="badge">${p ? `${p.seat}번 ${esc(p.nickname)}` : '?'} ${c}표</span>`;
          }).join('')}
        </div>
      </div>`;
  }

  function viewEnd() {
    const { result } = S;
    if (!result) return '';
    const winners = result.winners || [];
    const label = winners.length ? `${winners.map((w) => w.label).join(' · ')} 승리` : '무승부';
    return `
      <div class="card center">
        <div style="font-size:40px">${winners.length ? '🏁' : '🤝'}</div>
        <div class="big-note">${esc(label)}</div>
        <div class="small dim">${esc(result.reason)}</div>
      </div>
      <div class="card">
        <h2>전체 직업 공개</h2>
        <div class="plist">
          ${result.roles.slice().sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99)).map((r) => `
            <div class="pitem ${r.alive ? '' : 'dead'}" ${r.won ? 'style="border-color:var(--ok)"' : ''}>
              <div class="seatno">${r.seat ?? '?'}</div>
              <div class="name">${r.won ? '👑 ' : ''}${esc(r.nickname)}
                ${r.tripletOrder ? `<span class="tag">${['첫째', '둘째', '셋째'][r.tripletOrder - 1]}</span>` : ''}
                ${r.fakeRoleName ? `<span class="tag">「${esc(r.fakeRoleName)}」인 줄 알았음</span>` : ''}
              </div>
              <span class="rteam team-${r.team}" style="margin:0;padding:2px 9px;font-size:12px">${icon(r.roleId)} ${esc(r.roleName)}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  function playerRow(p) {
    return `
      <div class="pitem ${p.alive ? '' : 'dead'} ${p.isYou ? 'you' : ''}">
        <div class="seatno">${p.seat ?? '?'}</div>
        <div class="name">${esc(p.nickname)}${p.isYou ? ' <span class="tag">(나)</span>' : ''}</div>
        ${p.revealedRole
          ? `<span class="tag known">${icon(p.revealedRole)} ${esc(p.revealedRole)}</span>` : ''}
        ${p.alive ? '' : '<span class="tag">사망</span>'}
        ${p.connected || p.isBot ? '' : '<span class="offline">오프라인</span>'}
      </div>`;
  }

  function viewInfoLog() {
    const info = S?.you?.info || [];
    if (!info.length) return '';
    return `
      <div class="card">
        <h2>나만 아는 정보</h2>
        ${info.slice().reverse().map((i) => `
          <div class="info-item"><span class="dim small">${i.day}일차 ·</span> ${esc(i.text)}</div>
        `).join('')}
      </div>`;
  }

  /** 대기실용 직업 도감 — 전체 직업 설명. 이번 판에 넣은 직업은 표시해 준다 */
  function viewRoleBook() {
    const { catalog, room } = S;
    if (!catalog?.length) return '';
    // 인원수 편성이거나 비공개 판에서는 어떤 직업이 들어갔는지 표시하지 않는다
    const showPicked = room.config.compositionMode === 'manual' && !room.lineupHidden;
    const counts = {};
    if (showPicked) for (const r of room.config.roles) counts[r] = (counts[r] || 0) + 1;
    const usable = catalog.filter((r) => r.implemented);

    const group = (team, label) => {
      const rows = usable.filter((r) => r.team === team);
      if (!rows.length) return '';
      return `<h3>${label}</h3>` + rows.map((r) => `
        <div class="lineup-row ${showPicked && !counts[r.id] ? 'off' : ''}">
          <div class="lineup-head">
            <span class="lineup-icon">${icon(r.id)}</span>
            <b>${esc(r.name)}</b>
            ${showPicked
              ? (counts[r.id]
                  ? `<span class="tag known">이번 판 ${counts[r.id]}명</span>`
                  : '<span class="tag">미편성</span>')
              : ''}
          </div>
          <div class="small dim lineup-desc">${esc(r.desc)}</div>
        </div>`).join('');
    };

    return `
      <p class="small dim" style="margin:0 0 10px">
        ${showPicked
          ? '전체 직업 설명입니다. 이번 판 편성에 들어간 직업은 「이번 판」으로 표시됩니다.'
          : '전체 직업 설명입니다. 이번 판에 무엇이 들어갈지는 시작할 때 정해집니다.'}
      </p>
      ${group('MAFIA', '마피아')}${group('CITIZEN', '시민')}${group('NEUTRAL', '중립')}`;
  }

  /** 이번 판 직업 라인업과 각 능력 (누가 뭔지는 알려주지 않는다) */
  function viewLineup() {
    const lineup = S?.lineup;
    if (!lineup?.length) return '';
    const group = (team, label) => {
      const rows = lineup.filter((r) => r.team === team);
      if (!rows.length) return '';
      return `<h3>${label} ${rows.reduce((a, r) => a + r.count, 0)}</h3>` + rows.map((r) => `
        <div class="lineup-row">
          <div class="lineup-head">
            <span class="lineup-icon">${icon(r.id)}</span>
            <b>${esc(r.name)}${r.count > 1 ? ` ×${r.count}` : ''}</b>
          </div>
          <div class="small dim lineup-desc">${esc(r.desc)}</div>
        </div>`).join('');
    };
    return `
      <p class="small dim" style="margin:0 0 10px">
        이번 판에 들어 있는 직업 ${lineup.reduce((a, r) => a + r.count, 0)}개입니다.
        누가 무엇인지는 알 수 없습니다.
      </p>
      ${group('MAFIA', '마피아')}${group('CITIZEN', '시민')}${group('NEUTRAL', '중립')}`;
  }

  function viewPublicLog() {
    const log = S?.publicLog || [];
    if (!log.length) return '';
    return `<div class="log">
      ${log.slice().reverse().map((l) => `<div>${esc(l.text)}</div>`).join('')}
    </div>`;
  }

  function viewHostControls() {
    const { room, you } = S;
    if (!you?.isHost) return '';
    switch (room.phase) {
      case 'LOBBY':
        return `<button class="btn btn-primary" data-action="to-seating"
                  ${validateLocal().ok ? '' : 'disabled'}>자리 정하기로 →</button>`;
      case 'SEATING': {
        const allSeated = S.players.every((p) => p.seat != null);
        return `<button class="btn btn-primary" data-action="start" ${allSeated ? '' : 'disabled'}>
                  ${allSeated ? '게임 시작' : '전원 착석 대기 중'}</button>`;
      }
      case 'ROLE_REVEAL':
        return `<button class="btn btn-primary" data-action="next">모두 확인함 · 밤으로 →${
          S.startPending ? ` (미완료 ${S.startPending}명은 무작위 처리)` : ''}</button>`;
      case 'NIGHT':
        return `<button class="btn btn-ghost" data-action="next">밤 강제 종료 →</button>`;
      case 'DAWN':
        return `<button class="btn btn-primary" data-action="next">토론 시작 →</button>`;
      case 'DISCUSS':
        return `<button class="btn btn-primary" data-action="next">투표 시작 →</button>`;
      case 'VOTE':
        return `<button class="btn btn-ghost" data-action="next">투표 마감 →</button>`;
      case 'EXECUTION':
        return `<button class="btn btn-primary" data-action="next">다음 밤으로 →</button>`;
      case 'END':
        return `<button class="btn btn-primary" data-action="reset">대기실로 돌아가기</button>`;
      default:
        return '';
    }
  }

  // ── 이벤트 위임 ────────────────────────────────────────────
  $app.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    e.preventDefault();

    switch (a) {
      case 'create': {
        const nick = document.getElementById('nick').value.trim();
        if (!nick) return toast('닉네임을 입력하세요.');
        Narrator.unlock();
        const res = await emit('room:create', { nickname: nick });
        if (!res.ok) return toast(res.error);
        nickname = nick;
        LS.save({ roomCode: res.roomCode, playerId: res.playerId, nickname: nick });
        screen = 'room';
        history.replaceState({}, '', '/');
        break;
      }
      case 'join-code': {
        const code = document.getElementById('code').value.trim().toUpperCase();
        if (!code) return toast('방 코드를 입력하세요.');
        joinCode = code;
        render();
        break;
      }
      case 'join': {
        const nick = document.getElementById('nick').value.trim();
        if (!nick) return toast('닉네임을 입력하세요.');
        Narrator.unlock();
        const res = await emit('room:join', { roomCode: joinCode, nickname: nick });
        if (!res.ok) return toast(res.error);
        nickname = nick;
        LS.save({ roomCode: res.roomCode, playerId: res.playerId, nickname: nick });
        screen = 'room';
        history.replaceState({}, '', '/');
        break;
      }
      case 'clear-code': {
        joinCode = '';
        history.replaceState({}, '', '/');
        render();
        break;
      }
      case 'role-inc':
      case 'role-dec': {
        const roles = [...S.room.config.roles];
        const id = t.dataset.role;
        if (a === 'role-inc') roles.push(id);
        else { const i = roles.lastIndexOf(id); if (i >= 0) roles.splice(i, 1); }
        S.room.config.roles = roles;
        render();
        const res = await emit('host:config', { patch: { roles } });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'count-inc':
      case 'count-dec': {
        const c = { ...(S.room.config.teamCounts || { mafia: 0, citizen: 0, neutral: 0 }) };
        const k = t.dataset.key;
        c[k] = Math.max(0, (c[k] || 0) + (a === 'count-inc' ? 1 : -1));
        S.room.config.teamCounts = c;
        render();
        const res = await emit('host:config', { patch: { teamCounts: c } });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'count-auto': {
        const rec = S.recommend;
        if (!rec) break;
        const c = { mafia: rec.mafia, citizen: rec.citizen, neutral: rec.neutral };
        S.room.config.teamCounts = c;
        render();
        const res = await emit('host:config', { patch: { teamCounts: c } });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'toggle-hidden': {
        const on = !S.room.config.hiddenLineup;
        const res = await emit('host:config', { patch: { hiddenLineup: on } });
        if (!res.ok) toast(res.error);
        else toast(on ? '직업 비공개로 진행합니다.' : '직업 목록을 공개합니다.');
        break;
      }
      case 'comp-mode': {
        const res = await emit('host:config', { patch: { compositionMode: t.dataset.mode } });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'auto-roles': {
        const res = await emit('host:autoRoles', {});
        if (!res.ok) toast(res.error);
        break;
      }
      case 'code-tap': {
        if (isDev()) break;
        codeTaps += 1;
        if (codeTaps >= 5) {
          localStorage.setItem(DEV_KEY, '1');
          codeTaps = 0;
          toast('개발자 옵션이 열렸습니다. 대기실에서 직업 체험을 쓸 수 있습니다.');
          render();
        }
        break;
      }
      case 'dev-off': {
        localStorage.removeItem(DEV_KEY);
        codeTaps = 0;
        toast('개발자 옵션을 껐습니다.');
        render();
        break;
      }
      case 'lobby-tab': { lobbyTab = t.dataset.tab; render(); break; }
      case 'toggle-picker': { rolePickerOpen = !rolePickerOpen; render(); break; }
      case 'open-drawer': { drawerOpen = true; render(); break; }
      case 'close-drawer': { drawerOpen = false; render(); break; }
      case 'drawer-tab': { drawerTab = t.dataset.tab; render(); break; }
      case 'pin-role': {
        const id = t.dataset.id || null;
        const res = await emit('role:pin', { roleId: id });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'clear-tried': {
        localStorage.removeItem(TRIED_KEY);
        render();
        break;
      }
      case 'add-bot': {
        const res = await emit('host:addBot', { count: +t.dataset.count || 1 });
        if (!res.ok) toast(res.error);
        else if (res.error) toast(`${res.added}명만 추가했습니다. ${res.error}`);
        break;
      }
      case 'remove-bot': {
        const res = await emit('host:removeBot', { botId: t.dataset.id || null });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'save-cfg': {
        const patch = {
          discussSeconds: Math.max(10, +document.getElementById('cfg-discuss').value || 180),
          voteSeconds: Math.max(10, +document.getElementById('cfg-vote').value || 60),
          nightSeconds: Math.max(10, +document.getElementById('cfg-night').value || 45),
          maxDays: Math.max(3, +document.getElementById('cfg-maxdays').value || 20),
          maxDaysWinner: document.getElementById('cfg-timeout').checked ? 'CITIZEN' : 'NONE',
          adjacencySkipsDead: document.getElementById('cfg-adj').checked,
          tieMeansNoExecution: document.getElementById('cfg-tie').checked,
          mafiaSharedKill: document.getElementById('cfg-shared').checked,
          strictNeutralElimination: document.getElementById('cfg-strict').checked,
          autoAdvance: document.getElementById('cfg-auto').checked,
          showRoleList: document.getElementById('cfg-lineup').checked,
          openVoting: document.getElementById('cfg-open').checked,
        };
        const res = await emit('host:config', { patch });
        toast(res.ok ? '설정을 저장했습니다.' : res.error);
        break;
      }
      case 'to-seating': {
        const res = await emit('host:seating', {});
        if (!res.ok) toast(res.error);
        break;
      }
      case 'seat': {
        const res = await emit('seat:claim', { seat: +t.dataset.seat });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'start': {
        const res = await emit('host:start', {});
        if (!res.ok) toast(res.error);
        break;
      }
      case 'reveal': { revealed = true; render(); break; }
      case 'next': { await emit('host:next', {}); break; }
      case 'reset': { await emit('host:reset', {}); break; }
      case 'start-target': {
        const res = await emit('start:action', { targetId: t.dataset.id });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'night-mode': {
        nightMode = t.dataset.mode;
        render();
        break;
      }
      case 'night-target': {
        const id = t.dataset.id;
        if (S.you.actionPair) {
          // 삼둥이 셋째: 두 명을 모을 때까지 로컬에 담아둔다
          if (pairPick.includes(id)) pairPick = pairPick.filter((x) => x !== id);
          else if (pairPick.length < 2) pairPick.push(id);
          else toast('두 명까지만 고를 수 있습니다.');
          render();
          break;
        }
        const res = await emit('night:action', {
          targetId: id,
          mode: S.you.actionModes ? nightMode : undefined,
        });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'night-pair-submit': {
        if (pairPick.length !== 2) return toast('두 명을 골라야 합니다.');
        const res = await emit('night:action', { targetId: pairPick[0], secondId: pairPick[1] });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'night-fire': {
        const res = await emit('night:action', { targetId: 'FIRE' });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'night-pass': {
        const res = await emit('night:action', { targetId: null });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'open-day-panel': { dayPanel = t.dataset.kind; render(); break; }
      case 'close-day-panel': {
        dayPanel = null; snipeTarget = null; snipeRole = null; render(); break;
      }
      case 'snipe-target': { snipeTarget = t.dataset.id; render(); break; }
      case 'snipe-role': { snipeRole = t.dataset.key; render(); break; }
      case 'snipe-fire': {
        if (!confirm('저격은 되돌릴 수 없습니다. 틀리면 당신이 죽습니다. 쏠까요?')) return;
        const res = await emit('day:snipe', { targetId: snipeTarget, roleKey: snipeRole });
        if (!res.ok) toast(res.error);
        else toast(res.hit ? '명중했습니다.' : '빗나갔습니다.');
        dayPanel = null; snipeTarget = null; snipeRole = null;
        break;
      }
      case 'force-vote': {
        if (!confirm('이 사람을 투표 결과로 강제 지정합니다. 되돌릴 수 없습니다.')) return;
        const res = await emit('day:force', { targetId: t.dataset.id });
        if (!res.ok) toast(res.error);
        else toast('투표 결과를 지정했습니다.');
        dayPanel = null;
        break;
      }
      case 'vote': {
        const res = await emit('vote:cast', { targetId: t.dataset.id });
        if (!res.ok) toast(res.error);
        break;
      }
      case 'mute': {
        Narrator.setMuted(!Narrator.isMuted());
        render();
        break;
      }
      case 'leave': {
        if (!confirm('방에서 나갈까요?')) return;
        await emit('room:leave', {});
        LS.clear();
        S = null; screen = 'home'; joinCode = '';
        render();
        break;
      }
    }
  });

  render();
})();
