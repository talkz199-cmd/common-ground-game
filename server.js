const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024 // allow selfie photos through the socket
});

const PORT = process.env.PORT || 3000;
const GAME_DURATION_MS = 4 * 60 * 1000; // 4 minutes
const END_COUNTDOWN_MS = 10 * 1000; // 10 seconds
const MAX_PER_PAIR = 3;
const START_CODE = '4788';
const EXTEND_MS = 2 * 60 * 1000; // 2 minutes
const ARMY_WORDS = ['צבא', 'צה"ל', 'צהל', 'יחידה', 'גדוד', 'פלוגה', 'מילואים', 'שירות צבאי', 'טירונות', 'קורס קצינים', 'סדיר', 'יעל', 'סמור', 'ספ', 'מסלול', 'צוות', 'בסיס', 'מחלקה', 'קצין', 'קצונה', 'סמל'];

app.use(express.static(path.join(__dirname, 'public')));

// ---- In-memory game state (single room, single game at a time) ----
/** @type {Map<string, {id:string,name:string,team:string,photo:string,connections:Object<string, {texts:string[]}>, online:boolean, joinOrder:number}>} */
const players = new Map();
const socketIdToPlayerId = new Map();
let joinCounter = 0;

let game = {
  status: 'lobby', // lobby | running | timeup | ended
  startTime: null,
  endsAt: null,
  hostId: null
};
let timeUpTimer = null;
let endGameTimer = null;

function scoreOf(player) {
  let total = 0;
  for (const key of Object.keys(player.connections)) {
    total += player.connections[key].texts.length;
  }
  return total;
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    team: p.team,
    photo: p.photo,
    score: scoreOf(p),
    online: p.online
  };
}

function broadcastRoster() {
  io.emit('roster', Array.from(players.values())
    .sort((a, b) => a.joinOrder - b.joinOrder)
    .map(publicPlayer));
}

function broadcastGameState() {
  io.emit('gameState', game);
}

function resetGame() {
  clearTimeout(timeUpTimer);
  clearTimeout(endGameTimer);
  players.clear();
  socketIdToPlayerId.clear();
  joinCounter = 0;
  game = { status: 'lobby', startTime: null, endsAt: null, hostId: null };
  broadcastGameState();
  broadcastRoster();
}

function scheduleTimeUp(ms) {
  clearTimeout(timeUpTimer);
  timeUpTimer = setTimeout(() => {
    game.status = 'timeup';
    broadcastGameState();
    endGameTimer = setTimeout(endGame, END_COUNTDOWN_MS);
  }, ms);
}

function startGame(hostId) {
  if (game.status !== 'lobby') return;
  game.status = 'running';
  game.startTime = Date.now();
  game.endsAt = game.startTime + GAME_DURATION_MS;
  game.hostId = hostId;
  broadcastGameState();
  scheduleTimeUp(GAME_DURATION_MS);
}

function extendGame() {
  if (game.status !== 'running' && game.status !== 'timeup') return false;
  clearTimeout(endGameTimer);
  const now = Date.now();
  const base = Math.max(game.endsAt, now);
  game.endsAt = base + EXTEND_MS;
  game.status = 'running';
  broadcastGameState();
  scheduleTimeUp(game.endsAt - now);
  return true;
}

function endGame() {
  game.status = 'ended';
  const list = Array.from(players.values()).map(publicPlayer);
  list.sort((a, b) => b.score - a.score);
  const topScore = list.length ? list[0].score : 0;
  const winners = list.length ? list.filter(p => p.score === topScore) : [];
  io.emit('gameEnded', { winners, leaderboard: list });
  broadcastGameState();
}

io.on('connection', (socket) => {
  socket.on('join', (data = {}) => {
    const name = String(data.name || '').trim().slice(0, 30);
    const team = String(data.team || '').trim().slice(0, 30);
    const photo = typeof data.photo === 'string' ? data.photo.slice(0, 400000) : null;
    if (!name || !photo) {
      socket.emit('joinError', { reason: 'missing-fields' });
      return;
    }

    let playerId = data.playerId && players.has(data.playerId) ? data.playerId : null;

    if (playerId) {
      const existing = players.get(playerId);
      existing.name = name;
      existing.team = team;
      existing.photo = photo;
      existing.online = true;
    } else {
      playerId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      players.set(playerId, {
        id: playerId,
        name,
        team,
        photo,
        connections: {},
        online: true,
        joinOrder: joinCounter++
      });
    }

    socketIdToPlayerId.set(socket.id, playerId);
    socket.emit('joined', { playerId, you: publicPlayer(players.get(playerId)), gameState: game });
    broadcastRoster();
  });

  socket.on('startGame', (data = {}) => {
    const playerId = socketIdToPlayerId.get(socket.id);
    if (!playerId) return;
    const code = String(data.code || '').trim();
    if (code !== START_CODE) {
      socket.emit('startError', { reason: 'wrong-code' });
      return;
    }
    startGame(playerId);
  });

  socket.on('extendTime', () => {
    const playerId = socketIdToPlayerId.get(socket.id);
    if (!playerId || playerId !== game.hostId) {
      socket.emit('extendError', { reason: 'not-host' });
      return;
    }
    const ok = extendGame();
    if (!ok) socket.emit('extendError', { reason: 'not-active' });
  });

  socket.on('endNow', () => {
    const playerId = socketIdToPlayerId.get(socket.id);
    if (!playerId || playerId !== game.hostId) {
      socket.emit('endNowError', { reason: 'not-host' });
      return;
    }
    if (game.status !== 'running' && game.status !== 'timeup') {
      socket.emit('endNowError', { reason: 'not-active' });
      return;
    }
    clearTimeout(timeUpTimer);
    clearTimeout(endGameTimer);
    endGame();
  });

  socket.on('addCommon', (data = {}) => {
    const fromId = socketIdToPlayerId.get(socket.id);
    const toId = data.toId;
    const text = String(data.text || '').trim().slice(0, 120);

    if (!fromId || !players.has(fromId)) {
      socket.emit('commonAck', { ok: false, toId, reason: 'not-joined' });
      return;
    }
    if (game.status !== 'running') {
      socket.emit('commonAck', { ok: false, toId, reason: 'not-running' });
      return;
    }
    if (!text) {
      socket.emit('commonAck', { ok: false, toId, reason: 'empty' });
      return;
    }
    if (ARMY_WORDS.some(w => text.includes(w))) {
      socket.emit('commonAck', { ok: false, toId, reason: 'army-word' });
      return;
    }
    if (!toId || !players.has(toId) || toId === fromId) {
      socket.emit('commonAck', { ok: false, toId, reason: 'invalid-target' });
      return;
    }

    const from = players.get(fromId);
    const to = players.get(toId);

    if (from.team && to.team && from.team.toLowerCase() === to.team.toLowerCase()) {
      socket.emit('commonAck', { ok: false, toId, reason: 'same-team' });
      return;
    }

    if (!from.connections[toId]) from.connections[toId] = { texts: [] };
    if (from.connections[toId].texts.length >= MAX_PER_PAIR) {
      socket.emit('commonAck', { ok: false, toId, reason: 'max-reached' });
      return;
    }

    from.connections[toId].texts.push(text);
    const count = from.connections[toId].texts.length;
    const score = scoreOf(from);
    socket.emit('commonAck', { ok: true, toId, count, score, texts: from.connections[toId].texts });
    broadcastRoster();
  });

  socket.on('requestState', () => {
    const playerId = socketIdToPlayerId.get(socket.id);
    socket.emit('gameState', game);
    broadcastRoster();
    if (playerId && players.has(playerId)) {
      const p = players.get(playerId);
      socket.emit('yourConnections', p.connections);
    }
  });

  socket.on('newGame', () => {
    const playerId = socketIdToPlayerId.get(socket.id);
    if (!playerId || playerId !== game.hostId) {
      socket.emit('newGameError', { reason: 'not-host' });
      return;
    }
    resetGame();
  });

  socket.on('disconnect', () => {
    const playerId = socketIdToPlayerId.get(socket.id);
    socketIdToPlayerId.delete(socket.id);
    if (playerId && players.has(playerId)) {
      // only mark offline if no other socket maps to this player
      const stillConnected = Array.from(socketIdToPlayerId.values()).includes(playerId);
      if (!stillConnected) {
        players.get(playerId).online = false;
        broadcastRoster();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Common Ground game server running on port ${PORT}`);
});
