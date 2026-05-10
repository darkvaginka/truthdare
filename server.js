/**
 * Truth or Dare — Backend Server
 * WebSocket rooms + Stars payments + PostgreSQL premium storage
 * FIX: reconnect grace period, name-based rejoin, auto-skip disconnected player
 */

const express  = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const cors     = require('cors');
const http     = require('http');
const crypto   = require('crypto');
const { Pool } = require('pg');

const PORT      = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';

/* ============================================
   LOGGER
============================================ */
function _log(level, args) {
  const ts = new Date().toISOString();
  const out = level === 'ERROR' ? console.error : (level === 'WARN' ? console.warn : console.log);
  out(`[${ts}] [${level}]`, ...args);
}
const logger = {
  info:  (...a) => _log('INFO',  a),
  warn:  (...a) => _log('WARN',  a),
  error: (...a) => _log('ERROR', a),
};

/* ============================================
   POSTGRESQL
============================================ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS premium_users (
      user_id     TEXT PRIMARY KEY,
      plan        TEXT NOT NULL,
      purchased_at BIGINT NOT NULL,
      expires_at  BIGINT
    )
  `);
  logger.info('[DB] PostgreSQL ready');
}

async function getPremiumStatus(userId) {
  try {
    const res = await pool.query('SELECT * FROM premium_users WHERE user_id = $1', [String(userId)]);
    if (!res.rows.length) return { isPremium: false };
    const r = res.rows[0];
    if (r.plan === 'forever') return { isPremium: true, plan: 'forever', expiresAt: null };
    const expiresAt = Number(r.expires_at);
    if (expiresAt && Date.now() < expiresAt) return { isPremium: true, plan: 'month', expiresAt };
    return { isPremium: false, plan: 'expired', expiresAt };
  } catch(e) {
    logger.error('[DB] getPremiumStatus error:', e.message);
    return { isPremium: false };
  }
}

async function activatePremium(userId, plan) {
  const uid = String(userId);
  const now = Date.now();
  let expiresAt = null;

  if (plan === 'month') {
    const existing = await getPremiumStatus(uid);
    const base = (existing.isPremium && existing.plan === 'month' && existing.expiresAt > now)
      ? existing.expiresAt : now;
    expiresAt = base + 30 * 24 * 60 * 60 * 1000;
  }

  await pool.query(`
    INSERT INTO premium_users (user_id, plan, purchased_at, expires_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id) DO UPDATE
      SET plan = EXCLUDED.plan,
          purchased_at = EXCLUDED.purchased_at,
          expires_at = CASE
            WHEN premium_users.plan = 'forever' THEN NULL
            ELSE EXCLUDED.expires_at
          END
  `, [uid, plan, now, expiresAt]);

  logger.info(`[Premium] Activated uid=${uid} plan=${plan} expires=${expiresAt}`);
  const finalStatus = await getPremiumStatus(uid);
  return finalStatus;
}

/* ============================================
   EXPRESS APP
============================================ */
const app    = express();
const server = http.createServer(app);
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (_, res) => res.json({ ok: true, service: 'ToD Server', rooms: rooms.size }));
app.post('/webhook', handleBotWebhook);

/* ============================================
   STARS PAYMENTS
============================================ */
const PREMIUM_PLANS = {
  forever: { stars: 299, label: 'Premium навсегда',   labelEn: 'Premium Forever'  },
  month:   { stars: 49,  label: 'Premium на 30 дней', labelEn: 'Premium 30 days'  },
};

app.post('/create-invoice', async (req, res) => {
  const { plan, lang, userId } = req.body;
  const p = PREMIUM_PLANS[plan];
  if (!p) {
    logger.warn(`[Payment] Invalid plan requested uid=${userId} plan=${plan}`);
    return res.status(400).json({ error: 'Invalid plan' });
  }
  logger.info(`[Payment] Invoice requested uid=${userId} plan=${plan} stars=${p.stars}`);

  const isRu = lang === 'ru';
  let description = isRu
    ? 'Все категории, до 10 игроков, без ограничений'
    : 'All categories, up to 10 players, no limits';

  if (plan === 'month' && userId) {
    const status = await getPremiumStatus(userId);
    if (status.isPremium && status.plan === 'month') {
      const d = new Date(status.expiresAt + 30*24*60*60*1000);
      description = isRu
        ? `Продление до ${d.toLocaleDateString('ru-RU')}`
        : `Extends to ${d.toLocaleDateString('en-US')}`;
    }
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title:       isRu ? '⭐ Правда или Действие Premium' : '⭐ Truth or Dare Premium',
        description,
        payload:     `premium_${plan}_${userId||'anon'}_${Date.now()}`,
        currency:    'XTR',
        prices:      [{ label: isRu ? p.label : p.labelEn, amount: p.stars }],
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      logger.error(`[Payment] createInvoiceLink failed uid=${userId} plan=${plan} reason=${data.description}`);
      return res.status(500).json({ error: data.description });
    }
    logger.info(`[Payment] Invoice created uid=${userId} plan=${plan}`);
    res.json({ invoiceLink: data.result });
  } catch(e) {
    logger.error(`[Payment] Invoice creation error uid=${userId} plan=${plan}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/premium-status', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'No userId' });
  const status = await getPremiumStatus(userId);
  res.json(status);
});

app.post('/admin/grant-premium', async (req, res) => {
  const { secret, userId, plan } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!userId || !plan) return res.status(400).json({ error: 'Missing userId or plan' });
  const status = await activatePremium(userId, plan);
  res.json({ ok: true, status });
});

/* ============================================
   ROOM STATE
============================================ */
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

function createRoom(hostWs, hostName, hostAvatar, categories, maxPlayers, gameMode, penalty, hostIsPremium) {
  let code; do { code = genCode(); } while (rooms.has(code));
  const room = {
    code, hostId: hostWs.clientId, maxPlayers, gameMode,
    penalty: penalty||null, categories: categories||['friends','family'],
    hostIsPremium: hostIsPremium||false,
    players: [{ id: hostWs.clientId, name: hostName, avatar: hostAvatar, score: 0, ws: hostWs }],
    started: false, currentIdx: 0, round: 1, turn: 1, usedCards: {}, currentCard: null, createdAt: Date.now(),
    _disconnectTimers: {},  // таймеры реконнекта по clientId
    _autoSkipTimers: {},    // таймеры автопропуска хода
  };
  rooms.set(code, room);
  hostWs.roomCode = code;
  logger.info(`[Room ${code}] Created host="${hostName}" categories=[${(categories||[]).join(',')}] mode=${gameMode} max=${maxPlayers} totalRooms=${rooms.size}`);
  // Автоудаление комнаты через 4 часа
  setTimeout(() => {
    if (rooms.has(code)) {
      logger.warn(`[Room ${code}] Expired after 4h — deleting`);
      broadcast(room, {type:'room_expired'});
      rooms.delete(code);
    }
  }, 4*60*60*1000);
  return room;
}

function broadcast(room, msg, excludeId=null) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.id !== excludeId && p.ws?.readyState === WebSocket.OPEN) p.ws.send(data);
  });
}

function sendTo(ws, msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function roomPublicState(room) {
  return {
    code: room.code, gameMode: room.gameMode, penalty: room.penalty,
    categories: room.categories, maxPlayers: room.maxPlayers, started: room.started,
    currentIdx: room.currentIdx, round: room.round, turn: room.turn,
    currentCard: room.currentCard || null,
    hostIsPremium: room.hostIsPremium || false,
    players: room.players.map(p => ({ id:p.id, name:p.name, avatar:p.avatar, score:p.score })),
  };
}

/* ============================================
   WEBSOCKET SERVER
============================================ */
const wss = new WebSocketServer({ server, verifyClient: () => true });

wss.on('connection', (ws) => {
  ws.clientId = crypto.randomUUID();
  ws.isAlive   = true;
  logger.info(`[WS] Client connected id=${ws.clientId} totalClients=${wss.clients.size}`);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => { try { handleMessage(ws, JSON.parse(raw)); } catch(e) { logger.error(`[WS] msg parse error id=${ws.clientId}:`, e.message); } });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (e) => logger.error(`[WS] socket error id=${ws.clientId}:`, e.message));
});

// Heartbeat — проверяем живые соединения каждые 30 сек
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      logger.warn(`[WS] Heartbeat timeout — terminating id=${ws.clientId}`);
      ws.terminate();
      return;
    }
    ws.isAlive = false; ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

/* ============================================
   MESSAGE HANDLER
============================================ */
function handleMessage(ws, msg) {
  switch(msg.type) {

    case 'create_room': {
      if (!msg.name) return sendTo(ws, {type:'error', code:'NO_NAME'});
      const room = createRoom(
        ws, msg.name, msg.avatar||'😀',
        msg.categories, msg.maxPlayers||5,
        msg.gameMode||'turns', msg.penalty,
        msg.hostIsPremium||false
      );
      sendTo(ws, {type:'room_created', state:roomPublicState(room), myId:ws.clientId});
      break;
    }

    case 'join_room': {
      const code = msg.code?.toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        logger.warn(`[Room ${code}] Join failed — not found name="${msg.name}"`);
        return sendTo(ws, {type:'error', code:'ROOM_NOT_FOUND'});
      }
      if (room.started && !room.players.find(p => p.name === msg.name)) {
        logger.warn(`[Room ${code}] Join rejected — game in progress name="${msg.name}"`);
        return sendTo(ws, {type:'error', code:'GAME_STARTED'});
      }

      // FIX: ищем по clientId ИЛИ по имени (реконнект после обрыва соединения)
      const existing = room.players.find(
        p => p.id === ws.clientId || (!p.ws || p.ws.readyState !== WebSocket.OPEN) && p.name === msg.name
      );

      if (existing) {
        // Отменяем таймеры реконнекта и автопропуска
        if (room._disconnectTimers[existing.id]) {
          clearTimeout(room._disconnectTimers[existing.id]);
          delete room._disconnectTimers[existing.id];
        }
        if (room._autoSkipTimers[existing.id]) {
          clearTimeout(room._autoSkipTimers[existing.id]);
          delete room._autoSkipTimers[existing.id];
        }
        existing.ws = ws;
        existing.id = ws.clientId;
        ws.roomCode = code;
        sendTo(ws, {type:'rejoined', state:roomPublicState(room), myId:ws.clientId});
        broadcast(room, {type:'player_rejoined', name:existing.name}, ws.clientId);
        logger.info(`[Room ${code}] Player rejoined name="${existing.name}" id=${ws.clientId}`);
        return;
      }

      // Новый игрок
      if (!room.started && room.players.length >= room.maxPlayers) {
        logger.warn(`[Room ${code}] Join rejected — room full name="${msg.name}" max=${room.maxPlayers}`);
        return sendTo(ws, {type:'error', code:'ROOM_FULL'});
      }
      const player = { id:ws.clientId, name:msg.name, avatar:msg.avatar||'😀', score:0, ws };
      room.players.push(player);
      ws.roomCode = code;
      sendTo(ws, {type:'room_joined', state:roomPublicState(room), myId:ws.clientId});
      broadcast(room, {
        type:'player_joined',
        player:{ id:ws.clientId, name:msg.name, avatar:msg.avatar||'😀', score:0 },
        state:roomPublicState(room),
      }, ws.clientId);
      logger.info(`[Room ${code}] Player joined name="${msg.name}" id=${ws.clientId} players=${room.players.length}/${room.maxPlayers}`);
      break;
    }

    case 'update_settings': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.hostId !== ws.clientId || room.started) return;
      ['categories','gameMode','penalty','maxPlayers'].forEach(k => {
        if (msg[k] !== undefined) room[k] = msg[k];
      });
      broadcast(room, {type:'settings_updated', state:roomPublicState(room)});
      break;
    }

    case 'start_game': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.hostId !== ws.clientId) return;
      if (room.players.length < 2) return sendTo(ws, {type:'error', code:'NEED_MORE_PLAYERS'});
      if (msg.gameMode)              room.gameMode   = msg.gameMode;
      if (msg.penalty !== undefined) room.penalty    = msg.penalty;
      if (msg.categories)            room.categories = msg.categories;
      room.started = true; room.currentIdx = 0; room.round = 1; room.turn = 1; room.usedCards = {};
      room.currentCard = null;
      room.players.forEach(p => { p.score = 0; });
      broadcast(room, {type:'game_started', state:roomPublicState(room)});
      logger.info(`[Room ${room.code}] Game started players=${room.players.length} mode=${room.gameMode} categories=[${room.categories.join(',')}]`);
      break;
    }

    case 'pick_type': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started) return;
      if (room.players[room.currentIdx]?.id !== ws.clientId) return;
      room.currentCard = { type: msg.cardType, text: msg.cardText, playerId: ws.clientId };
      broadcast(room, {type:'type_picked', cardType:msg.cardType, cardText:msg.cardText, playerId:ws.clientId});
      break;
    }

    case 'task_result': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started) return;
      if (room.players[room.currentIdx]?.id !== ws.clientId) return;
      const delta = msg.result === 'complete' ? 2 : -1;
      room.players[room.currentIdx].score += delta;
      room.currentCard = null;
      advanceRoomTurn(room);
      broadcast(room, {type:'turn_result', result:msg.result, delta, state:roomPublicState(room)});
      break;
    }

    case 'reaction': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const player = room.players.find(p => p.id === ws.clientId);
      if (player) broadcast(room, {type:'reaction', emoji:msg.emoji, name:player.name, avatar:player.avatar}, ws.clientId);
      break;
    }

    case 'leave_room':
      handleDisconnect(ws);
      break;

    case 'ping':
      sendTo(ws, {type:'pong'});
      break;
  }
}

/* ============================================
   ADVANCE TURN (вынесено для переиспользования)
============================================ */
function advanceRoomTurn(room) {
  room.turn++;
  if (room.turn > room.players.length) { room.turn = 1; room.round++; }
  room.currentIdx = (room.currentIdx + 1) % room.players.length;
}

/* ============================================
   DISCONNECT HANDLER
   FIX: grace period 90 сек, автопропуск хода через 15 сек
============================================ */
function handleDisconnect(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const idx = room.players.findIndex(p => p.id === ws.clientId);
  if (idx === -1) return;
  const player = room.players[idx];

  // --- Лобби: удаляем игрока сразу ---
  if (!room.started) {
    room.players.splice(idx, 1);
    if (!room.players.length) {
      logger.info(`[Room ${code}] Empty after lobby leave — deleting (totalRooms=${rooms.size - 1})`);
      rooms.delete(code);
      return;
    }
    if (room.hostId === ws.clientId) {
      room.hostId = room.players[0].id;
      broadcast(room, {type:'host_changed', newHostId:room.hostId});
      logger.info(`[Room ${code}] Host changed to name="${room.players[0].name}"`);
    }
    broadcast(room, {type:'player_left', name:player.name, state:roomPublicState(room)});
    logger.info(`[Room ${code}] Player left lobby name="${player.name}" remaining=${room.players.length}`);
    return;
  }

  // --- Игра запущена: даём 90 сек на реконнект ---
  player.ws = null;
  broadcast(room, {type:'player_offline', name:player.name, playerId:ws.clientId});
  logger.warn(`[Room ${code}] Player offline name="${player.name}" — grace period 90s`);

  // Если сейчас ход этого игрока — через 15 сек автопропуск
  if (room.players[room.currentIdx]?.id === ws.clientId) {
    room._autoSkipTimers[ws.clientId] = setTimeout(() => {
      const r = rooms.get(code);
      if (!r) return;
      const p = r.players[r.currentIdx];
      // Пропускаем только если это всё ещё его ход и он offline
      if (!p || p.id !== ws.clientId || (p.ws?.readyState === WebSocket.OPEN)) return;
      logger.warn(`[Room ${code}] Auto-skip offline player name="${p.name}" (-1 score)`);
      p.score -= 1;
      advanceRoomTurn(r);
      broadcast(r, {type:'turn_result', result:'disconnect_skip', delta:-1, state:roomPublicState(r)});
    }, 15000);
  }

  // Через 90 сек — если не вернулся, удаляем из комнаты
  room._disconnectTimers[ws.clientId] = setTimeout(() => {
    const r = rooms.get(code);
    if (!r) return;
    const pi = r.players.findIndex(p => p.id === ws.clientId);
    if (pi === -1) return;
    const offline = r.players[pi];
    // Если успел переподключиться — WS будет живой
    if (offline.ws?.readyState === WebSocket.OPEN) return;
    logger.info(`[Room ${code}] Player removed after 90s timeout name="${offline.name}"`);
    r.players.splice(pi, 1);
    if (!r.players.length) {
      logger.info(`[Room ${code}] Empty after timeout — deleting (totalRooms=${rooms.size - 1})`);
      rooms.delete(code);
      return;
    }
    // Корректируем currentIdx если надо
    if (r.currentIdx >= r.players.length) r.currentIdx = 0;
    if (r.hostId === ws.clientId && r.players.length) {
      r.hostId = r.players[0].id;
      broadcast(r, {type:'host_changed', newHostId:r.hostId});
      logger.info(`[Room ${code}] Host changed to name="${r.players[0].name}"`);
    }
    broadcast(r, {type:'player_left', name:offline.name, state:roomPublicState(r)});
  }, 90000);

  // Если все offline — удаляем комнату через 10 минут
  const allOffline = room.players.every(p => !p.ws || p.ws.readyState !== WebSocket.OPEN);
  if (allOffline) {
    setTimeout(() => {
      const r = rooms.get(code);
      if (!r) return;
      const anyOnline = r.players.some(p => p.ws?.readyState === WebSocket.OPEN);
      if (!anyOnline) { logger.warn(`[Room ${code}] All offline 10min — deleting (totalRooms=${rooms.size - 1})`); rooms.delete(code); }
    }, 10 * 60 * 1000);
  }
}

/* ============================================
   TELEGRAM BOT WEBHOOK
============================================ */
async function handleBotWebhook(req, res) {
  res.json({ ok: true });
  const update = req.body;

  if (update.pre_checkout_query) {
    const pq = update.pre_checkout_query;
    logger.info(`[Payment] pre_checkout_query uid=${pq.from?.id} payload=${pq.invoice_payload} amount=${pq.total_amount} ${pq.currency}`);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: pq.id, ok: true }),
    });
    return;
  }

  if (update.message?.successful_payment) {
    const userId  = String(update.message.from.id);
    const payload = update.message.successful_payment.invoice_payload;
    const plan    = payload.includes('forever') ? 'forever' : 'month';
    const amount  = update.message.successful_payment.total_amount;
    logger.info(`[Payment] successful_payment uid=${userId} plan=${plan} amount=${amount} ⭐ payload=${payload}`);
    const status  = await activatePremium(userId, plan);
    const expireStr = status.expiresAt
      ? new Date(status.expiresAt).toLocaleDateString('ru-RU') : null;
    await botSend(update.message.chat.id, {
      text: plan === 'forever'
        ? '🎉 Premium активирован навсегда!\nВсе категории разблокированы ⭐'
        : `🎉 Premium активирован!\nДействует до: ${expireStr} ⭐\nДля продления купи снова — дни добавятся.`,
    });
    return;
  }

  if (!update?.message?.text) return;
  const { chat, text, from } = update.message;

  if (text.startsWith('/start')) {
    await botSend(chat.id, botStartMessage());
  } else if (text === '/help') {
    await botSend(chat.id, botHelpMessage());
  } else if (text === '/premium') {
    const status = await getPremiumStatus(String(from.id));
    const expireStr = status.expiresAt
      ? `до ${new Date(status.expiresAt).toLocaleDateString('ru-RU')}` : 'навсегда';
    await botSend(chat.id, {
      text: status.isPremium
        ? `⭐ Premium активен ${expireStr}!`
        : '❌ Premium не активен',
    });
  }
}

function botStartMessage() {
  return {
    text: '🔥 *Правда или Действие*\n\nНажми кнопку ниже чтобы начать игру!',
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: '🎮 Открыть игру',
        web_app: { url: process.env.WEBAPP_URL || 'https://truthdare-dusky.vercel.app' },
      }]],
    },
  };
}

function botHelpMessage() {
  return {
    text: '🎮 *Правда или Действие*\n\n• Создай комнату, пригласи друзей\n• Каждый играет со своего телефона\n\n⭐ Premium: все категории, до 10 игроков\n\n/premium — статус подписки',
    parse_mode: 'Markdown',
  };
}

async function botSend(chatId, payload) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, ...payload }),
    });
  } catch(e) { logger.error('[Bot] sendMessage error:', e.message); }
}

/* ============================================
   START
============================================ */
initDB().then(() => {
  server.listen(PORT, () => {
    logger.info(`[Server] ToD Server started on port ${PORT}`);
    logger.info(`[Server] Bot token: ${BOT_TOKEN ? 'configured' : 'NOT SET'}`);
    logger.info(`[Server] Webapp URL: ${process.env.WEBAPP_URL || 'https://truthdare-dusky.vercel.app (default)'}`);
  });
}).catch(e => {
  logger.error('[DB] Init failed:', e.message);
  process.exit(1);
});
