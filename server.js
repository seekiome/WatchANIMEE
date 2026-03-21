const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = {};

function getRoom(id) {
  if (!rooms[id]) rooms[id] = {
    host: null,
    clients: new Map(),
    state: { playing: false, time: 0, updatedAt: Date.now() },
    hasVideo: false
  };
  return rooms[id];
}

function broadcast(roomId, data, exceptWs = null) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  if (room.host && room.host !== exceptWs && room.host.readyState === 1) room.host.send(msg);
  room.clients.forEach(client => {
    if (client !== exceptWs && client.readyState === 1) client.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function getViewerCount(room) {
  return room.clients.size + (room.host ? 1 : 0);
}

wss.on('connection', (ws) => {
  let roomId = null;
  let clientId = null;
  let isHost = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      roomId = msg.roomId;
      isHost = msg.isHost || false;
      clientId = msg.clientId || Math.random().toString(36).substr(2, 8);
      const room = getRoom(roomId);

      if (isHost) {
        room.host = ws;
      } else {
        room.clients.set(clientId, ws);
      }

      const currentTime = room.state.playing
        ? room.state.time + (Date.now() - room.state.updatedAt) / 1000
        : room.state.time;

      sendTo(ws, {
        type: 'init',
        hasVideo: room.hasVideo,
        state: { ...room.state, time: currentTime },
        viewers: getViewerCount(room),
        clientId
      });

      broadcast(roomId, { type: 'viewers', count: getViewerCount(room) }, ws);

      if (!isHost && room.hasVideo && room.host) {
        sendTo(room.host, { type: 'peer_request', clientId });
      }
    }

    if (msg.type === 'sync' && isHost) {
      const room = getRoom(roomId);
      room.state = { playing: msg.playing, time: msg.time, updatedAt: Date.now() };
      broadcast(roomId, { type: 'sync', playing: msg.playing, time: msg.time }, ws);
    }

    if (msg.type === 'video_ready' && isHost) {
      const room = getRoom(roomId);
      room.hasVideo = true;
      broadcast(roomId, { type: 'video_ready' }, ws);
      room.clients.forEach((_, cid) => {
        sendTo(ws, { type: 'peer_request', clientId: cid });
      });
    }

    if (msg.type === 'offer') {
      const room = getRoom(roomId);
      const target = room.clients.get(msg.targetId);
      if (target) sendTo(target, { type: 'offer', offer: msg.offer });
    }

    if (msg.type === 'answer') {
      const room = getRoom(roomId);
      if (room.host) sendTo(room.host, { type: 'answer', answer: msg.answer, clientId });
    }

    if (msg.type === 'ice') {
      const room = getRoom(roomId);
      if (msg.toHost && room.host) {
        sendTo(room.host, { type: 'ice', candidate: msg.candidate, clientId });
      } else if (!msg.toHost) {
        const target = room.clients.get(msg.targetId);
        if (target) sendTo(target, { type: 'ice', candidate: msg.candidate });
      }
    }

    if (msg.type === 'chat') {
      broadcast(roomId, { type: 'chat', name: msg.name, text: msg.text });
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (isHost) {
      room.host = null;
      room.hasVideo = false;
      broadcast(roomId, { type: 'host_left' });
    } else {
      room.clients.delete(clientId);
    }
    broadcast(roomId, { type: 'viewers', count: getViewerCount(room) });
    if (!room.host && room.clients.size === 0) delete rooms[roomId];
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WatchParty P2P running on port ${PORT}`));
