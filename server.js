const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '2mb' }));

// ── DATA & UPLOAD DIRS ──
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── SIMPLE DB (JSON with atomic write + in-memory cache) ──
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

let _usersCache = null;
let _sessionsCache = null;

// FIX [CRIT-1]: Mutex для предотвращения race condition при конкурентных записях
const _writeLocks = {};
async function withLock(key, fn) {
  while (_writeLocks[key]) {
    await new Promise(r => setTimeout(r, 5));
  }
  _writeLocks[key] = true;
  try { return await fn(); }
  finally { delete _writeLocks[key]; }
}

function loadUsers() {
  if (_usersCache) return _usersCache;
  try { _usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { _usersCache = {}; }
  return _usersCache;
}

async function saveUsers(u) {
  return withLock('users', () => {
    _usersCache = u;
    const tmp = USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(u, null, 2));
    fs.renameSync(tmp, USERS_FILE);
  });
}

function loadSessions() {
  if (_sessionsCache) return _sessionsCache;
  try { _sessionsCache = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { _sessionsCache = {}; }
  return _sessionsCache;
}

async function saveSessions(s) {
  return withLock('sessions', () => {
    _sessionsCache = s;
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, SESSIONS_FILE);
  });
}

// ── PASSWORD HASHING (PBKDF2) ──
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}

function genToken() { return crypto.randomBytes(32).toString('hex'); }

// ── SESSION MANAGEMENT ──
async function createSession(username) {
  const sessions = loadSessions();
  const token = genToken();
  sessions[token] = { username, createdAt: Date.now(), lastUsed: Date.now() };
  await saveSessions(sessions);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) return null;
  session.lastUsed = Date.now();
  // fire-and-forget async save для lastUsed (некритично)
  saveSessions(sessions).catch(() => {});
  return session.username;
}

async function deleteSession(token) {
  const sessions = loadSessions();
  delete sessions[token];
  await saveSessions(sessions);
}

function cleanOldSessions() {
  const sessions = loadSessions();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [token, session] of Object.entries(sessions)) {
    if (session.lastUsed < cutoff) { delete sessions[token]; changed = true; }
  }
  if (changed) saveSessions(sessions).catch(() => {});
}
setInterval(cleanOldSessions, 60 * 60 * 1000);

// FIX [CRIT-4]: Rate limiting для auth endpoints
const _loginAttempts = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = _loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    _loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

function resetRateLimit(ip) {
  _loginAttempts.delete(ip);
}

// Очистка старых записей rate limit каждые 30 минут
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _loginAttempts.entries()) {
    if (entry.resetAt < now) _loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000);

// ── ONLINE USERS & WS MAPS ──
const onlineUsers = new Map(); // username → Set<ws>
const wsUserMap = new Map();   // ws → username

function broadcastFriendStatus(username, online) {
  const users = loadUsers();
  const user = users[username];
  if (!user) return;
  (user.friends || []).forEach(friendName => {
    const fws = onlineUsers.get(friendName);
    if (fws) fws.forEach(ws => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'friend_status', username, online }));
    });
  });
}

function broadcastFriendRequest(toUsername, fromUsername) {
  const fws = onlineUsers.get(toUsername);
  if (fws) fws.forEach(ws => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'friend_request', from: fromUsername }));
  });
}

// ── AUTH ROUTES ──
app.post('/api/register', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  // FIX [CRIT-4]: Rate limit на регистрацию
  if (!checkRateLimit('reg_' + ip)) {
    return res.status(429).json({ error: 'Too many attempts, try later' });
  }

  const { username, password, avatar } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 2 || username.length > 24) return res.status(400).json({ error: 'Username 2-24 chars' });
  if (!/^[a-zA-Z0-9_\u0400-\u04FF]+$/.test(username)) return res.status(400).json({ error: 'Letters, numbers, _ only' });
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });

  const users = loadUsers();
  if (users[username]) return res.status(409).json({ error: 'Username taken' });

  const { hash, salt } = hashPassword(password);
  users[username] = {
    password: hash,
    salt,
    avatar: avatar || '🌸',
    friends: [],
    friendRequests: [],
    createdAt: Date.now()
  };
  await saveUsers(users);

  const token = await createSession(username);
  res.json({ token, username, avatar: users[username].avatar });
});

app.post('/api/login', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  // FIX [CRIT-4]: Rate limit на логин
  if (!checkRateLimit('login_' + ip)) {
    return res.status(429).json({ error: 'Too many attempts, try in 15 minutes' });
  }

  const { username, password } = req.body;
  const users = loadUsers();
  const user = users[username];

  // FIX [CRIT-4]: Искусственная задержка при неудаче — усложняет brute force
  if (!user) {
    await new Promise(r => setTimeout(r, 400));
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  let valid = false;
  if (user.salt) {
    valid = verifyPassword(password, user.password, user.salt);
  } else {
    const oldHash = crypto.createHash('sha256').update(password + 'wt_salt_2026').digest('hex');
    valid = user.password === oldHash;
    if (valid) {
      const { hash, salt } = hashPassword(password);
      user.password = hash;
      user.salt = salt;
      await saveUsers(users);
    }
  }

  if (!valid) {
    await new Promise(r => setTimeout(r, 400));
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  resetRateLimit('login_' + ip);
  const token = await createSession(username);
  res.json({ token, username, avatar: user.avatar, friends: user.friends, friendRequests: user.friendRequests });
});

app.post('/api/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) await deleteSession(token);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = getSession(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const users = loadUsers();
  const user = users[username];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const friendsList = (user.friends || []).map(f => ({
    username: f,
    avatar: users[f]?.avatar || '🌸',
    online: onlineUsers.has(f) && onlineUsers.get(f).size > 0
  }));

  res.json({ username, avatar: user.avatar, friends: friendsList, friendRequests: user.friendRequests || [] });
});

// ── FRIENDS ──
app.post('/api/friends/request', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const fromUsername = getSession(token);
  if (!fromUsername) return res.status(401).json({ error: 'Unauthorized' });

  const { username: toUsername } = req.body;
  const users = loadUsers();
  if (!users[toUsername]) return res.status(404).json({ error: 'User not found' });
  if (fromUsername === toUsername) return res.status(400).json({ error: 'Cannot add yourself' });

  const toUser = users[toUsername];
  if ((toUser.friends || []).includes(fromUsername)) return res.status(400).json({ error: 'Already friends' });
  if ((toUser.friendRequests || []).includes(fromUsername)) return res.status(400).json({ error: 'Request already sent' });

  toUser.friendRequests = [...(toUser.friendRequests || []), fromUsername];
  await saveUsers(users);
  broadcastFriendRequest(toUsername, fromUsername);
  res.json({ ok: true });
});

app.post('/api/friends/accept', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = getSession(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { username: fromUsername } = req.body;
  const users = loadUsers();
  users[username].friendRequests = (users[username].friendRequests || []).filter(r => r !== fromUsername);
  users[username].friends = [...new Set([...(users[username].friends || []), fromUsername])];
  if (users[fromUsername]) users[fromUsername].friends = [...new Set([...(users[fromUsername].friends || []), username])];
  await saveUsers(users);
  broadcastFriendStatus(username, true);
  broadcastFriendStatus(fromUsername, true);
  res.json({ ok: true });
});

app.post('/api/friends/decline', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = getSession(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { username: fromUsername } = req.body;
  const users = loadUsers();
  users[username].friendRequests = (users[username].friendRequests || []).filter(r => r !== fromUsername);
  await saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/friends/:friendName', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = getSession(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { friendName } = req.params;
  const users = loadUsers();
  users[username].friends = (users[username].friends || []).filter(f => f !== friendName);
  if (users[friendName]) users[friendName].friends = (users[friendName].friends || []).filter(f => f !== username);
  await saveUsers(users);
  res.json({ ok: true });
});

// ── ROOMS ──
const rooms = {};

function getRoom(id) {
  if (!rooms[id]) rooms[id] = {
    host: null,
    hostToken: null, // FIX [HIGH-2]: храним токен создателя комнаты
    clients: new Map(),
    state: { playing: false, time: 0, updatedAt: Date.now() },
    hasVideo: false,
    videoFile: null,
    videoOrigName: null,
    createdAt: Date.now(),
    lastActivity: Date.now() // FIX [HIGH-1]: для TTL очистки
  };
  return rooms[id];
}

function broadcast(roomId, data, exceptWs = null) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  if (room.host && room.host !== exceptWs && room.host.readyState === 1) room.host.send(msg);
  room.clients.forEach(client => { if (client !== exceptWs && client.readyState === 1) client.send(msg); });
}

function sendTo(ws, data) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(data)); }
function getViewerCount(room) { return room.clients.size + (room.host ? 1 : 0); }

// FIX [HIGH-1]: TTL-очистка комнат — удаляем неактивные комнаты через 2 часа
function cleanOldRooms() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.lastActivity < cutoff) {
      deleteRoomVideo(room);
      delete rooms[roomId];
      console.log(`Cleaned up inactive room: ${roomId}`);
    }
  }
}
setInterval(cleanOldRooms, 30 * 60 * 1000);

// ── VIDEO CLEANUP ──
function getFilesInUse() {
  const used = new Set();
  for (const room of Object.values(rooms)) {
    if (room.videoFile) used.add(room.videoFile);
  }
  return used;
}

function cleanupOldVideos() {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  const files = fs.readdirSync(UPLOAD_DIR);
  const inUse = getFilesInUse();
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;

  files.forEach(file => {
    if (inUse.has(file)) return;
    const filePath = path.join(UPLOAD_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up old video: ${file}`);
      }
    } catch {}
  });
}

setInterval(cleanupOldVideos, 30 * 60 * 1000);

function deleteRoomVideo(room) {
  if (room.videoFile) {
    // FIX [HIGH-3]: сохраняем имя файла в closure, проверяем перед удалением
    const fileToDelete = room.videoFile;
    const filePath = path.join(UPLOAD_DIR, fileToDelete);
    setTimeout(() => {
      const inUse = getFilesInUse();
      if (!inUse.has(fileToDelete)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }, 30000);
    room.videoFile = null;
    room.hasVideo = false;
  }
}

// ── WEBSOCKET ──
wss.on('connection', (ws) => {
  let roomId = null, clientId = null, isHost = false, wsUsername = null;
  let _intentionalDisconnect = false; // FIX [HIGH-5]: флаг намеренного отключения

  ws.on('message', (raw) => {
    // FIX [HIGH-4]: Ограничение размера WS-сообщений
    if (raw.length > 65536) {
      ws.close(1009, 'Message too large');
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      const username = getSession(msg.token);
      if (username) {
        wsUsername = username;
        wsUserMap.set(ws, username);
        if (!onlineUsers.has(username)) onlineUsers.set(username, new Set());
        onlineUsers.get(username).add(ws);
        broadcastFriendStatus(username, true);
        sendTo(ws, { type: 'auth_ok', username });
      }
    }

    if (msg.type === 'join') {
      roomId = msg.roomId;
      clientId = msg.clientId || crypto.randomBytes(4).toString('hex');

      // FIX [HIGH-4]: валидация roomId
      if (!roomId || typeof roomId !== 'string' || !/^[A-Z0-9]{4,10}$/.test(roomId)) {
        sendTo(ws, { type: 'error', message: 'Invalid room ID' });
        return;
      }

      const room = getRoom(roomId);
      room.lastActivity = Date.now();

      // FIX [HIGH-2]: проверка прав хоста
      const requestedHost = msg.isHost || false;
      if (requestedHost) {
        // Разрешаем быть хостом только если комната новая или хост ушёл
        if (!room.host) {
          isHost = true;
          room.host = ws;
          room.hostToken = msg.authToken || null; // сохраняем токен для верификации
        } else {
          // Кто-то уже хост — присоединяем как зрителя
          isHost = false;
          room.clients.set(clientId, ws);
        }
      } else {
        isHost = false;
        room.clients.set(clientId, ws);
      }

      const currentTime = room.state.playing
        ? room.state.time + (Date.now() - room.state.updatedAt) / 1000
        : room.state.time;

      sendTo(ws, {
        type: 'init',
        hasVideo: room.hasVideo,
        // FIX [MED-1]: не передаём serverFilename клиентам — только origName
        videoOrigName: room.videoOrigName,
        // FIX [MED-1]: передаём serverTime для корректной компенсации задержки
        serverTime: Date.now(),
        state: { ...room.state, time: currentTime },
        viewers: getViewerCount(room),
        clientId,
        isHost  // сообщаем клиенту был ли он принят как хост
      });

      // Если видео есть — сообщаем через отдельный токен комнаты, не через filename
      if (room.hasVideo && room.videoFile) {
        sendTo(ws, {
          type: 'video_ready',
          // FIX [HIGH-3]: передаём roomId для построения URL, а не прямое имя файла
          streamUrl: `/video-stream/${roomId}`,
          origName: room.videoOrigName,
          serverTime: Date.now(),
          state: { ...room.state, time: currentTime }
        });
      }

      broadcast(roomId, { type: 'viewers', count: getViewerCount(room) }, ws);
    }

    if (msg.type === 'sync' && isHost) {
      const room = getRoom(roomId);
      room.state = { playing: msg.playing, time: msg.time, updatedAt: Date.now() };
      room.lastActivity = Date.now(); // FIX [HIGH-1]: обновляем активность
      broadcast(roomId, { type: 'sync', playing: msg.playing, time: msg.time, serverTime: Date.now() }, ws);
    }

    if (msg.type === 'video_ready' && isHost) {
      const room = getRoom(roomId);
      room.hasVideo = true;
      room.videoOrigName = msg.origName || msg.filename;
      room.state = { playing: false, time: 0, updatedAt: Date.now() };
      room.lastActivity = Date.now();
      // FIX [HIGH-3]: клиентам отдаём только streamUrl и origName, не filename
      broadcast(roomId, {
        type: 'video_ready',
        streamUrl: `/video-stream/${roomId}`,
        origName: room.videoOrigName,
        serverTime: Date.now()
      }, ws);
    }

    // FIX [HIGH-4]: валидация chat-сообщений
    if (msg.type === 'chat') {
      const name = String(msg.name || '').slice(0, 24);
      const text = String(msg.text || '').slice(0, 300);
      // FIX [CRIT-3]: avatar берём из базы данных, а не из сообщения клиента
      const users = loadUsers();
      const safeAvatar = wsUsername && users[wsUsername] ? users[wsUsername].avatar : '';
      broadcast(roomId, { type: 'chat', name, text, avatar: safeAvatar });
    }
  });

  ws.on('close', () => {
    if (wsUsername) {
      const userWs = onlineUsers.get(wsUsername);
      if (userWs) {
        userWs.delete(ws);
        if (userWs.size === 0) {
          onlineUsers.delete(wsUsername);
          broadcastFriendStatus(wsUsername, false);
        }
      }
      wsUserMap.delete(ws);
    }

    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    if (isHost) {
      room.host = null;
      room.hostToken = null;
      broadcast(roomId, { type: 'host_left' });
      deleteRoomVideo(room);
    } else {
      room.clients.delete(clientId);
    }

    broadcast(roomId, { type: 'viewers', count: getViewerCount(room) });

    if (!room.host && room.clients.size === 0) {
      deleteRoomVideo(room);
      delete rooms[roomId];
    }
  });
});

// ── VIDEO UPLOAD ──
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg', 'video/ogg'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files allowed'));
    }
  }
});

// Upload: авторизация опциональна (гостевой режим), но roomId должен быть валидным
app.post('/upload/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  // Валидация roomId
  if (!roomId || !/^[A-Z0-9]{4,10}$/i.test(roomId)) {
    return res.status(400).json({ error: 'Invalid room ID' });
  }
  const room = rooms[roomId];
  // Разрешаем загрузку если комната существует или создаётся
  // (хост загружает до или после join)

  upload.single('video')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 4GB)' });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const r = getRoom(roomId);

    if (r.videoFile && r.videoFile !== req.file.filename) {
      const oldFile = r.videoFile;
      setTimeout(() => {
        const inUse = getFilesInUse();
        if (!inUse.has(oldFile)) {
          try { fs.unlinkSync(path.join(UPLOAD_DIR, oldFile)); } catch {}
        }
      }, 5000);
    }

    r.videoFile = req.file.filename;
    r.videoOrigName = req.file.originalname;
    r.hasVideo = true;
    r.lastActivity = Date.now();

    // FIX [HIGH-3]: не возвращаем реальный filename клиенту — только origName
    res.json({ origName: req.file.originalname, streamUrl: `/video-stream/${roomId}` });
  });
});

// ── VIDEO INFO ──
app.get('/video-info/:roomId', (req, res) => {
  // FIX [CRIT-2]: проверяем авторизацию
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = getSession(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const room = rooms[req.params.roomId];
  if (!room || !room.videoFile) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(UPLOAD_DIR, room.videoFile);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(filePath);
  res.json({ size: stat.size, origName: room.videoOrigName });
});

// ── VIDEO STREAMING — через roomId, не через filename ──
// FIX [CRIT-2] + [HIGH-3]: стримим по roomId, реальное имя файла клиенту не раскрывается
function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
    mpeg: 'video/mpeg', mpg: 'video/mpeg', ogv: 'video/ogg'
  };
  return types[ext] || 'video/mp4';
}

app.get('/video-stream/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  // Валидация roomId — защита от path traversal
  if (!/^[A-Z0-9]{4,10}$/i.test(roomId)) return res.status(400).send('Invalid room ID');

  const room = rooms[roomId];
  if (!room || !room.videoFile) return res.status(404).send('No video in this room');

  const filename = room.videoFile;
  const filePath = path.join(UPLOAD_DIR, filename);

  // FIX [MED-4]: дополнительная проверка path traversal
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) return res.status(403).send('Forbidden');

  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const contentType = getContentType(filename);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  rooms: Object.keys(rooms).length,
  onlineUsers: onlineUsers.size
}));

// ── KEEP-ALIVE ──
// Пингуем себя каждые 14 минут чтобы не засыпать на Railway/Render/Heroku.
// Установи переменную окружения SELF_URL = https://your-app.railway.app
const SELF_URL = process.env.SELF_URL
  || process.env.RAILWAY_STATIC_URL
  || process.env.RENDER_EXTERNAL_URL
  || null;

function selfPing() {
  if (!SELF_URL) return;
  const url = `${SELF_URL.replace(/\/$/, '')}/health`;
  const lib = url.startsWith('https') ? require('https') : require('http');
  const req = lib.get(url, res => {
    console.log(`[keep-alive] ${new Date().toISOString()} → ${res.statusCode}`);
  });
  req.on('error', err => console.warn(`[keep-alive] failed: ${err.message}`));
  req.end();
}

// Первый пинг через минуту после старта, затем каждые 14 минут
setTimeout(() => { selfPing(); setInterval(selfPing, 14 * 60 * 1000); }, 60 * 1000);

// ── STATIC ──
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.ico')));
app.get('/favicon-32.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon-32.png')));
app.get('/favicon-16.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon-16.png')));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WatchTogether running on port ${PORT}`);
  if (SELF_URL) console.log(`[keep-alive] enabled → ${SELF_URL}/health every 14 min`);
  else console.log(`[keep-alive] set SELF_URL env var to prevent sleep`);
});
