const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Game config ────────────────────────────────────────────────────────────
const ROUND_DURATION_MS = 30_000;
const ROUNDS_PER_GAME   = 10;
const MAX_PLAYERS       = 30;

const IMAGES = [
  'acorn', 'apple', 'bird', 'boat', 'books', 'broccoli', 'bus', 'butterfly',
  'cake', 'candy_cane', 'car', 'cat', 'cheetah', 'cloud', 'cookies', 'crab',
  'croissant', 'dog', 'donut', 'eggplant', 'fire', 'fox', 'frog', 'giraffe',
  'guitar', 'hammer', 'hat', 'hotdog', 'ice_cream', 'jandals', 'jellyfish',
  'knife', 'koala', 'koala_tree', 'lion', 'llama', 'meat', 'megaphone',
  'moose', 'octopus', 'owl', 'pan', 'panda', 'pizza', 'plant', 'pretzel',
  'sandwich', 'saw', 'shrimp', 'steak', 'tent', 'turtle', 'unicorn',
  'whale', 'wheelchair', 'wood',
];

// ── Scoring ────────────────────────────────────────────────────────────────
// Accuracy:  0–100  – how close to a perfect 50/50 split
// Speed:     0–30   – faster submissions score more
// Style:     0–50   – how creative (non-straight) the cut was
// Max total: 180 per round  (× streak multiplier)

// ── Streak ─────────────────────────────────────────────────────────────────
// A "streak" is consecutive rounds where the cut is within STREAK_THRESHOLD
// of a perfect 50/50.  The multiplier rewards consistency.
const STREAK_THRESHOLD = 0.03;  // ratio must be 0.47–0.53

function getMultiplier(streak) {
  if (streak >= 4) return 2.0;
  if (streak === 3) return 1.5;
  if (streak === 2) return 1.25;
  return 1.0;
}

function scoreAccuracy(ratio) {
  // deviation 0 = perfect 50/50, 0.5 = entire image on one side
  // Power curve: stays near 100 when close to 50/50, drops off steeply beyond that
  const deviation = Math.abs(ratio - 0.5);
  return Math.round(Math.pow(Math.max(0, 1 - deviation * 4), 2) * 100);
}

function scoreSpeed(elapsedMs) {
  const fraction = Math.max(0, 1 - elapsedMs / ROUND_DURATION_MS);
  return Math.round(Math.pow(fraction, 2) * 30);
}

function scoreStyle(points) {
  if (!points || points.length < 2) return 0;
  let pathLen = 0;
  for (let i = 1; i < points.length; i++) {
    pathLen += Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y);
  }
  const s = points[0], e = points[points.length - 1];
  const straight = Math.hypot(e.x - s.x, e.y - s.y);
  if (straight < 20) return 0;
  // ratio 1 = straight (0 pts) → ratio 4+ = very wiggly (20 pts)
  return Math.round(Math.min((pathLen / straight - 1) / 3, 1) * 50);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}


// ── State ──────────────────────────────────────────────────────────────────
const rooms = new Map();

function getPlayerList(room) {
  return [...room.players.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    score: p.score,
    isHost: id === room.hostId,
  }));
}

function startRound(room) {
  room.state       = 'drawing';
  room.roundStart  = Date.now();
  room.submissions = new Map();
  room.currentImage = room.images[room.round];
  room.round++;

  io.to(room.code).emit('round-start', {
    round:    room.round,
    total:    Math.min(ROUNDS_PER_GAME, room.images.length),
    image:    room.currentImage,
    duration: ROUND_DURATION_MS,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (room.state === 'drawing') endRound(room);
  }, ROUND_DURATION_MS + 3000); // 3s grace for slow connections
}

function endRound(room) {
  clearTimeout(room.timer);
  room.state = 'results';

  const results = [];
  for (const [id, player] of room.players) {
    const sub = room.submissions.get(id);

    if (sub) {
      const onStreak  = Math.abs(sub.ratio - 0.5) <= STREAK_THRESHOLD;
      const newStreak = onStreak ? player.streak + 1 : 0;
      player.streak   = newStreak;
      const multiplier = getMultiplier(newStreak);
      const roundPts   = Math.round(sub.total * multiplier);
      player.score    += roundPts;

      results.push({
        id,
        name:       player.name,
        totalScore: player.score,
        round: {
          accuracy:   sub.accuracy,
          speed:      sub.speed,
          style:      sub.style,
          base:       sub.total,
          total:      roundPts,
          multiplier,
          streak:     newStreak,
          points:     sub.points,
          ratio:      sub.ratio,
        },
      });
    } else {
      player.streak = 0;
      results.push({
        id,
        name:       player.name,
        totalScore: player.score,
        round:      null,
      });
    }
  }

  results.sort((a, b) => b.totalScore - a.totalScore);

  const isLastRound = room.round >= Math.min(ROUNDS_PER_GAME, room.images.length);
  io.to(room.code).emit('round-end', { results, image: room.currentImage, isLastRound });
}

function endGame(room) {
  room.state  = 'finished';
  const final = [...room.players.entries()]
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  io.to(room.code).emit('game-over', final);
  setTimeout(() => rooms.delete(room.code), 10 * 60 * 1000);
}

// ── Socket handlers ────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('create-room', ({ name }) => {
    if (!name?.trim()) return socket.emit('error', 'Enter your name first');
    let code;
    do { code = genCode(); } while (rooms.has(code));

    const room = {
      code,
      hostId:       socket.id,
      players:      new Map([[socket.id, { name: name.trim(), score: 0, streak: 0 }]]),
      state:        'lobby',
      round:        0,
      images:       shuffle(IMAGES).slice(0, ROUNDS_PER_GAME),
      roundStart:   null,
      submissions:  new Map(),
      timer:        null,
      currentImage: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.code = code;

    socket.emit('joined', { code, isHost: true });
    io.to(code).emit('players', getPlayerList(room));
  });

  socket.on('join-room', ({ code, name }) => {
    if (!name?.trim()) return socket.emit('error', 'Enter your name first');
    const upper = code?.toUpperCase().trim();
    const room  = rooms.get(upper);

    if (!room)                            return socket.emit('error', 'Room not found — check the code');
    if (room.state === 'finished')        return socket.emit('error', 'That game has already finished');
    if (room.players.size >= MAX_PLAYERS) return socket.emit('error', 'Room is full');

    room.players.set(socket.id, { name: name.trim(), score: 0, streak: 0 });
    socket.join(upper);
    socket.data.code = upper;

    const midGameJoin = room.state !== 'lobby';
    socket.emit('joined', { code: upper, isHost: false, midGameJoin, gameState: room.state });
    io.to(upper).emit('players', getPlayerList(room));

    if (room.state === 'drawing') {
      const elapsed = Date.now() - room.roundStart;
      socket.emit('round-start', {
        round:    room.round,
        total:    Math.min(ROUNDS_PER_GAME, room.images.length),
        image:    room.currentImage,
        duration: ROUND_DURATION_MS,
        elapsed,
      });
      for (const [playerId, sub] of room.submissions) {
        const player = room.players.get(playerId);
        if (player) socket.emit('cut-submitted', { id: playerId, name: player.name, points: sub.points });
      }
      socket.emit('progress', { submitted: room.submissions.size, total: room.players.size });
    }
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
    if (room.players.size < 1) return socket.emit('error', 'Need at least 1 player');
    startRound(room);
  });

  socket.on('submit-cut', ({ points, ratio, style: clientStyle }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.state !== 'drawing') return;
    if (room.submissions.has(socket.id))   return;

    const elapsed  = Date.now() - room.roundStart;
    const accuracy = scoreAccuracy(ratio);
    const speed    = scoreSpeed(elapsed);
    // Use client-calculated style (object-aware). Validate range as a sanity check.
    const style    = (typeof clientStyle === 'number' && clientStyle >= 0 && clientStyle <= 50)
      ? Math.round(clientStyle)
      : scoreStyle(points); // fallback to server calc if missing/invalid
    const total    = accuracy + speed + style;

    room.submissions.set(socket.id, { accuracy, speed, style, total, points, ratio });
    socket.emit('cut-accepted', { accuracy, speed, style, total });

    // Broadcast this cut to everyone so the live results canvas can update
    const player = room.players.get(socket.id);
    io.to(room.code).emit('cut-submitted', {
      id:     socket.id,
      name:   player.name,
      points,
    });

    const submitted = room.submissions.size;
    const players   = room.players.size;
    io.to(room.code).emit('progress', { submitted, total: players });

    if (submitted >= players) endRound(room);
  });

  socket.on('next-round', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id || room.state !== 'results') return;

    if (room.round >= Math.min(ROUNDS_PER_GAME, room.images.length)) {
      endGame(room);
    } else {
      startRound(room);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room)  return;

    room.players.delete(socket.id);
    room.submissions.delete(socket.id);

    if (room.players.size === 0) {
      clearTimeout(room.timer);
      rooms.delete(code);
      return;
    }

    // Re-assign host if needed
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
      io.to(code).emit('new-host', room.hostId);
    }

    io.to(code).emit('players', getPlayerList(room));

    // If everyone submitted while this player was leaving, end round
    if (room.state === 'drawing' && room.submissions.size >= room.players.size) {
      endRound(room);
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`50/50 running at http://localhost:${PORT}`));
