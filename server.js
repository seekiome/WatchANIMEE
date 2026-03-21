const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '2mb' }));

// ── DATA PATHS ──
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');

// ── HELPERS ──
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }
function hash(pw) { return crypto.createHash('sha256').update(pw + 'wt_salt_2026').digest('hex'); }
function genToken() { return crypto.randomBytes(24).toString('hex'); }

// ── ONLINE TRACKING ──
// username → Set of ws connections
const onlineUsers = new Map();
// token → username
const tokenMap = new Map();
// ws → username
const wsUserMap = new Map();

function broadcastFriendStatus(username, online) {
  const users = loadUsers();
  const user = users[username];
  if (!user) return;
  const friends = user.friends || [];
  friends.forEach(friendName => {
    const fws = onlineUsers.get(friendName);
    if (fws) {
      fws.forEach(ws => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'friend_status', username, online }));
        }
      });
    }
  });
}

function broadcastFriendRequest(toUsername, fromUsername) {
  const fws = onlineUsers.get(toUsername);
  if (fws) {
    fws.forEach(ws => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'friend_request', from: fromUsername }));
      }
    });
  }
}

// ── AUTH ROUTES ──
app.post('/api/register', (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 2 || username.length > 24) return res.status(400).json({ error: 'Username 2-24 chars' });
  if (!/^[a-zA-Z0-9_\u0400-\u04FF]+$/.test(username)) return res.status(400).json({ error: 'Letters, numbers, _ only' });

  const users = loadUsers();
  if (users[username]) return res.status(409).json({ error: 'Username taken' });

  const token = genToken();
  users[username] = {
    password: hash(password),
    avatar: avatar || '🌸',
    friends: [],
    friendRequests: [],
    createdAt: Date.now()
  };
  saveUsers(users);
  tokenMap.set(token, username);
  res.json({ token, username, avatar: users[username].avatar });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  const user = users[username];
  if (!user || user.password !== hash(password)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = genToken();
  tokenMap.set(token, username);
  res.json({ token, username, avatar: user.avatar, friends: user.friends, friendRequests: user.friendRequests });
});

app.get('/api/me', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = tokenMap.get(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  const users = loadUsers();
  const user = users[username];
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Build friends list with online status
  const friendsList = (user.friends || []).map(f => ({
    username: f,
    avatar: users[f]?.avatar || '🌸',
    online: onlineUsers.has(f) && onlineUsers.get(f).size > 0
  }));

  res.json({ username, avatar: user.avatar, friends: friendsList, friendRequests: user.friendRequests || [] });
});

app.post('/api/friends/request', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const fromUsername = tokenMap.get(token);
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
  const username = tokenMap.get(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { username: fromUsername } = req.body;
  const users = loadUsers();

  users[username].friendRequests = (users[username].friendRequests || []).filter(r => r !== fromUsername);
  users[username].friends = [...new Set([...(users[username].friends || []), fromUsername])];
  if (users[fromUsername]) {
    users[fromUsername].friends = [...new Set([...(users[fromUsername].friends || []), username])];
  }
  saveUsers(users);

  // Notify both about status
  broadcastFriendStatus(username, true);
  broadcastFriendStatus(fromUsername, true);
  res.json({ ok: true });
});

app.post('/api/friends/decline', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = tokenMap.get(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { username: fromUsername } = req.body;
  const users = loadUsers();
  users[username].friendRequests = (users[username].friendRequests || []).filter(r => r !== fromUsername);
  saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/friends/:friendName', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const username = tokenMap.get(token);
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
  if (!rooms[id]) rooms[id] = { host: null, clients: new Map(), state: { playing: false, time: 0, updatedAt: Date.now() }, hasVideo: false, videoFile: null };
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

// ── WEBSOCKET ──
wss.on('connection', (ws) => {
  let roomId = null, clientId = null, isHost = false, wsUsername = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Auth presence
    if (msg.type === 'auth') {
      const username = tokenMap.get(msg.token);
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
      clientId = msg.clientId || Math.random().toString(36).substr(2, 8);
      const room = getRoom(roomId);
      if (isHost) room.host = ws; else room.clients.set(clientId, ws);
      const currentTime = room.state.playing ? room.state.time + (Date.now() - room.state.updatedAt) / 1000 : room.state.time;
      sendTo(ws, { type: 'init', hasVideo: room.hasVideo, videoFile: room.videoFile, state: { ...room.state, time: currentTime }, viewers: getViewerCount(room), clientId });
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
      broadcast(roomId, { type: 'video_ready', filename: msg.filename }, ws);
    }
    if (msg.type === 'offer') { const room = getRoom(roomId); const target = room.clients.get(msg.targetId); if (target) sendTo(target, { type: 'offer', offer: msg.offer }); }
    if (msg.type === 'answer') { const room = getRoom(roomId); if (room.host) sendTo(room.host, { type: 'answer', answer: msg.answer, clientId }); }
    if (msg.type === 'ice') {
      const room = getRoom(roomId);
      if (msg.toHost && room.host) sendTo(room.host, { type: 'ice', candidate: msg.candidate, clientId });
      else if (!msg.toHost) { const target = room.clients.get(msg.targetId); if (target) sendTo(target, { type: 'ice', candidate: msg.candidate }); }
    }
    if (msg.type === 'chat') broadcast(roomId, { type: 'chat', name: msg.name, text: msg.text, avatar: msg.avatar });
  });

  ws.on('close', () => {
    // Remove from online
    if (wsUsername) {
      const userWs = onlineUsers.get(wsUsername);
      if (userWs) { userWs.delete(ws); if (userWs.size === 0) { onlineUsers.delete(wsUsername); broadcastFriendStatus(wsUsername, false); } }
      wsUserMap.delete(ws);
    }
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (isHost) { room.host = null; room.hasVideo = false; broadcast(roomId, { type: 'host_left' }); }
    else room.clients.delete(clientId);
    broadcast(roomId, { type: 'viewers', count: getViewerCount(room) });
    if (!room.host && room.clients.size === 0) delete rooms[roomId];
  });
});

const multer = require('multer');

// ── VIDEO UPLOAD ──
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/upload/:roomId', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const room = getRoom(req.params.roomId);
  room.videoFile = req.file.filename;
  res.json({ filename: req.file.filename });
});

function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return { mp4:'video/mp4', mkv:'video/x-matroska', avi:'video/x-msvideo', mov:'video/quicktime', webm:'video/webm', m4v:'video/mp4' }[ext] || 'video/mp4';
}

app.get('/video/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9.\-_]/g, '');
  const filePath = path.join(uploadDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const contentType = getContentType(filename);
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Explicit favicon routes
app.get('/favicon.ico', (req,res) => res.sendFile(path.join(__dirname,'public','favicon.ico')));
app.get('/favicon-32.png', (req,res) => res.sendFile(path.join(__dirname,'public','favicon-32.png')));
app.get('/favicon-16.png', (req,res) => res.sendFile(path.join(__dirname,'public','favicon-16.png')));

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WatchTogether running on port ${PORT}`));
