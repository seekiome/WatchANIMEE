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

function loadUsers() {
  if (_usersCache) return _usersCache;
  try { _usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { _usersCache = {}; }
  return _usersCache;
}

function saveUsers(u) {
  _usersCache = u;
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(u, null, 2));
  fs.renameSync(tmp, USERS_FILE); // atomic
}

function loadSessions() {
  if (_sessionsCache) return _sessionsCache;
  try { _sessionsCache = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { _sessionsCache = {}; }
  return _sessionsCache;
}

function saveSessions(s) {
  _sessionsCache = s;
  const tmp = SESSIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, SESSIONS_FILE);
}

// ── PASSWORD HASHING (PBKDF2 — no native bcrypt needed) ──
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

// ── SESSION MANAGEMENT (persistent) ──
function createSession(username) {
  const sessions = loadSessions();
  const token = genToken();
  sessions[token] = { username, createdAt: Date.now(), lastUsed: Date.now() };
  saveSessions(sessions);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) return null;
  // Update lastUsed
  session.lastUsed = Date.now();
  saveSessions(sessions);
  return session.username;
}

function deleteSession(token) {
  const sessions = loadSessions();
  delete sessions[token];
  saveSessions(sessions);
}

// Clean sessions older than 30 days
function cleanOldSessions() {
  const sessions = loadSessions();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [token, session] of Object.entries(sessions)) {
    if (session.lastUsed < cutoff) { delete sessions[token]; changed = true; }
  }
  if (changed) saveSessions(sessions);
}
setInterval(cleanOldSessions, 60 * 60 * 1000); // every hour

// ── TOKEN MAP (in-memory for WS speed, backed by sessions file) ──
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
app.post('/api/register', (req, res) => {
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
  saveUsers(users);

  const token = createSession(username);
  res.json({ token, username, avatar: users[username].avatar });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  const user = users[username];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  // Support old SHA-256 accounts (migration)
  let valid = false;
  if (user.salt) {
    valid = verifyPassword(password, user.password, user.salt);
  } else {
    // Legacy SHA-256
    const oldHash = crypto.createHash('sha256').update(password + 'wt_salt_2026').digest('hex');
    valid = user.password === oldHash;
    if (valid) {
      // Migrate to PBKDF2
      const { hash, salt } = hashPassword(password);
      user.password = hash;
      user.salt = salt;
      saveUsers(users);
    }
  }

  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = createSession(username);
  res.json({ token, username, avatar: user.avatar, friends: user.friends, friendRequests: user.friendRequests });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) deleteSession(token);
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
app.post('/api/friends/request', (req, res) => {
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
  saveUsers(users);
  broadcastFriendRequest(toUsername, fromUsername);
  res.json({ ok: true });
});

app.post('/api/friends/accept', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = getSession(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { username: fromUsername } = req.body;
  const users = loadUsers();
  users[username].friendRequests = (users[username].friendRequests || []).filter(r => r !== fromUsername);
  users[username].friends = [...new Set([...(users[username].friends || []), fromUsername])];
  if (users[fromUsername]) users[fromUsername].friends = [...new Set([...(users[fromUsername].friends || []), username])];
  saveUsers(users);
  broadcastFriendStatus(username, true);
  broadcastFriendStatus(fromUsername, true);
  res.json({ ok: true });
});

app.post('/api/friends/decline', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = getSession(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { username: fromUsername } = req.body;
  const users = loadUsers();
  users[username].friendRequests = (users[username].friendRequests || []).filter(r => r !== fromUsername);
  saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/friends/:friendName', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = getSession(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { friendName } = req.params;
  const users = loadUsers();
  users[username].friends = (users[username].friends || []).filter(f => f !== friendName);
  if (users[friendName]) users[friendName].friends = (users[friendName].friends || []).filter(f => f !== username);
  saveUsers(users);
  res.json({ ok: true });
});

// ── ROOMS ──
const rooms = {};

function getRoom(id) {
  if (!rooms[id]) rooms[id] = {
    host: null,
    clients: new Map(),
    state: { playing: false, time: 0, updatedAt: Date.now() },
    hasVideo: false,
    videoFile: null,
    videoOrigName: null,
    createdAt: Date.now()
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

// ── VIDEO CLEANUP ──
// Track which files are in use
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
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours old

  files.forEach(file => {
    if (inUse.has(file)) return; // still in use
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

// Run cleanup every 30 minutes
setInterval(cleanupOldVideos, 30 * 60 * 1000);

function deleteRoomVideo(room) {
  if (room.videoFile) {
    const filePath = path.join(UPLOAD_DIR, room.videoFile);
    // Delay deletion to let current viewers finish buffering
    setTimeout(() => {
      try { fs.unlinkSync(filePath); } catch {}
    }, 30000); // 30 sec delay
    room.videoFile = null;
    room.hasVideo = false;
  }
}

// ── WEBSOCKET ──
wss.on('connection', (ws) => {
  let roomId = null, clientId = null, isHost = false, wsUsername = null;

  ws.on('message', (raw) => {
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
      isHost = msg.isHost || false;
      clientId = msg.clientId || crypto.randomBytes(4).toString('hex');
      const room = getRoom(roomId);
      if (isHost) room.host = ws; else room.clients.set(clientId, ws);
      const currentTime = room.state.playing
        ? room.state.time + (Date.now() - room.state.updatedAt) / 1000
        : room.state.time;
      sendTo(ws, {
        type: 'init',
        hasVideo: room.hasVideo,
        videoFile: room.videoFile,
        videoOrigName: room.videoOrigName,
        state: { ...room.state, time: currentTime },
        viewers: getViewerCount(room),
        clientId
      });
      broadcast(roomId, { type: 'viewers', count: getViewerCount(room) }, ws);
    }

    if (msg.type === 'sync' && isHost) {
      const room = getRoom(roomId);
      room.state = { playing: msg.playing, time: msg.time, updatedAt: Date.now() };
      broadcast(roomId, { type: 'sync', playing: msg.playing, time: msg.time }, ws);
    }

    if (msg.type === 'video_ready' && isHost) {
      const room = getRoom(roomId);
      room.hasVideo = true;
      room.videoFile = msg.filename;
      room.videoOrigName = msg.origName || msg.filename;
      room.state = { playing: false, time: 0, updatedAt: Date.now() };
      broadcast(roomId, { type: 'video_ready', filename: msg.filename, origName: room.videoOrigName }, ws);
    }

    if (msg.type === 'chat') broadcast(roomId, { type: 'chat', name: msg.name, text: msg.text, avatar: msg.avatar });
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
      broadcast(roomId, { type: 'host_left' });
      // Delete video when host leaves (delayed)
      deleteRoomVideo(room);
    } else {
      room.clients.delete(clientId);
    }

    broadcast(roomId, { type: 'viewers', count: getViewerCount(room) });

    // Clean up empty rooms
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

// 4GB limit for Railway
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

app.post('/upload/:roomId', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 4GB)' });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const room = getRoom(req.params.roomId);

    // Delete old video if replacing
    if (room.videoFile && room.videoFile !== req.file.filename) {
      const oldPath = path.join(UPLOAD_DIR, room.videoFile);
      setTimeout(() => { try { fs.unlinkSync(oldPath); } catch {} }, 5000);
    }

    room.videoFile = req.file.filename;
    room.videoOrigName = req.file.originalname;
    room.hasVideo = true;

    res.json({ filename: req.file.filename, origName: req.file.originalname });
  });
});

// ── VIDEO INFO ──
app.get('/video-info/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9.\-_]/g, '');
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(filePath);
  res.json({ size: stat.size, filename });
});

// ── VIDEO STREAMING with Range support ──
function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
    mpeg: 'video/mpeg', mpg: 'video/mpeg', ogv: 'video/ogg'
  };
  return types[ext] || 'video/mp4';
}

app.get('/video/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9.\-_]/g, '');
  const filePath = path.join(UPLOAD_DIR, filename);
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

// ── HEALTH CHECK (Railway) ──
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── STATIC ──
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.ico')));
app.get('/favicon-32.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon-32.png')));
app.get('/favicon-16.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon-16.png')));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`WatchTogether running on port ${PORT}`));
