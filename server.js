const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Storage for uploaded videos
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    // Keep original name but sanitize
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 * 1024 } }); // 4GB limit

// Rooms: { roomId: { clients: Set, videoFile: string, state: {playing, time, updatedAt} } }
const rooms = {};

function getRoom(id) {
  if (!rooms[id]) rooms[id] = { clients: new Set(), videoFile: null, state: { playing: false, time: 0, updatedAt: Date.now() } };
  return rooms[id];
}

function broadcast(roomId, data, exceptWs = null) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(client => {
    if (client !== exceptWs && client.readyState === 1) client.send(msg);
  });
}

// WebSocket handling
wss.on('connection', (ws) => {
  let roomId = null;
  let isHost = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      roomId = msg.roomId;
      isHost = msg.isHost || false;
      const room = getRoom(roomId);
      room.clients.add(ws);

      // Send current state to new joiner
      const currentTime = room.state.playing
        ? room.state.time + (Date.now() - room.state.updatedAt) / 1000
        : room.state.time;

      ws.send(JSON.stringify({
        type: 'init',
        videoFile: room.videoFile,
        state: { ...room.state, time: currentTime },
        viewers: room.clients.size
      }));

      broadcast(roomId, { type: 'viewers', count: room.clients.size }, ws);
    }

    if (msg.type === 'sync' && isHost) {
      const room = getRoom(roomId);
      room.state = { playing: msg.playing, time: msg.time, updatedAt: Date.now() };
      broadcast(roomId, { type: 'sync', playing: msg.playing, time: msg.time }, ws);
    }

    if (msg.type === 'video_ready' && isHost) {
      const room = getRoom(roomId);
      room.videoFile = msg.filename;
      broadcast(roomId, { type: 'video_ready', filename: msg.filename });
    }

    if (msg.type === 'chat') {
      broadcast(roomId, { type: 'chat', name: msg.name, text: msg.text });
    }
  });

  ws.on('close', () => {
    if (roomId && rooms[roomId]) {
      rooms[roomId].clients.delete(ws);
      broadcast(roomId, { type: 'viewers', count: rooms[roomId].clients.size });
      if (rooms[roomId].clients.size === 0) delete rooms[roomId];
    }
  });
});

// Routes
app.use(express.static(path.join(__dirname, 'public')));

app.post('/upload/:roomId', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const room = getRoom(req.params.roomId);
  room.videoFile = req.file.filename;
  res.json({ filename: req.file.filename });
});

function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/mp4',
  };
  return types[ext] || 'video/mp4';
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
    const chunkSize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    file.pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WatchParty running on port ${PORT}`));
