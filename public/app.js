(() => {
  const socket = io();

  // ---------- state ----------
  let myId = localStorage.getItem('cg_playerId') || null;
  let myName = localStorage.getItem('cg_name') || '';
  let myTeam = localStorage.getItem('cg_team') || '';
  let myPhoto = localStorage.getItem('cg_photo') || null;

  let roster = new Map(); // id -> player
  let myConnections = {}; // toId -> {texts:[]}
  let avatars = new Map(); // id -> avatar object
  let gameState = { status: 'lobby', startTime: null, endsAt: null };
  let currentModalTarget = null;
  let countdownInterval = null;
  let timerInterval = null;

  const ARMY_WORDS = ['צבא', 'צה"ל', 'צהל', 'יחידה', 'גדוד', 'פלוגה', 'מילואים', 'שירות צבאי', 'טירונות', 'קורס קצינים', 'סדיר'];

  // ---------- DOM refs ----------
  const screenOnboarding = document.getElementById('screen-onboarding');
  const screenRoom = document.getElementById('screen-room');
  const joinForm = document.getElementById('join-form');
  const nameInput = document.getElementById('name-input');
  const teamInput = document.getElementById('team-input');
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  const photoPreview = document.getElementById('photo-preview');
  const cameraStatus = document.getElementById('camera-status');
  const captureBtn = document.getElementById('capture-btn');
  const retakeBtn = document.getElementById('retake-btn');
  const joinBtn = document.getElementById('join-btn');

  const scoreValue = document.getElementById('score-value');
  const timerEl = document.getElementById('timer');
  const stage = document.getElementById('stage');
  const startBtn = document.getElementById('start-btn');
  const findBtn = document.getElementById('find-btn');
  const hint = document.getElementById('hint');
  const waitingMsg = document.getElementById('waiting-msg');

  const modalOverlay = document.getElementById('modal-overlay');
  const modalClose = document.getElementById('modal-close');
  const modalPerson = document.getElementById('modal-person');
  const modalList = document.getElementById('modal-list');
  const modalForm = document.getElementById('modal-form');
  const modalInput = document.getElementById('modal-input');
  const modalMsg = document.getElementById('modal-msg');

  const codeOverlay = document.getElementById('code-overlay');
  const codeClose = document.getElementById('code-close');
  const codeForm = document.getElementById('code-form');
  const codeInput = document.getElementById('code-input');
  const codeMsg = document.getElementById('code-msg');

  const findOverlay = document.getElementById('find-overlay');
  const findClose = document.getElementById('find-close');
  const findSearch = document.getElementById('find-search');
  const findList = document.getElementById('find-list');

  const countdownOverlay = document.getElementById('countdown-overlay');
  const countdownNumber = document.getElementById('countdown-number');

  const endOverlay = document.getElementById('end-overlay');
  const winnerPhoto = document.getElementById('winner-photo');
  const winnerName = document.getElementById('winner-name');
  const winnerScore = document.getElementById('winner-score');
  const leaderboard = document.getElementById('leaderboard');
  const newgameBtn = document.getElementById('newgame-btn');

  function showScreen(el) {
    [screenOnboarding, screenRoom].forEach(s => s.classList.remove('active'));
    el.classList.add('active');
  }

  // ---------- camera ----------
  let stream = null;
  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      video.srcObject = stream;
      cameraStatus.style.display = 'none';
    } catch (e) {
      cameraStatus.textContent = 'לא ניתן לגשת למצלמה. אשרו הרשאת מצלמה בדפדפן.';
    }
  }

  function capturePhoto() {
    const size = 360;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const vw = video.videoWidth, vh = video.videoHeight;
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2, sy = (vh - side) / 2;
    // mirror horizontally to match preview
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    myPhoto = dataUrl;
    photoPreview.src = dataUrl;
    photoPreview.hidden = false;
    video.hidden = true;
    captureBtn.hidden = true;
    retakeBtn.hidden = false;
    updateJoinBtn();
  }

  function retake() {
    myPhoto = null;
    photoPreview.hidden = true;
    video.hidden = false;
    captureBtn.hidden = false;
    retakeBtn.hidden = true;
    updateJoinBtn();
  }

  function updateJoinBtn() {
    joinBtn.disabled = !(nameInput.value.trim() && teamInput.value && myPhoto);
  }

  captureBtn.addEventListener('click', capturePhoto);
  retakeBtn.addEventListener('click', retake);
  nameInput.addEventListener('input', updateJoinBtn);
  teamInput.addEventListener('change', updateJoinBtn);

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    myName = nameInput.value.trim();
    myTeam = teamInput.value;
    if (!myName || !myTeam || !myPhoto) return;
    localStorage.setItem('cg_name', myName);
    localStorage.setItem('cg_team', myTeam);
    localStorage.setItem('cg_photo', myPhoto);
    joinGame();
  });

  function joinGame() {
    socket.emit('join', { playerId: myId, name: myName, team: myTeam, photo: myPhoto });
  }

  // ---------- socket events ----------
  socket.on('connect', () => {
    if (myId && myName && myPhoto) {
      joinGame();
    }
  });

  socket.on('joined', ({ playerId, you, gameState: gs }) => {
    myId = playerId;
    localStorage.setItem('cg_playerId', myId);
    gameState = gs;
    showScreen(screenRoom);
    scoreValue.textContent = you.score;
    socket.emit('requestState');
    stopCameraStream();
    updateStartButtonVisibility();
    updateTimerDisplay();
  });

  socket.on('joinError', () => {
    alert('משהו השתבש בהצטרפות, נסו שוב.');
  });

  socket.on('roster', (list) => {
    roster = new Map(list.map(p => [p.id, p]));
    renderAvatars();
    if (myId && roster.has(myId)) {
      scoreValue.textContent = roster.get(myId).score;
    }
  });

  socket.on('yourConnections', (conns) => {
    myConnections = conns || {};
    renderAvatarRings();
  });

  socket.on('gameState', (gs) => {
    const prevStatus = gameState.status;
    gameState = gs;
    updateStartButtonVisibility();
    updateTimerDisplay();
    if (gs.status !== 'lobby') {
      closeCodeModal();
    }
    if (gs.status === 'timeup' && prevStatus !== 'timeup') {
      onTimeUp();
    }
  });

  socket.on('startError', () => {
    codeMsg.style.color = '#b23b3b';
    codeMsg.textContent = 'קוד שגוי, נסו שוב.';
  });

  socket.on('commonAck', (res) => {
    if (res.ok) {
      myConnections[res.toId] = { texts: res.texts };
      scoreValue.textContent = res.score;
      modalInput.value = '';
      modalMsg.style.color = '#2a8c5a';
      modalMsg.textContent = 'נוסף! +1 נקודה 🎉';
      renderModalList(res.toId);
      renderAvatarRings();
    } else {
      modalMsg.style.color = '#b23b3b';
      modalMsg.textContent = reasonText(res.reason);
    }
  });

  socket.on('gameEnded', ({ winner, leaderboard: lb }) => {
    showEndScreen(winner, lb);
  });

  function reasonText(reason) {
    switch (reason) {
      case 'same-team': return 'אתם מאותו הצוות — אי אפשר לצבור איתם נקודות 🙅';
      case 'max-reached': return 'כבר מצאתם 3 מכנים משותפים עם האדם הזה — המקסימום!';
      case 'not-running': return 'המשחק עדיין לא התחיל או שכבר נגמר הזמן.';
      case 'invalid-target': return 'שגיאה - נסו שוב.';
      case 'empty': return 'כתבו משהו קודם :)';
      default: return 'לא ניתן להוסיף כרגע.';
    }
  }

  function stopCameraStream() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  // ---------- start button + code ----------
  startBtn.addEventListener('click', () => {
    codeMsg.textContent = '';
    codeInput.value = '';
    codeOverlay.hidden = false;
    setTimeout(() => codeInput.focus(), 50);
  });

  function closeCodeModal() {
    codeOverlay.hidden = true;
  }
  codeClose.addEventListener('click', closeCodeModal);
  codeOverlay.addEventListener('click', (e) => {
    if (e.target === codeOverlay) closeCodeModal();
  });

  codeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (!code) return;
    socket.emit('startGame', { code });
  });

  function updateStartButtonVisibility() {
    if (gameState.status === 'lobby') {
      startBtn.hidden = false;
      startBtn.disabled = false;
      findBtn.hidden = true;
      hint.style.display = 'none';
      waitingMsg.style.display = 'block';
    } else {
      startBtn.hidden = true;
      waitingMsg.style.display = 'none';
      findBtn.hidden = gameState.status !== 'running';
      hint.style.display = gameState.status === 'running' ? 'block' : 'none';
    }
  }

  // ---------- find person ----------
  findBtn.addEventListener('click', () => {
    findSearch.value = '';
    renderFindList('');
    findOverlay.hidden = false;
    setTimeout(() => findSearch.focus(), 50);
  });

  findSearch.addEventListener('input', () => renderFindList(findSearch.value));

  function renderFindList(filter) {
    const q = filter.trim().toLowerCase();
    findList.innerHTML = '';
    const others = Array.from(roster.values())
      .filter(p => p.id !== myId && (!q || p.name.toLowerCase().includes(q)));
    if (!others.length) {
      const div = document.createElement('div');
      div.className = 'modal-item';
      div.textContent = 'לא נמצאו משתתפים בשם הזה';
      findList.appendChild(div);
      return;
    }
    others.forEach(p => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-item';
      btn.textContent = `${p.name}${p.team ? ' · ' + p.team : ''}`;
      btn.addEventListener('click', () => {
        findOverlay.hidden = true;
        onAvatarTap(p.id);
      });
      findList.appendChild(btn);
    });
  }

  findClose.addEventListener('click', () => { findOverlay.hidden = true; });
  findOverlay.addEventListener('click', (e) => {
    if (e.target === findOverlay) findOverlay.hidden = true;
  });

  // ---------- timer ----------
  function updateTimerDisplay() {
    clearInterval(timerInterval);
    if (gameState.status === 'lobby') {
      timerEl.textContent = '04:00';
      return;
    }
    if (gameState.status === 'running') {
      tick();
      timerInterval = setInterval(tick, 500);
    } else {
      timerEl.textContent = '00:00';
    }
    function tick() {
      const remaining = Math.max(0, gameState.endsAt - Date.now());
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      if (remaining <= 0) clearInterval(timerInterval);
    }
  }

  // ---------- end-of-time countdown ----------
  function onTimeUp() {
    closeModal();
    let n = 10;
    countdownNumber.textContent = n;
    countdownOverlay.hidden = false;
    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(countdownInterval);
        countdownNumber.textContent = '0';
      } else {
        countdownNumber.textContent = n;
      }
    }, 1000);
  }

  function showEndScreen(winner, lb) {
    clearInterval(countdownInterval);
    countdownOverlay.hidden = true;
    if (winner) {
      winnerPhoto.src = winner.photo;
      winnerName.textContent = winner.name;
      winnerScore.textContent = `${winner.score} מכנים משותפים!`;
    } else {
      winnerName.textContent = 'אין עדיין מנצח';
      winnerScore.textContent = '';
    }
    leaderboard.innerHTML = '';
    lb.forEach((p, i) => {
      const li = document.createElement('li');
      li.textContent = `${p.name}${p.team ? ' (' + p.team + ')' : ''} — ${p.score} נק'`;
      leaderboard.appendChild(li);
    });
    endOverlay.hidden = false;
  }

  newgameBtn.addEventListener('click', () => {
    socket.emit('newGame');
    endOverlay.hidden = true;
    localStorage.removeItem('cg_playerId');
    location.reload();
  });

  // ---------- avatars ----------
  const COLORS = ['#ff6b6b', '#4ecdc4', '#ffd93d', '#a06cff', '#4c9aff', '#ff9f4c', '#4ce0b3', '#ff4ce0'];

  function colorFor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  function renderAvatars() {
    const rect = stage.getBoundingClientRect();
    const w = rect.width || 300;
    const h = rect.height || 300;

    // remove avatars for players no longer present (shouldn't normally happen)
    for (const [id, av] of avatars) {
      if (!roster.has(id)) {
        av.el.remove();
        avatars.delete(id);
      }
    }

    for (const [id, p] of roster) {
      let av = avatars.get(id);
      if (!av) {
        av = createAvatar(id, p, w, h);
        avatars.set(id, av);
        stage.appendChild(av.el);
      }
      updateAvatarData(av, p);
    }
    renderAvatarRings();
  }

  function createAvatar(id, p, stageW, stageH) {
    const el = document.createElement('div');
    el.className = 'avatar' + (id === myId ? ' me' : '');
    el.innerHTML = `
      <div class="body"></div>
      <div class="leg l"></div>
      <div class="leg r"></div>
      <div class="head"></div>
      <div class="name-tag"></div>
    `;
    el.querySelector('.body').style.background = colorFor(id);
    el.addEventListener('click', () => onAvatarTap(id));

    const av = {
      id,
      el,
      x: Math.random() * Math.max(1, stageW - 64),
      y: Math.random() * Math.max(1, stageH - 78),
      vx: (Math.random() - 0.5) * 1.2 || 0.5,
      vy: (Math.random() - 0.5) * 1.2 || 0.5
    };
    if (Math.abs(av.vx) < 0.3) av.vx = 0.3 * Math.sign(av.vx || 1);
    if (Math.abs(av.vy) < 0.3) av.vy = 0.3 * Math.sign(av.vy || 1);
    return av;
  }

  function updateAvatarData(av, p) {
    av.el.querySelector('.head').style.backgroundImage = `url(${p.photo})`;
    av.el.querySelector('.name-tag').textContent = p.name;
    av.el.classList.toggle('offline', !p.online);
  }

  function renderAvatarRings() {
    for (const [id, av] of avatars) {
      const conn = myConnections[id];
      const maxed = conn && conn.texts && conn.texts.length >= 3;
      av.el.classList.toggle('done-max', !!maxed && id !== myId);
    }
  }

  function animate() {
    const rect = stage.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    for (const av of avatars.values()) {
      av.x += av.vx;
      av.y += av.vy;
      if (av.x <= 0) { av.x = 0; av.vx = Math.abs(av.vx); }
      if (av.x >= w - 64) { av.x = w - 64; av.vx = -Math.abs(av.vx); }
      if (av.y <= 0) { av.y = 0; av.vy = Math.abs(av.vy); }
      if (av.y >= h - 78) { av.y = h - 78; av.vy = -Math.abs(av.vy); }
      av.el.style.transform = `translate(${av.x}px, ${av.y}px)`;
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  window.addEventListener('resize', () => {
    // keep avatars within new bounds; renderAvatars not strictly needed since animate() clamps
  });

  // ---------- modal ----------
  function onAvatarTap(id) {
    if (id === myId) return;
    const me = roster.get(myId);
    const other = roster.get(id);
    if (!other) return;
    currentModalTarget = id;
    modalPerson.textContent = `${other.name}${other.team ? ' · ' + other.team : ''}`;
    renderModalList(id);
    modalMsg.textContent = '';

    const sameTeam = me && me.team && other.team && me.team.toLowerCase() === other.team.toLowerCase();
    const notRunning = gameState.status !== 'running';
    if (sameTeam) {
      modalForm.hidden = true;
      modalMsg.style.color = '#b23b3b';
      modalMsg.textContent = 'אתם מאותו הצוות — חפשו מכנים משותפים עם אנשים מצוותים אחרים 🙂';
    } else if (notRunning) {
      modalForm.hidden = true;
      modalMsg.style.color = '#b23b3b';
      modalMsg.textContent = gameState.status === 'lobby' ? 'המשחק עוד לא התחיל.' : 'הזמן נגמר!';
    } else {
      modalForm.hidden = false;
    }
    modalOverlay.hidden = false;
    setTimeout(() => modalInput.focus(), 50);
  }

  function renderModalList(id) {
    const conn = myConnections[id];
    modalList.innerHTML = '';
    const texts = (conn && conn.texts) || [];
    texts.forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'modal-item';
      div.textContent = `${i + 1}. ${t}`;
      modalList.appendChild(div);
    });
    if (texts.length >= 3) {
      modalForm.hidden = true;
      modalMsg.style.color = '#2a8c5a';
      modalMsg.textContent = 'מצאתם 3 מכנים משותפים — המקסימום! 🎉';
    }
  }

  function closeModal() {
    modalOverlay.hidden = true;
    currentModalTarget = null;
    modalInput.value = '';
  }
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  modalInput.addEventListener('input', () => {
    const val = modalInput.value;
    const hasArmyWord = ARMY_WORDS.some(w => val.includes(w));
    if (hasArmyWord) {
      modalMsg.style.color = '#b2843b';
      modalMsg.textContent = 'שימו לב: מכנה משותף צריך להיות לא קשור לצבא 😉';
    } else if (modalMsg.textContent.includes('צבא')) {
      modalMsg.textContent = '';
    }
  });

  modalForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = modalInput.value.trim();
    if (!text || !currentModalTarget) return;
    socket.emit('addCommon', { toId: currentModalTarget, text });
  });

  // ---------- init ----------
  if (myId && myName && myPhoto) {
    // returning player: skip onboarding camera, go straight to connecting
    showScreen(screenRoom);
    hint.style.display = 'none';
    waitingMsg.style.display = 'none';
    timerEl.textContent = '--:--';
  } else {
    startCamera();
  }
})();
