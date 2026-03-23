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

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── ROOMS ──
const rooms = {};

function getRoom(id) {
  if (!rooms[id]) rooms[id] = {
    hostClientId: null,
    hostWs: null,
    clients: new Map(),
    state: { playing: false, time: 0, updatedAt: Date.now() },
    hasVideo: false,
    videoFile: null,
    videoOrigName: null,
    queue: [],
    queueIdx: -1,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  return rooms[id];
}

function broadcast(roomId, data, exceptWs = null) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  if (room.hostWs && room.hostWs !== exceptWs && room.hostWs.readyState === 1)
    room.hostWs.send(msg);
  room.clients.forEach(ws => {
    if (ws !== exceptWs && ws.readyState === 1) ws.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function getViewerCount(room) {
  return room.clients.size + (room.hostWs ? 1 : 0);
}

function getCurrentTime(room) {
  return room.state.playing
    ? room.state.time + (Date.now() - room.state.updatedAt) / 1000
    : room.state.time;
}

function getFilesInUse() {
  const used = new Set();
  for (const room of Object.values(rooms)) {
    if (room.videoFile) used.add(room.videoFile);
    for (const q of room.queue) if (q.serverFile) used.add(q.serverFile);
  }
  return used;
}

function safeDelete(filename, delay = 30000) {
  setTimeout(() => {
    if (!getFilesInUse().has(filename)) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, filename)); } catch {}
    }
  }, delay);
}

function setRoomVideo(room, serverFile, origName) {
  room.videoFile = serverFile;
  room.videoOrigName = origName;
  room.hasVideo = true;
  room.state = { playing: false, time: 0, updatedAt: Date.now() };
  room.lastActivity = Date.now();
}

function playQueueItem(roomId, idx) {
  const room = rooms[roomId];
  if (!room) return;
  if (idx < 0 || idx >= room.queue.length) return;
  const item = room.queue[idx];
  if (!item.serverFile) return;
  room.queueIdx = idx;
  setRoomVideo(room, item.serverFile, item.origName);
  broadcast(roomId, {
    type: 'video_ready',
    streamUrl: `/video-stream/${roomId}`,
    origName: item.origName,
    serverTime: Date.now(),
    state: { playing: false, time: 0 },
    queueIdx: idx,
    queueLen: room.queue.length
  });
}

function broadcastQueue(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  broadcast(roomId, {
    type: 'queue_update',
    queue: room.queue.map((q, i) => ({ id: q.id, origName: q.origName, idx: i })),
    queueIdx: room.queueIdx
  });
}

function deleteRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.videoFile) safeDelete(room.videoFile);
  for (const q of room.queue) if (q.serverFile) safeDelete(q.serverFile);
  delete rooms[roomId];
  console.log(`Cleaned up inactive room: ${roomId}`);
}

// ── WEBSOCKET ──
wss.on('connection', (ws) => {
  let roomId = null, clientId = null, isHost = false;

  ws.on('message', (raw) => {
    if (raw.length > 65536) { ws.close(1009, 'Message too large'); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      roomId = msg.roomId;
      clientId = msg.clientId || crypto.randomBytes(4).toString('hex');

      if (!roomId || typeof roomId !== 'string' || !/^[A-Z0-9]{4,10}$/.test(roomId)) {
        sendTo(ws, { type: 'error', message: 'Invalid room ID' });
        return;
      }

      const room = getRoom(roomId);
      room.lastActivity = Date.now();

      const isReconnectingHost = room.hostClientId && room.hostClientId === clientId;
      const isNewHost = msg.isHost && !room.hostClientId;

      if (isReconnectingHost || isNewHost) {
        isHost = true;
        room.hostClientId = clientId;
        room.hostWs = ws;
      } else {
        isHost = false;
        room.clients.set(clientId, ws);
      }

      const currentTime = getCurrentTime(room);

      sendTo(ws, {
        type: 'init',
        hasVideo: room.hasVideo,
        videoOrigName: room.videoOrigName,
        serverTime: Date.now(),
        state: { ...room.state, time: currentTime },
        viewers: getViewerCount(room),
        clientId,
        isHost,
        queueIdx: room.queueIdx,
        queueLen: room.queue.length
      });

      if (room.hasVideo && room.videoFile) {
        sendTo(ws, {
          type: 'video_ready',
          streamUrl: `/video-stream/${roomId}`,
          origName: room.videoOrigName,
          serverTime: Date.now(),
          state: { ...room.state, time: currentTime },
          queueIdx: room.queueIdx,
          queueLen: room.queue.length
        });
      }

      // Отправляем очередь новому клиенту
      if (room.queue.length > 0) {
        sendTo(ws, {
          type: 'queue_update',
          queue: room.queue.map((q, i) => ({ id: q.id, origName: q.origName, idx: i })),
          queueIdx: room.queueIdx
        });
      }

      broadcast(roomId, { type: 'viewers', count: getViewerCount(room) }, ws);
    }

    if (msg.type === 'sync' && isHost) {
      const room = rooms[roomId];
      if (!room) return;
      room.state = { playing: msg.playing, time: msg.time, updatedAt: Date.now() };
      room.lastActivity = Date.now();
      broadcast(roomId, {
        type: 'sync',
        playing: msg.playing,
        time: msg.time,
        serverTime: Date.now()
      }, ws);
    }

    if (msg.type === 'video_ready' && isHost) {
      const room = rooms[roomId];
      if (!room) return;
      // Берём serverFile из msg (новый формат) или из текущего room.videoFile
      const serverFile = msg.serverFile || room.videoFile;
      if (serverFile) setRoomVideo(room, serverFile, msg.origName || msg.filename || room.videoOrigName);
      broadcast(roomId, {
        type: 'video_ready',
        streamUrl: `/video-stream/${roomId}`,
        origName: room.videoOrigName,
        serverTime: Date.now(),
        state: { playing: false, time: 0 }
      }, ws);
    }

    if (msg.type === 'queue_add' && isHost) {
      const room = rooms[roomId];
      if (!room) return;
      room.queue.push({ id: msg.id, origName: msg.origName, serverFile: msg.serverFile });
      broadcastQueue(roomId);
    }

    if (msg.type === 'queue_play' && isHost) {
      playQueueItem(roomId, msg.idx);
    }

    if (msg.type === 'queue_remove' && isHost) {
      const room = rooms[roomId];
      if (!room) return;
      const idx = room.queue.findIndex(q => q.id === msg.id);
      if (idx === -1) return;
      const removed = room.queue.splice(idx, 1)[0];
      if (removed.serverFile && removed.serverFile !== room.videoFile) safeDelete(removed.serverFile);
      if (room.queueIdx >= idx) room.queueIdx = Math.max(-1, room.queueIdx - 1);
      broadcastQueue(roomId);
    }

    if (msg.type === 'queue_reorder' && isHost) {
      const room = rooms[roomId];
      if (!room) return;
      const { fromIdx, toIdx } = msg;
      if (fromIdx < 0 || toIdx < 0 || fromIdx >= room.queue.length || toIdx >= room.queue.length) return;
      const [moved] = room.queue.splice(fromIdx, 1);
      room.queue.splice(toIdx, 0, moved);
      if (room.queueIdx === fromIdx) room.queueIdx = toIdx;
      else if (fromIdx < room.queueIdx && toIdx >= room.queueIdx) room.queueIdx--;
      else if (fromIdx > room.queueIdx && toIdx <= room.queueIdx) room.queueIdx++;
      broadcastQueue(roomId);
    }

    if (msg.type === 'queue_next' && isHost) {
      const room = rooms[roomId];
      if (!room) return;
      const nextIdx = room.queueIdx + 1;
      if (nextIdx < room.queue.length) playQueueItem(roomId, nextIdx);
    }

    if (msg.type === 'chat') {
      const name = String(msg.name || '').slice(0, 24);
      const text = String(msg.text || '').slice(0, 300);
      broadcast(roomId, { type: 'chat', name, text });
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (isHost) {
      room.hostWs = null;
      // НЕ удаляем комнату — хост может вернуться
      broadcast(roomId, { type: 'host_left' });
    } else {
      room.clients.delete(clientId);
    }
    broadcast(roomId, { type: 'viewers', count: getViewerCount(room) });
    // Удаляем только если никого нет и хост никогда не был (пустая комната)
    if (!room.hostWs && room.clients.size === 0 && !room.hostClientId) {
      deleteRoom(roomId);
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
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files allowed'));
  }
});

app.post('/upload/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  if (!roomId || !/^[A-Z0-9]{4,10}$/i.test(roomId))
    return res.status(400).json({ error: 'Invalid room ID' });

  upload.single('video')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 4GB)' });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const r = getRoom(roomId);
    r.lastActivity = Date.now();

    res.json({
      origName: req.file.originalname,
      serverFile: req.file.filename,
      streamUrl: `/video-stream/${roomId}`
    });
  });
});

// ── VIDEO STREAMING ──
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
  if (!/^[A-Z0-9]{4,10}$/i.test(roomId)) return res.status(400).send('Invalid room ID');
  const room = rooms[roomId];
  if (!room || !room.videoFile) return res.status(404).send('No video in this room');
  const filePath = path.join(UPLOAD_DIR, room.videoFile);
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const contentType = getContentType(room.videoFile);
  const range = req.headers.range;
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : Math.min(start + 4 * 1024 * 1024 - 1, fileSize - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(filePath, { start, end, highWaterMark: 512 * 1024 }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': fileSize });
    fs.createReadStream(filePath, { highWaterMark: 512 * 1024 }).pipe(res);
  }
});

// ── HEALTH ──
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  rooms: Object.keys(rooms).length
}));

// ── KEEP-ALIVE ──
const SELF_URL = process.env.SELF_URL || process.env.RAILWAY_STATIC_URL || process.env.RENDER_EXTERNAL_URL || null;
function selfPing() {
  if (!SELF_URL) return;
  const url = `${SELF_URL.replace(/\/$/, '')}/health`;
  const lib = url.startsWith('https') ? require('https') : require('http');
  const req = lib.get(url, res => console.log(`[keep-alive] ${new Date().toISOString()} → ${res.statusCode}`));
  req.on('error', err => console.warn(`[keep-alive] failed: ${err.message}`));
  req.end();
}
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
