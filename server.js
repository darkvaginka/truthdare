/**
 * Truth or Dare — Backend Server
 * WebSocket rooms + REST health check
 * Deploy to Railway / Render / Fly.io
 */

const express  = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const cors     = require('cors');
const http     = require('http');
const crypto   = require('crypto');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';

/* ============================================
   EXPRESS APP
============================================ */
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (_, res) => res.json({ ok: true, service: 'ToD Server', rooms: rooms.size }));

// Webhook for Telegram Bot
app.post('/webhook', handleBotWebhook);

/* ============================================
   ROOM STATE
   rooms: Map<code, Room>
============================================ */
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function createRoom(hostWs, hostName, hostAvatar, categories, maxPlayers, gameMode, penalty) {
  let code;
  do { code = genCode(); } while (rooms.has(code));

  const room = {
    code,
    hostId: hostWs.clientId,
    maxPlayers,
    gameMode,
    penalty: penalty || null,
    categories: categories || ['friends', 'family'],
    players: [{
      id:     hostWs.clientId,
      name:   hostName,
      avatar: hostAvatar,
      score:  0,
      ws:     hostWs,
    }],
    // Game state
    started:      false,
    currentIdx:   0,
    round:        1,
    turn:         1,
    usedCards:    {},
    createdAt:    Date.now(),
  };

  rooms.set(code, room);
  hostWs.roomCode = code;

  // Auto-cleanup after 4 hours
  setTimeout(() => {
    if (rooms.has(code)) {
      broadcast(room, { type: 'room_expired' });
      rooms.delete(code);
    }
  }, 4 * 60 * 60 * 1000);

  return room;
}

/* ============================================
   BROADCAST HELPERS
============================================ */
function broadcast(room, msg, excludeId = null) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.id !== excludeId && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  });
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function roomPublicState(room) {
  return {
    code:        room.code,
    gameMode:    room.gameMode,
    penalty:     room.penalty,
    categories:  room.categories,
    maxPlayers:  room.maxPlayers,
    started:     room.started,
    currentIdx:  room.currentIdx,
    round:       room.round,
    turn:        room.turn,
    players:     room.players.map(p => ({
      id:     p.id,
      name:   p.name,
      avatar: p.avatar,
      score:  p.score,
    })),
  };
}

/* ============================================
   WEBSOCKET SERVER
============================================ */
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.clientId = crypto.randomUUID();
  ws.isAlive   = true;

  console.log(`[WS] Connected: ${ws.clientId}`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (e) => console.error('[WS] Error:', e.message));
});

// Heartbeat — kick dead connections every 30s
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

/* ============================================
   MESSAGE HANDLER
============================================ */
function handleMessage(ws, msg) {
  const { type } = msg;

  switch (type) {

    // ── Create room ──────────────────────────
    case 'create_room': {
      const { name, avatar, categories, maxPlayers, gameMode, penalty } = msg;
      if (!name) return sendTo(ws, { type: 'error', code: 'NO_NAME' });

      const room = createRoom(ws, name, avatar || '😀', categories, maxPlayers || 5, gameMode || 'turns', penalty);

      sendTo(ws, {
        type:  'room_created',
        state: roomPublicState(room),
        myId:  ws.clientId,
      });

      console.log(`[Room] Created: ${room.code} by ${name}`);
      break;
    }

    // ── Join room ────────────────────────────
    case 'join_room': {
      const { code, name, avatar } = msg;
      const room = rooms.get(code?.toUpperCase());

      if (!room)          return sendTo(ws, { type: 'error', code: 'ROOM_NOT_FOUND' });
      if (room.started)   return sendTo(ws, { type: 'error', code: 'GAME_STARTED' });
      if (room.players.length >= room.maxPlayers)
                          return sendTo(ws, { type: 'error', code: 'ROOM_FULL' });

      // Reconnect if same name
      const existing = room.players.find(p => p.name === name);
      if (existing) {
        existing.ws = ws;
        existing.id = ws.clientId;
        ws.roomCode  = code;
        sendTo(ws, { type: 'rejoined', state: roomPublicState(room), myId: ws.clientId });
        broadcast(room, { type: 'player_rejoined', name }, ws.clientId);
        return;
      }

      const player = { id: ws.clientId, name, avatar: avatar || '😀', score: 0, ws };
      room.players.push(player);
      ws.roomCode = code;

      sendTo(ws, { type: 'room_joined', state: roomPublicState(room), myId: ws.clientId });
      broadcast(room, {
        type:   'player_joined',
        player: { id: ws.clientId, name, avatar: avatar || '😀', score: 0 },
        state:  roomPublicState(room),
      }, ws.clientId);

      console.log(`[Room] ${name} joined ${code} (${room.players.length}/${room.maxPlayers})`);
      break;
    }

    // ── Update room settings (host only) ─────
    case 'update_settings': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.hostId !== ws.clientId) return;
      if (room.started) return;

      const allowed = ['categories','gameMode','penalty','maxPlayers'];
      allowed.forEach(k => { if (msg[k] !== undefined) room[k] = msg[k]; });

      broadcast(room, { type: 'settings_updated', state: roomPublicState(room) });
      break;
    }

    // ── Start game (host only) ───────────────
    case 'start_game': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.hostId !== ws.clientId) return;
      if (room.players.length < 2) return sendTo(ws, { type: 'error', code: 'NEED_MORE_PLAYERS' });

      room.started    = true;
      room.currentIdx = 0;
      room.round      = 1;
      room.turn       = 1;
      room.usedCards  = {};
      room.players.forEach(p => { p.score = 0; });

      broadcast(room, { type: 'game_started', state: roomPublicState(room) });
      console.log(`[Room] Game started: ${room.code}`);
      break;
    }

    // ── Player picked card type ──────────────
    case 'pick_type': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started) return;
      const currentPlayer = room.players[room.currentIdx];
      if (currentPlayer.id !== ws.clientId) return; // not your turn

      broadcast(room, {
        type:     'type_picked',
        cardType: msg.cardType, // 'truth' | 'dare'
        playerId: ws.clientId,
      });
      break;
    }

    // ── Task completed / refused / skipped ───
    case 'task_result': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started) return;
      const currentPlayer = room.players[room.currentIdx];
      if (currentPlayer.id !== ws.clientId) return;

      const { result } = msg; // 'complete' | 'refuse' | 'skip'
      const delta = result === 'complete' ? 2 : -1;
      currentPlayer.score += delta;

      // Advance turn
      room.turn++;
      if (room.turn > room.players.length) { room.turn = 1; room.round++; }
      room.currentIdx = (room.currentIdx + 1) % room.players.length;

      broadcast(room, {
        type:   'turn_result',
        result,
        delta,
        state:  roomPublicState(room),
      });
      break;
    }

    // ── Chat / reaction ──────────────────────
    case 'reaction': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const player = room.players.find(p => p.id === ws.clientId);
      if (!player) return;
      broadcast(room, {
        type:     'reaction',
        emoji:    msg.emoji,
        name:     player.name,
        avatar:   player.avatar,
      }, ws.clientId);
      break;
    }

    // ── Leave room ───────────────────────────
    case 'leave_room': {
      handleDisconnect(ws);
      break;
    }

    // ── Ping ────────────────────────────────
    case 'ping': {
      sendTo(ws, { type: 'pong' });
      break;
    }

    default:
      console.warn('[WS] Unknown message type:', type);
  }
}

/* ============================================
   DISCONNECT HANDLER
============================================ */
function handleDisconnect(ws) {
  const code = ws.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  if (!room) return;

  const idx = room.players.findIndex(p => p.id === ws.clientId);
  if (idx === -1) return;

  const player = room.players[idx];
  console.log(`[Room] ${player.name} disconnected from ${code}`);

  // If game not started — remove completely
  if (!room.started) {
    room.players.splice(idx, 1);
    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }
    // Transfer host if needed
    if (room.hostId === ws.clientId) {
      room.hostId = room.players[0].id;
      broadcast(room, { type: 'host_changed', newHostId: room.hostId });
    }
    broadcast(room, { type: 'player_left', name: player.name, state: roomPublicState(room) });
    return;
  }

  // Game started — keep player but mark offline
  player.ws = null;
  broadcast(room, { type: 'player_offline', name: player.name, playerId: ws.clientId });

  // If all players offline — delete room after 10 min
  const allOffline = room.players.every(p => !p.ws || p.ws.readyState !== WebSocket.OPEN);
  if (allOffline) {
    setTimeout(() => {
      if (rooms.has(code)) {
        const r = rooms.get(code);
        const stillAllOffline = r.players.every(p => !p.ws || p.ws.readyState !== WebSocket.OPEN);
        if (stillAllOffline) rooms.delete(code);
      }
    }, 10 * 60 * 1000);
  }
}

/* ============================================
   TELEGRAM BOT WEBHOOK
============================================ */
async function handleBotWebhook(req, res) {
  res.json({ ok: true }); // respond fast

  const update = req.body;
  if (!update?.message) return;

  const msg  = update.message;
  const chat = msg.chat.id;
  const text = msg.text || '';

  // Commands
  if (text === '/start') {
    await botSend(chat, botStartMessage());
  } else if (text === '/help') {
    await botSend(chat, botHelpMessage());
  }
}

function botStartMessage() {
  return {
    text: '🔥 *Правда или Действие*\n\nНажми кнопку ниже чтобы начать игру!',
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: '🎮 Открыть игру',
        web_app: { url: process.env.WEBAPP_URL || 'https://your-app.vercel.app' },
      }]]
    }
  };
}

function botHelpMessage() {
  return {
    text: '🎮 *Правда или Действие* — игра для компании!\n\n' +
          '• Создай комнату и пригласи друзей\n' +
          '• Каждый играет со своего телефона\n' +
          '• Выбирай наказание и режим игры\n\n' +
          '⭐ Premium даёт доступ к горячим категориям, больше игроков и AI-вопросы',
    parse_mode: 'Markdown',
  };
}

async function botSend(chatId, payload) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, ...payload }),
    });
  } catch(e) {
    console.error('[Bot] Send error:', e.message);
  }
}

/* ============================================
   START
============================================ */
server.listen(PORT, () => {
  console.log(`\n🔥 ToD Server running on port ${PORT}`);
  console.log(`   Rooms: 0`);
  console.log(`   Bot token: ${BOT_TOKEN ? '✅ set' : '❌ not set'}\n`);
});
