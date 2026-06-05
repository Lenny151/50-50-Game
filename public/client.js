// ── Image path helper ────────────────────────────────────────────────────
// Add image names here if they are PNGs rather than SVGs
const PNG_IMAGES = new Set([
  'acorn', 'apple', 'bird', 'boat', 'books', 'broccoli', 'bus', 'butterfly',
  'cake', 'candy_cane', 'car', 'cat', 'cheetah', 'cloud', 'cookies', 'crab',
  'croissant', 'dog', 'donut', 'eggplant', 'fire', 'fox', 'frog', 'giraffe',
  'guitar', 'hammer', 'hat', 'hotdog', 'ice_cream', 'jandals', 'jellyfish',
  'knife', 'koala', 'koala_tree', 'lion', 'llama', 'meat', 'megaphone',
  'moose', 'octopus', 'owl', 'pan', 'panda', 'pizza', 'plant', 'pretzel',
  'sandwich', 'saw', 'shrimp', 'steak', 'tent', 'turtle', 'unicorn',
  'whale', 'wheelchair', 'wood',
]);
function imgPath(name) {
  return `/images/${name}.${PNG_IMAGES.has(name) ? 'png' : 'svg'}`;
}

// ── Constants ────────────────────────────────────────────────────────────
const CANVAS_SIZE   = 500;   // internal canvas resolution (drawing)
const MINI          = 200;   // mini card canvas resolution
const MIN_PATH_PX   = 40;    // minimum drawn length before submit is enabled
const MIN_DISTANCE  = 4;     // minimum px between recorded path points
const LINE_WIDTH    = 5;     // barrier line width for pixel counting
const DRAW_COLOR    = '#2563eb';
const PLAYER_COLORS = [
  '#ff6384','#36a2eb','#ffce56','#4bc0c0','#9966ff',
  '#ff9f40','#e74c3c','#3498db','#2ecc71','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#e91e63','#00bcd4',
  '#8bc34a','#ff5722','#607d8b','#795548','#00acc1',
];

// ── Streak helpers ───────────────────────────────────────────────────────
const STREAK_THRESHOLD = 0.03; // must match server — ratio within 0.47–0.53

function streakMultiplier(streak) {
  if (streak >= 4) return 2.0;
  if (streak === 3) return 1.5;
  if (streak === 2) return 1.25;
  return 1.0;
}

// ── State ────────────────────────────────────────────────────────────────
const socket = io();

let myId       = null;
let isHost     = false;
let roomCode   = null;
let currentPath  = [];
let drawing      = false;
let lastPoint    = null;
let submitted    = false;
let currentImage = null;   // name of current image
let timerInterval = null;
let liveSubmissions  = [];    // accumulates cuts as they arrive during a round
let transitionTimer  = null;  // setTimeout handle for drawing→results transition
let roundEnded       = false; // true once round-end has been received
let pendingRoundEnd  = null;  // stores round-end payload if it arrives before transition
let imageCanvas      = null;  // offscreen canvas with clean image for style/alpha checks
let myStreak         = 0;     // consecutive accurate cuts — drives streak badge

// ── Screen management ────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── DOM refs ─────────────────────────────────────────────────────────────
const playerNameInput = document.getElementById('player-name');
const roomCodeInput   = document.getElementById('room-code');
const homeError       = document.getElementById('home-error');

document.getElementById('btn-create').addEventListener('click', () => {
  const name = playerNameInput.value.trim();
  if (!name) return showError('Enter your name first');
  socket.emit('create-room', { name });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = playerNameInput.value.trim();
  const code = roomCodeInput.value.trim();
  if (!name) return showError('Enter your name first');
  if (code.length !== 4) return showError('Enter the 4-letter room code');
  socket.emit('join-room', { name, code });
});

document.getElementById('btn-copy-code').addEventListener('click', () => {
  const url = `${location.origin}?code=${roomCode}`;
  navigator.clipboard.writeText(url).then(() => {
    document.getElementById('btn-copy-code').textContent = 'Copied!';
    setTimeout(() => document.getElementById('btn-copy-code').textContent = 'Copy link', 2000);
  });
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start-game');
});

document.getElementById('btn-clear').addEventListener('click', clearDraw);

document.getElementById('btn-submit').addEventListener('click', submitCut);

document.getElementById('btn-next-round').addEventListener('click', () => {
  socket.emit('next-round');
});

document.getElementById('btn-see-final').addEventListener('click', () => {
  socket.emit('next-round');
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  location.reload();
});

// Auto-fill room code from URL param
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) roomCodeInput.value = urlCode.toUpperCase();

function showError(msg) {
  homeError.textContent = msg;
  setTimeout(() => homeError.textContent = '', 3000);
}

// ── Socket events ────────────────────────────────────────────────────────
socket.on('connect', () => { myId = socket.id; });

socket.on('error', (msg) => {
  showError(msg);
});

socket.on('joined', ({ code, isHost: host, midGameJoin, gameState }) => {
  roomCode = code;
  isHost   = host;
  document.getElementById('lobby-code').textContent = code;

  if (midGameJoin) {
    document.getElementById('btn-start').classList.add('hidden');
    const waitEl = document.getElementById('waiting-msg');
    waitEl.textContent = gameState === 'drawing'
      ? 'Joining game in progress…'
      : 'Game in progress — you\'ll join from the next round';
    waitEl.classList.remove('hidden');
  } else {
    document.getElementById('btn-start').classList.toggle('hidden', !host);
    document.getElementById('waiting-msg').classList.toggle('hidden', host);
  }

  showScreen('screen-lobby');
  history.replaceState(null, '', `?code=${code}`);
});

socket.on('players', (players) => {
  const list = document.getElementById('player-list');
  document.getElementById('player-count').textContent = players.length;
  list.innerHTML = players.map(p => `
    <div class="player-chip${p.isHost ? ' is-host' : ''}">
      ${escapeHtml(p.name)}
    </div>
  `).join('');

  // Update host status in case it changed mid-game
  if (players.find(p => p.id === myId)?.isHost) {
    isHost = true;
    document.getElementById('btn-start').classList.remove('hidden');
    document.getElementById('waiting-msg').classList.add('hidden');
  }
});

socket.on('new-host', (hostId) => {
  if (hostId === myId) {
    isHost = true;
    document.getElementById('btn-start').classList.remove('hidden');
    document.getElementById('waiting-msg').classList.add('hidden');
    // Show next-round button if we're on results screen
    document.getElementById('btn-next-round').classList.remove('hidden');
    document.getElementById('btn-see-final').classList.remove('hidden');
    document.getElementById('host-waiting-msg').classList.add('hidden');
  }
});

socket.on('round-start', ({ round, total, image, duration, elapsed }) => {
  const receivedAt = Date.now(); // capture now so we can correct for load time
  currentImage    = image;
  submitted       = false;
  currentPath     = [];
  lastPoint       = null;
  liveSubmissions = [];
  roundEnded      = false;
  pendingRoundEnd = null;
  imageCanvas     = null;
  if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }

  document.getElementById('draw-round').textContent = `Round ${round} / ${total}`;
  document.getElementById('submitted-overlay').classList.add('hidden');
  document.getElementById('btn-submit').disabled = true;
  document.getElementById('progress-label').textContent = '';
  document.getElementById('draw-hint').textContent = 'Loading…';

  // Streak badge — show what multiplier the player can earn this round
  const badge = document.getElementById('streak-badge');
  if (myStreak >= 1) {
    const potential = streakMultiplier(myStreak + 1);
    badge.textContent = `🔥 ×${potential} on the line`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  showScreen('screen-drawing');

  // Start timer only once the image is painted — deduct load time from remaining
  setupDrawCanvas(image).then(() => {
    document.getElementById('draw-hint').textContent = 'Draw a line to cut the image in half!';
    const totalElapsed = (elapsed || 0) + (Date.now() - receivedAt);
    const remainingMs  = Math.max(0, duration - totalElapsed);
    startTimer(Math.round(remainingMs / 1000), duration / 1000);
  });
});

socket.on('cut-accepted', () => {
  // % split is already shown from client-side; scores arrive with round-end
});

// Each player's cut is broadcast as it arrives — add it to the live canvas
socket.on('cut-submitted', ({ id, name, points }) => {
  if (!liveSubmissions.find(s => s.id === id)) {
    liveSubmissions.push({ id, name, points });
  }

  // If we're already on the results screen, draw it immediately
  if (document.getElementById('screen-results').classList.contains('active')) {
    addCutToCanvas(id, name, points);
  }
});

socket.on('progress', ({ submitted: s, total: t }) => {
  document.getElementById('progress-label').textContent = `${s}/${t}`;
  // Update the live header count while watching cuts come in
  if (document.getElementById('screen-results').classList.contains('active')) {
    document.getElementById('results-round-label').textContent =
      s >= t ? 'All cuts in!' : `${s} of ${t} cuts in…`;
  }
});

socket.on('round-end', ({ results, image, isLastRound }) => {
  roundEnded = true;
  clearTimer();

  if (transitionTimer) {
    // The % screen is still showing — let it complete and consume the results then.
    pendingRoundEnd = { results, image, isLastRound };
  } else {
    // Already on the results screen (or transitioning), show scores now.
    showResults(results, image, isLastRound);
  }
});

socket.on('game-over', (final) => {
  showFinal(final);
});

// ── Canvas setup ──────────────────────────────────────────────────────────
function setupDrawCanvas(imageName) {
  return new Promise(resolve => {
    const canvas = document.getElementById('game-canvas');
    canvas.width  = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    canvas.style.opacity = '0'; // hide until image is painted — prevents white flash
    const ctx = canvas.getContext('2d');

    // Transparent offscreen canvas — no background fill so undrawn pixels stay
    // alpha=0. Used for on-object style calculation.
    imageCanvas        = document.createElement('canvas');
    imageCanvas.width  = CANVAS_SIZE;
    imageCanvas.height = CANVAS_SIZE;
    const imgCtx       = imageCanvas.getContext('2d');

    const img = new Image();
    img.src = imgPath(imageName);
    img.onload = () => {
      // Main canvas: white background so image sits on white
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
      canvas.style.opacity = '1'; // fade in once image is ready
      // imageCanvas stays transparent — used for alpha checks in ratio + style
      imgCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      imgCtx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
      resolve();
    };
    img.onerror = resolve; // don't block forever if image fails to load
  });
}

function renderDrawing() {
  const canvas = document.getElementById('game-canvas');
  const ctx    = canvas.getContext('2d');

  // Redraw image
  const img = new Image();
  img.src = imgPath(currentImage);
  img.onload = () => {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
    drawPath(ctx, currentPath, DRAW_COLOR, 3.5, true);
  };
  // Also draw immediately in case image is cached
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
  drawPath(ctx, currentPath, DRAW_COLOR, 3.5, true);
}

function drawPath(ctx, points, color, width, shadow = false) {
  if (points.length < 2) return;
  ctx.save();
  if (shadow) {
    ctx.shadowColor = color;
    ctx.shadowBlur  = 8;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();
  ctx.restore();
}

function clearDraw() {
  currentPath = [];
  lastPoint   = null;
  document.getElementById('btn-submit').disabled = true;
  setupDrawCanvas(currentImage);
}

// ── Mouse / Touch events ──────────────────────────────────────────────────
const gameCanvas = document.getElementById('game-canvas');

gameCanvas.addEventListener('mousedown',  onStart);
gameCanvas.addEventListener('mousemove',  onMove);
gameCanvas.addEventListener('mouseup',    onEnd);
gameCanvas.addEventListener('mouseleave', onEnd);
gameCanvas.addEventListener('touchstart', onStart, { passive: false });
gameCanvas.addEventListener('touchmove',  onMove,  { passive: false });
gameCanvas.addEventListener('touchend',   onEnd);

function getPos(e) {
  e.preventDefault();
  const canvas = document.getElementById('game-canvas');
  const rect   = canvas.getBoundingClientRect();
  const scaleX = CANVAS_SIZE / rect.width;
  const scaleY = CANVAS_SIZE / rect.height;
  const src    = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - rect.left) * scaleX,
    y: (src.clientY - rect.top)  * scaleY,
  };
}

function onStart(e) {
  if (submitted) return;
  drawing   = true;
  lastPoint = null;
  currentPath = [];
  const p = getPos(e);
  currentPath.push(p);
  lastPoint = p;
}

function onMove(e) {
  if (!drawing || submitted) return;
  const p = getPos(e);
  if (lastPoint && Math.hypot(p.x - lastPoint.x, p.y - lastPoint.y) < MIN_DISTANCE) return;
  currentPath.push(p);
  lastPoint = p;
  renderDrawing();
  document.getElementById('btn-submit').disabled = pathLength(currentPath) < MIN_PATH_PX;
}

function onEnd() {
  drawing = false;
}

function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y);
  }
  return len;
}

// ── Style score (object-aware) ────────────────────────────────────────────
// Only counts path length that passes over drawn pixels on the image.
// Wiggles outside the object don't score.
function calculateStyleOverObject(pathPoints) {
  if (pathPoints.length < 2 || !imageCanvas) return 0;

  let pixels;
  try {
    pixels = imageCanvas.getContext('2d').getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
  } catch (e) {
    return 0; // tainted canvas or not ready — fail gracefully
  }

  const isOverObject = (x, y) => {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || px >= CANVAS_SIZE || py < 0 || py >= CANVAS_SIZE) return false;
    return pixels[(py * CANVAS_SIZE + px) * 4 + 3] > 20; // alpha > 20
  };

  let onObjectLength = 0;
  let firstOn = null, lastOn = null;

  for (let i = 1; i < pathPoints.length; i++) {
    const a = pathPoints[i - 1], b = pathPoints[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (isOverObject((a.x + b.x) / 2, (a.y + b.y) / 2)) {
      onObjectLength += segLen;
      if (!firstOn) firstOn = a;
      lastOn = b;
    }
  }

  if (!firstOn || onObjectLength < 20) return 0;

  const straightLen = Math.hypot(lastOn.x - firstOn.x, lastOn.y - firstOn.y);
  if (straightLen < 20) return 0;

  // ratio 1 = straight (0 pts) → 4+ = very wiggly (max 20 pts)
  return Math.round(Math.min((onObjectLength / straightLen - 1) / 3, 1) * 50);
}

// ── Submit ────────────────────────────────────────────────────────────────
function submitCut() {
  if (submitted || currentPath.length < 2) return;
  submitted = true;
  clearTimer();

  const ratio = calculateRatio(currentPath);
  const style = calculateStyleOverObject(currentPath);
  const pctA  = (ratio * 100).toFixed(1);
  const pctB  = ((1 - ratio) * 100).toFixed(1);

  socket.emit('submit-cut', { points: currentPath, ratio, style });

  // Compute potential streak multiplier for the preview
  const onStreak       = Math.abs(ratio - 0.5) <= STREAK_THRESHOLD;
  const previewStreak  = onStreak ? myStreak + 1 : 0;
  const previewMul     = streakMultiplier(previewStreak);

  // Show % split on the drawing screen
  renderDrawing();
  document.getElementById('submitted-overlay').classList.remove('hidden');
  document.getElementById('waiting-count').textContent = `${pctA}% / ${pctB}%`;
  document.getElementById('score-preview').innerHTML = `
    <div class="score-pill accuracy">
      <span>${pctA}%</span><span class="pill-label">Side A</span>
    </div>
    <div class="score-pill accuracy">
      <span>${pctB}%</span><span class="pill-label">Side B</span>
    </div>
    ${previewMul > 1 ? `<div class="score-pill style"><span>×${previewMul}</span><span class="pill-label">${previewStreak}🔥 Streak!</span></div>` : ''}
  `;

  // After a pause, move to the live results view.
  // If round-end arrives before the timer fires (last player), the data is
  // stored in pendingRoundEnd and shown once the timer completes.
  transitionTimer = setTimeout(() => {
    transitionTimer = null;
    initLiveResults(currentImage);
    showScreen('screen-results');
    if (pendingRoundEnd) {
      showResults(pendingRoundEnd.results, pendingRoundEnd.image, pendingRoundEnd.isLastRound);
      pendingRoundEnd = null;
    }
  }, 3000);
}

// ── Timer ─────────────────────────────────────────────────────────────────
function startTimer(remainingSeconds, totalSeconds) {
  clearTimer();
  totalSeconds = totalSeconds || remainingSeconds;
  const ring          = document.getElementById('timer-ring');
  const numEl         = document.getElementById('timer-num');
  const circumference = 163.36;
  let remaining       = remainingSeconds;

  function tick() {
    remaining = Math.max(0, remaining - 1);
    numEl.textContent = remaining;
    ring.style.strokeDashoffset = circumference * (1 - remaining / totalSeconds);

    const pct = remaining / totalSeconds;
    ring.style.stroke = pct > 0.5 ? 'var(--green)'
                      : pct > 0.25 ? 'var(--yellow)'
                      : 'var(--red)';

    if (remaining === 0) {
      clearTimer();
      if (!submitted) submitCut(); // auto-submit on timeout
    }
  }

  tick();
  timerInterval = setInterval(tick, 1000);
}

function clearTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Pixel counting (client-side) ─────────────────────────────────────────
// Creates a masked offscreen canvas, extends path to edges, flood fills
// from one corner, then counts pixels on each side.

function extendToEdges(points) {
  if (points.length < 2) return points;
  const first = nearestEdge(points[0]);
  const last  = nearestEdge(points[points.length - 1]);
  return [first, ...points, last];
}

function nearestEdge(p) {
  const W = CANVAS_SIZE, H = CANVAS_SIZE;
  const dists = [
    { d: p.x,     pt: { x: 0, y: p.y } },
    { d: W - p.x, pt: { x: W, y: p.y } },
    { d: p.y,     pt: { x: p.x, y: 0 } },
    { d: H - p.y, pt: { x: p.x, y: H } },
  ];
  return dists.reduce((a, b) => a.d < b.d ? a : b).pt;
}

function calculateRatio(pathPoints) {
  const W = CANVAS_SIZE, H = CANVAS_SIZE;
  const fullPath = extendToEdges(pathPoints);

  // Get image alpha mask from imageCanvas (transparent — no background fill)
  let imgPixels = null;
  if (imageCanvas) {
    try { imgPixels = imageCanvas.getContext('2d').getImageData(0, 0, W, H).data; } catch(e) {}
  }

  // Draw path barrier on offscreen canvas
  const offscreen = document.createElement('canvas');
  offscreen.width  = W;
  offscreen.height = H;
  const ctx = offscreen.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  ctx.moveTo(fullPath[0].x, fullPath[0].y);
  for (let i = 1; i < fullPath.length; i++) ctx.lineTo(fullPath[i].x, fullPath[i].y);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth   = LINE_WIDTH;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Build barrier mask (black pixels = path barrier)
  const barrierData = ctx.getImageData(0, 0, W, H).data;
  const barrier = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (barrierData[i * 4] < 128) barrier[i] = 1;
  }

  // DFS flood fill from top-left — traverses freely through background too
  let startIdx = 0;
  for (let i = 0; i < W * H; i++) { if (!barrier[i]) { startIdx = i; break; } }

  const visited = new Uint8Array(W * H);
  const stack   = [startIdx];
  visited[startIdx] = 1;
  let sideCount = 0; // object pixels on this side

  while (stack.length > 0) {
    const idx = stack.pop();
    // Only tally pixels that are part of the actual image object
    if (!imgPixels || imgPixels[idx * 4 + 3] > 20) sideCount++;
    const x = idx % W, y = (idx / W) | 0;
    const n = [
      x > 0     ? idx - 1 : -1,
      x < W - 1 ? idx + 1 : -1,
      y > 0     ? idx - W : -1,
      y < H - 1 ? idx + W : -1,
    ];
    for (const ni of n) {
      if (ni >= 0 && !visited[ni] && !barrier[ni]) { visited[ni] = 1; stack.push(ni); }
    }
  }

  // Total object pixels across the whole canvas (excluding barrier)
  let totalObjectPixels = 0;
  if (imgPixels) {
    for (let i = 0; i < W * H; i++) {
      if (!barrier[i] && imgPixels[i * 4 + 3] > 20) totalObjectPixels++;
    }
  } else {
    // Fallback: count all non-barrier pixels
    for (let i = 0; i < W * H; i++) { if (!barrier[i]) totalObjectPixels++; }
  }

  return totalObjectPixels > 0 ? sideCount / totalObjectPixels : 0.5;
}

// ── Live results grid ─────────────────────────────────────────────────────
function initLiveResults(imageName) {
  document.getElementById('cuts-grid').innerHTML        = '';
  document.getElementById('scores-list').innerHTML      = '';
  document.getElementById('scores-section').classList.add('hidden');
  document.getElementById('btn-next-round').classList.add('hidden');
  document.getElementById('btn-see-final').classList.add('hidden');
  document.getElementById('host-waiting-msg').classList.add('hidden');
  document.getElementById('results-round-label').textContent = 'Cuts coming in…';

  // Replay any cuts that already arrived before we switched screens
  liveSubmissions.forEach(s => addCutToCanvas(s.id, s.name, s.points));
}

function addCutToCanvas(id, name, points) {
  const grid = document.getElementById('cuts-grid');

  // Create card if it doesn't exist yet
  let card = grid.querySelector(`[data-player-id="${id}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'cut-card';
    card.dataset.playerId = id;

    const cv = document.createElement('canvas');
    cv.className = 'cut-card-canvas';
    cv.width     = MINI;
    cv.height    = MINI;

    const info = document.createElement('div');
    info.className = 'cut-card-info';

    const nameEl = document.createElement('div');
    nameEl.className   = 'cut-card-name';
    nameEl.textContent = name;

    const scoreEl = document.createElement('div');
    scoreEl.className = 'cut-card-score';

    info.appendChild(nameEl);
    info.appendChild(scoreEl);
    card.appendChild(cv);
    card.appendChild(info);
    grid.appendChild(card);
  }

  if (!points?.length) return;

  const cv    = card.querySelector('canvas');
  const ctx   = cv.getContext('2d');
  const idx   = liveSubmissions.findIndex(s => s.id === id);
  const color = PLAYER_COLORS[Math.max(0, idx) % PLAYER_COLORS.length];
  const scale = MINI / CANVAS_SIZE;

  const img = new Image();
  img.src = imgPath(currentImage);
  const render = () => {
    ctx.clearRect(0, 0, MINI, MINI);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, MINI, MINI);
    ctx.drawImage(img, 0, 0, MINI, MINI);
    const sp = points.map(p => ({ x: p.x * scale, y: p.y * scale }));
    drawPath(ctx, sp, color, 2.5, false);
    // Start dot
    ctx.beginPath();
    ctx.arc(sp[0].x, sp[0].y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };
  if (img.complete) render(); else img.onload = render;
}

// ── Results screen ────────────────────────────────────────────────────────
function showResults(results, imageName, isLastRound) {
  document.getElementById('results-round-label').textContent = 'Round Results';

  // Update own streak from results so the next round's badge is correct
  const myResult = results.find(r => r.id === myId);
  if (myResult) myStreak = myResult.round ? myResult.round.streak : 0;

  // Ensure any missing cards exist (players who submitted but whose
  // cut-submitted event we missed, or players who didn't submit at all)
  results.forEach((r, i) => {
    const grid = document.getElementById('cuts-grid');
    let card = grid.querySelector(`[data-player-id="${r.id}"]`);
    if (!card && r.round?.points?.length) {
      addCutToCanvas(r.id, r.name, r.round.points);
      card = grid.querySelector(`[data-player-id="${r.id}"]`);
    }
    if (!card) return;

    // Stamp each card with rank + accuracy score
    const scoreEl = card.querySelector('.cut-card-score');
    if (!scoreEl) return;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null;
    if (r.round) {
      const pctA = (r.round.ratio * 100).toFixed(1);
      const pctB = ((1 - r.round.ratio) * 100).toFixed(1);
      scoreEl.innerHTML = `
        ${medal ? `<span class="cut-rank">${medal}</span>` : `<span class="cut-rank" style="color:var(--muted);font-size:.7rem">#${i+1}</span>`}
        <span class="cut-acc">${pctA}% / ${pctB}%</span>
        ${r.round.streak >= 2 ? `<span class="cut-streak" title="${r.round.streak}🔥 streak">🔥</span>` : ''}
        <span class="cut-total">${r.round.total}pts</span>
      `;
    } else {
      scoreEl.innerHTML = `<span class="cut-no-submit">No cut</span>`;
    }
  });

  // Populate leaderboard
  const scoresList = document.getElementById('scores-list');
  scoresList.innerHTML = '';
  results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'score-row';
    row.style.animationDelay = `${i * 50}ms`;
    const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const rankLabel = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    const breakdown = r.round
      ? `<div class="score-breakdown">
           <span class="score-tag acc">🎯 ${r.round.accuracy}</span>
           <span class="score-tag spd">⚡ ${r.round.speed}</span>
           <span class="score-tag sty">✨ ${r.round.style}</span>
           ${r.round.multiplier > 1 ? `<span class="score-tag mul">🔥 ×${r.round.multiplier} (${r.round.streak} streak)</span>` : ''}
         </div>`
      : '<div class="score-breakdown"><span class="score-tag none">No cut</span></div>';
    row.innerHTML = `
      <div class="score-rank ${rankClass}">${rankLabel}</div>
      <div style="flex:1">
        <div class="score-name">${escapeHtml(r.name)}</div>
        <div class="score-comment">${getFunnyComment(r.round)}</div>
        ${breakdown}
      </div>
      <div class="score-totals">
        <div class="score-round-pts">${r.round ? '+' + r.round.total : '+0'}</div>
        <div class="score-total">${r.totalScore} total</div>
      </div>
    `;
    scoresList.appendChild(row);
  });

  document.getElementById('scores-section').classList.remove('hidden');

  // Host controls
  const btnNext  = document.getElementById('btn-next-round');
  const btnFinal = document.getElementById('btn-see-final');
  const hostWait = document.getElementById('host-waiting-msg');
  btnNext.classList.add('hidden');
  btnFinal.classList.add('hidden');
  hostWait.classList.add('hidden');
  if (isHost) {
    if (isLastRound) btnFinal.classList.remove('hidden');
    else             btnNext.classList.remove('hidden');
  } else {
    hostWait.classList.remove('hidden');
  }

  showScreen('screen-results');
}


// ── Final screen ──────────────────────────────────────────────────────────
function showFinal(final) {
  const podium = document.getElementById('final-podium');
  const list   = document.getElementById('final-list');

  // Podium: positions 2, 1, 3 (left to right)
  const podiumOrder = [1, 0, 2]; // array indices
  podium.innerHTML = podiumOrder.map(i => {
    const p = final[i];
    if (!p) return '';
    const cls = `podium-${i + 1}`;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
    return `
      <div class="podium-place ${cls}">
        <div class="podium-name">${escapeHtml(p.name)}</div>
        <div class="podium-score">${p.score} pts</div>
        <div class="podium-block">${medal}</div>
      </div>`;
  }).join('');

  // Full list (4th place onwards)
  list.innerHTML = final.slice(3).map((p, i) => `
    <div class="final-row">
      <div class="final-rank">${i + 4}</div>
      <div class="final-name">${escapeHtml(p.name)}</div>
      <div class="final-pts">${p.score}</div>
    </div>
  `).join('');

  showScreen('screen-final');
}

// ── Funny comments ────────────────────────────────────────────────────────
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getFunnyComment(round) {
  if (!round) {
    return pick([
      "Decided to let the team carry 😴",
      "No cut? Bold strategy.",
      "A strong statement: doing nothing.",
      "Vibes only, no cuts.",
      "Perhaps next time… maybe.",
    ]);
  }

  const dev    = Math.abs(round.ratio - 0.5);
  const streak = round.streak || 0;
  const speed  = round.speed;
  const style  = round.style;

  // Streak shoutouts take priority
  if (streak >= 4) return pick([
    "FOUR IN A ROW?! Call the authorities 🚨",
    "Someone please stop this person.",
    "Are you a human or a laser cutter?",
    "This is getting out of hand (in the best way).",
  ]);
  if (streak === 3) return pick([
    "Three in a row — they're on fire 🔥",
    "Hat trick of precision!",
    "Somebody's been practising…",
    "The streak is real and it's scary.",
  ]);

  // Perfect cut
  if (dev <= 0.005) return pick([
    "Witchcraft. Burn them. 🧙",
    "That's literally impossible.",
    "Did you use a ruler?? 📏",
    "The machine has become self-aware.",
    "Suspiciously perfect. We're watching you.",
  ]);

  // Near perfect
  if (dev <= 0.02) return pick([
    "Absolutely surgical 🔪",
    "This should be illegal.",
    "Hair's breadth from perfection.",
    "The accuracy on this one…",
    "They know something the rest of us don't.",
  ]);

  // Good — with speed/style flavour
  if (dev <= 0.05) {
    if (speed >= 25) return pick([
      "Fast AND accurate? Absolutely rude. 😤",
      "Speedy and precise — deeply suspicious.",
      "Nobody asked you to be this good.",
    ]);
    if (style >= 35) return pick([
      "Accurate AND wiggly? A true artist. 🎨",
      "The flair was unnecessary but deeply appreciated.",
      "Showing off now, are we?",
    ]);
    return pick([
      "Solid work, solid work. 👌",
      "Close enough for government work.",
      "Your mum would be proud.",
      "Almost too good. Almost.",
      "We'll allow it.",
    ]);
  }

  // Acceptable
  if (dev <= 0.10) return pick([
    "Not bad… not great either.",
    "One side is slightly jealous of the other.",
    "Good enough to not be embarrassing. 👍",
    "Room for improvement, but we respect the hustle.",
    "Somewhere between 'fine' and 'hmm'.",
  ]);

  // Poor
  if (dev <= 0.20) return pick([
    "One side is feeling a bit left out. 😢",
    "A bold interpretation of 'half'.",
    "Did you sneeze mid-cut? 🤧",
    "Confidence: 10/10. Accuracy: less so.",
    "The spirit was willing but the line was not.",
  ]);

  // Terrible
  return pick([
    "Sir, that is not half. 💀",
    "The image has been mortally wounded.",
    "Have you considered a different hobby?",
    "That's… a choice.",
    "One side got the very short end of the stick.",
    "The gap between vision and execution is immense.",
  ]);
}

// ── Utils ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
