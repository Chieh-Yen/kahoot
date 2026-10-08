'use strict';
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game } = require('./src/game');
const { normalizeQuiz } = require('./src/quiz');
const { Store } = require('./src/store');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const HOST_PASSWORD = process.env.HOST_PASSWORD || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GAME_IDLE_MS = 6 * 60 * 60 * 1000;
const ENDED_GAME_TTL_MS = 2 * 60 * 60 * 1000;

const store = new Store(DATA_DIR, path.join(__dirname, 'samples'));
const games = new Map(); // pin -> Game

// ---------- helpers ----------

function checkPassword(pw) {
  if (!HOST_PASSWORD) return true;
  const a = crypto.createHash('sha256').update(String(pw || '')).digest();
  const b = crypto.createHash('sha256').update(HOST_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  // Prefer typical home/office LAN ranges first.
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return out.sort((a, b) => score(a) - score(b));
}

function newPin() {
  for (let i = 0; i < 1000; i++) {
    const pin = String(crypto.randomInt(100000, 1000000));
    if (!games.has(pin)) return pin;
  }
  throw new Error('no free pin');
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Neutralize spreadsheet formula injection from player nicknames.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function resultsCsv(results) {
  const head = ['名次', '暱稱', '總分', '答對題數', '最長連勝'];
  results.questions.forEach((q, i) => head.push(`Q${i + 1} 得分`, `Q${i + 1} 答對`, `Q${i + 1} 秒數`));
  const rows = [head];
  for (const p of results.players) {
    const r = [p.rank, p.name, p.score, p.correctCount, p.bestStreak];
    p.history.forEach((h) => {
      if (!h || h.choice === null) r.push(0, '', '');
      else r.push(h.points, h.correct ? 'O' : 'X', (h.elapsed / 1000).toFixed(2));
    });
    rows.push(r);
  }
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------- HTTP ----------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '30mb' }));

const pub = path.join(__dirname, 'public');
const sendPage = (file) => (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(pub, file));
};
app.get('/', sendPage('index.html'));
app.get('/host', sendPage('host.html'));
app.get('/editor', sendPage('editor.html'));
app.use(express.static(pub, { maxAge: '1h', setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.get('/healthz', (req, res) => res.json({ ok: true, games: games.size }));

app.get('/api/info', (req, res) => {
  res.json({
    needPassword: !!HOST_PASSWORD,
    publicUrl: PUBLIC_URL || null,
    lanUrls: lanAddresses().map((ip) => `http://${ip}:${PORT}`),
  });
});

app.get('/api/qr.svg', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 400);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=86400');
    res.send(svg);
  } catch (e) {
    res.status(500).end();
  }
});

function requireHost(req, res, next) {
  if (checkPassword(req.get('x-host-password'))) return next();
  res.status(401).json({ error: '主持人密碼錯誤' });
}

app.post('/api/auth', (req, res) => {
  if (checkPassword(req.body && req.body.password)) return res.json({ ok: true });
  res.status(401).json({ error: '密碼錯誤' });
});

app.get('/api/quizzes', requireHost, (req, res) => res.json(store.listQuizzes()));

app.get('/api/quizzes/:id', requireHost, (req, res) => {
  const q = store.getQuiz(req.params.id);
  if (!q) return res.status(404).json({ error: '找不到測驗' });
  res.json(q);
});

function saveHandler(req, res) {
  const { quiz, errors } = normalizeQuiz(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  if (req.params.id && !store.getQuiz(req.params.id)) return res.status(404).json({ error: '找不到測驗' });
  res.json(store.saveQuiz(req.params.id || null, quiz));
}
app.post('/api/quizzes', requireHost, saveHandler);
app.put('/api/quizzes/:id', requireHost, saveHandler);

app.delete('/api/quizzes/:id', requireHost, (req, res) => {
  if (!store.deleteQuiz(req.params.id)) return res.status(404).json({ error: '找不到測驗' });
  res.json({ ok: true });
});

function gameForHost(req, res) {
  const g = games.get(String(req.params.pin));
  if (!g || g.hostToken !== String(req.query.token || '')) {
    res.status(404).json({ error: '找不到遊戲' });
    return null;
  }
  return g;
}

app.get('/api/games/:pin/results.csv', (req, res) => {
  const g = gameForHost(req, res);
  if (!g) return;
  res.type('text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="results-${g.pin}.csv"`);
  res.send(resultsCsv(g.results()));
});

app.get('/api/games/:pin/results.json', (req, res) => {
  const g = gameForHost(req, res);
  if (!g) return;
  res.setHeader('Content-Disposition', `attachment; filename="results-${g.pin}.json"`);
  res.json(g.results());
});

// ---------- Socket.IO ----------

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 10000,
  pingTimeout: 20000,
});

const transport = {
  toHost: (pin, ev, data) => io.to('host:' + pin).emit(ev, data),
  toSocket: (id, ev, data) => io.to(id).emit(ev, data),
};

function reply(cb, data) {
  if (typeof cb === 'function') cb(data);
}

/** Simple per-socket rate limit for join-ish actions. */
function limited(socket, key, max, windowMs) {
  const now = Date.now();
  const rl = (socket.data.rl ||= {});
  const b = (rl[key] ||= { n: 0, t: now });
  if (now - b.t > windowMs) {
    b.n = 0;
    b.t = now;
  }
  return ++b.n > max;
}

function hostGame(socket) {
  const g = socket.data.hostPin && games.get(socket.data.hostPin);
  return g && g.hostToken === socket.data.hostToken ? g : null;
}

io.on('connection', (socket) => {
  // ----- host -----
  socket.on('host:create', (msg, cb) => {
    msg = msg || {};
    if (limited(socket, 'create', 10, 60000)) return reply(cb, { error: '操作太頻繁，請稍後再試' });
    if (!checkPassword(msg.password)) return reply(cb, { error: '主持人密碼錯誤' });
    const raw = store.getQuiz(String(msg.quizId || ''));
    if (!raw) return reply(cb, { error: '找不到測驗' });
    const { quiz, errors } = normalizeQuiz(raw);
    if (errors.length) return reply(cb, { error: '測驗內容有誤：' + errors[0] });
    const pin = newPin();
    const game = new Game({
      pin,
      quiz,
      settings: msg.settings,
      transport,
      onFinish: (results) => store.saveResults(results),
    });
    games.set(pin, game);
    socket.join('host:' + pin);
    socket.data.hostPin = pin;
    socket.data.hostToken = game.hostToken;
    console.log(`[game ${pin}] created: "${quiz.title}" (${quiz.questions.length} questions)`);
    reply(cb, { ok: true, pin, hostToken: game.hostToken });
    game.pushHost();
  });

  socket.on('host:resume', (msg, cb) => {
    msg = msg || {};
    const g = games.get(String(msg.pin || ''));
    if (!g || g.hostToken !== msg.hostToken) return reply(cb, { error: '找不到遊戲' });
    socket.join('host:' + g.pin);
    socket.data.hostPin = g.pin;
    socket.data.hostToken = g.hostToken;
    reply(cb, { ok: true });
    socket.emit('host:state', g.hostView());
  });

  const hostAction = (name, fn) =>
    socket.on(name, (msg, cb) => {
      const g = hostGame(socket);
      if (!g) return reply(cb, { error: '你不是這場遊戲的主持人' });
      g.touch();
      reply(cb, fn(g, msg || {}) || { ok: true });
    });

  hostAction('host:next', (g) => g.next());
  hostAction('host:kick', (g, m) => {
    const p = g.kick(String(m.playerId));
    if (p) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.data.playerId = null;
    }
    return p ? { ok: true } : { error: '找不到玩家' };
  });
  hostAction('host:lock', (g, m) => g.setLocked(m.locked));
  hostAction('host:autoAdvance', (g, m) => {
    g.settings.autoAdvance = !!m.on;
    g.pushHost();
  });
  hostAction('host:end', (g) => g.end());

  // ----- player -----
  socket.on('player:check', (msg, cb) => {
    if (limited(socket, 'join', 30, 60000)) return reply(cb, { error: '嘗試次數太多，請稍後再試' });
    const g = games.get(String((msg && msg.pin) || '').trim());
    if (!g) return reply(cb, { error: '找不到這個遊戲 PIN' });
    const blocked = g.canJoin();
    if (blocked) return reply(cb, { error: blocked });
    reply(cb, { ok: true, title: g.title });
  });

  socket.on('player:join', (msg, cb) => {
    msg = msg || {};
    if (limited(socket, 'join', 30, 60000)) return reply(cb, { error: '嘗試次數太多，請稍後再試' });
    const g = games.get(String(msg.pin || '').trim());
    if (!g) return reply(cb, { error: '找不到這個遊戲 PIN' });
    const r = g.join(msg.name, msg.avatar, socket.id);
    if (r.error) return reply(cb, r);
    socket.data.pin = g.pin;
    socket.data.playerId = r.player.id;
    reply(cb, { ok: true, token: r.player.token, playerId: r.player.id });
    g.pushPlayer(r.player);
  });

  socket.on('player:resume', (msg, cb) => {
    msg = msg || {};
    if (limited(socket, 'join', 30, 60000)) return reply(cb, { error: '嘗試次數太多，請稍後再試' });
    const g = games.get(String(msg.pin || ''));
    if (!g) return reply(cb, { error: '找不到遊戲' });
    const r = g.resume(String(msg.token || ''), socket.id);
    if (r.error) return reply(cb, r);
    if (r.oldSocket) {
      const old = io.sockets.sockets.get(r.oldSocket);
      if (old) {
        old.data.playerId = null;
        old.emit('player:replaced', {});
      }
    }
    socket.data.pin = g.pin;
    socket.data.playerId = r.player.id;
    reply(cb, { ok: true, playerId: r.player.id });
    g.pushPlayer(r.player);
  });

  socket.on('player:answer', (msg, cb) => {
    msg = msg || {};
    const g = socket.data.pin && games.get(socket.data.pin);
    if (!g || !socket.data.playerId) return reply(cb, { error: '你不在遊戲中' });
    reply(cb, g.answer(socket.data.playerId, msg.qIndex, msg.choice));
  });

  socket.on('player:leave', (msg, cb) => {
    const g = socket.data.pin && games.get(socket.data.pin);
    if (g && socket.data.playerId) g.leave(socket.data.playerId);
    socket.data.playerId = null;
    reply(cb, { ok: true });
  });

  socket.on('disconnect', () => {
    const g = socket.data.pin && games.get(socket.data.pin);
    if (g && socket.data.playerId) g.disconnect(socket.id);
  });
});

// ---------- housekeeping ----------

setInterval(() => {
  const now = Date.now();
  for (const [pin, g] of games) {
    const idle = now - g.lastActivity;
    if (idle > GAME_IDLE_MS || (g.phase === 'ended' && idle > ENDED_GAME_TTL_MS)) {
      g.destroy();
      games.delete(pin);
      console.log(`[game ${pin}] removed (idle)`);
    }
  }
}, 5 * 60 * 1000).unref();

function shutdown() {
  console.log('Shutting down…');
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Kahoot-lite running`);
    console.log(`  主持人 (Host):    http://localhost:${PORT}/host`);
    console.log(`  題目編輯 (Editor): http://localhost:${PORT}/editor`);
    for (const ip of lanAddresses()) console.log(`  玩家 (Players):   http://${ip}:${PORT}`);
    if (PUBLIC_URL) console.log(`  Public URL:       ${PUBLIC_URL}`);
    if (!HOST_PASSWORD) console.log('  (未設定 HOST_PASSWORD：任何人都能開題目編輯器。公開部署時請設定。)');
    console.log('');
  });
}

module.exports = { app, server, io, games, store, resultsCsv };
