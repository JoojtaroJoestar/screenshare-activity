require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ─── Static Files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../client'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.use(express.json());

// Allow Discord to embed via iframe (required for Activities)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.removeHeader('X-Frame-Options');
  next();
});

// ─── API: Discord Config (safe — only exposes client ID, not secret) ──────────
app.get('/api/config', (req, res) => {
  res.json({
    discordClientId: process.env.DISCORD_CLIENT_ID || null,
  });
});

// ─── API: Token Exchange (server-side to protect client secret) ───────────────
app.post('/api/token', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const clientId     = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Discord credentials not configured in .env' });
  }

  try {
    const response = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'authorization_code',
        code,
      }),
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error_description || data.error });
    res.json({ access_token: data.access_token });
  } catch (err) {
    console.error('Token exchange error:', err);
    res.status(500).json({ error: 'Token exchange failed' });
  }
});


// ─── State ───────────────────────────────────────────────────────────────────
// streams: Map<streamId, StreamObject>
const streams = new Map();

// clients: Map<WebSocket, ClientInfo>
const clients = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────
function safeJson(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function buildStreamList(channelId) {
  // If channelId is provided, only return streams from that channel.
  // Standalone clients (no channelId) see ALL streams.
  return Array.from(streams.values())
    .filter(s => !channelId || s.channelId === channelId)
    .map((s) => ({
      id:             s.id,
      name:           s.name,
      broadcasterName: s.broadcasterName,
      isPrivate:      s.isPrivate,
      viewerCount:    s.viewers.size,
      thumbnail:      s.thumbnail,
      createdAt:      s.createdAt,
    }));
}

// Send personalised stream list to one client
function sendStreamListTo(ws) {
  const client = clients.get(ws);
  if (!client || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type:    'stream_list',
    streams: buildStreamList(client.channelId || null),
  }));
}

// Broadcast personalised stream lists to every connected client
function broadcastStreamList() {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) sendStreamListTo(ws);
  });
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(ws, {
    id: clientId,
    username: 'Anonymous',
    role: null,       // 'broadcaster' | 'viewer' | null
    streamId: null,   // active broadcast stream (broadcaster only)
    watchingIds: new Set(), // streams the viewer is watching
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const client = clients.get(ws);
    if (!client) return;

    switch (msg.type) {

      // ── Identify ─────────────────────────────────────────────────────────
      case 'identify': {
        client.username  = (msg.username  || 'Anonymous').trim().slice(0, 32);
        client.channelId = msg.channelId  || null;   // Discord voice channel ID
        // Send filtered stream list immediately
        sendStreamListTo(ws);
        break;
      }

      // ── Start Stream ─────────────────────────────────────────────────────
      case 'start_stream': {
        // Each client can only host one stream at a time
        if (client.role === 'broadcaster' && client.streamId) {
          const old = streams.get(client.streamId);
          if (old) {
            old.viewers.forEach((vWs) => safeJson(vWs, { type: 'stream_ended', streamId: client.streamId }));
            streams.delete(client.streamId);
          }
        }

        const streamId = uuidv4().slice(0, 8).toUpperCase();
        streams.set(streamId, {
          id:              streamId,
          name:            (msg.name || `${client.username}'s Stream`).slice(0, 64),
          broadcasterName: client.username,
          broadcasterWs:   ws,
          isPrivate:       !!msg.isPrivate,
          password:        msg.isPrivate ? (msg.password || '') : null,
          channelId:       msg.channelId || client.channelId || null,
          viewers:         new Map(), // viewerId -> ws
          thumbnail:       null,
          createdAt:       Date.now(),
        });

        client.role = 'broadcaster';
        client.streamId = streamId;

        safeJson(ws, { type: 'stream_started', streamId });
        broadcastStreamList();
        break;
      }

      // ── Stop Stream ──────────────────────────────────────────────────────
      case 'stop_stream': {
        const stream = streams.get(client.streamId);
        if (stream && stream.broadcasterWs === ws) {
          stream.viewers.forEach((vWs) => safeJson(vWs, { type: 'stream_ended', streamId: client.streamId }));
          streams.delete(client.streamId);
          client.role = null;
          client.streamId = null;
          broadcastStreamList();
        }
        break;
      }

      // ── Join Stream (Viewer) ─────────────────────────────────────────────
      case 'join_stream': {
        const stream = streams.get(msg.streamId);
        if (!stream) {
          safeJson(ws, { type: 'join_error', streamId: msg.streamId, reason: 'Stream not found' });
          return;
        }
        if (stream.isPrivate && stream.password !== msg.password) {
          safeJson(ws, { type: 'join_error', streamId: msg.streamId, reason: 'Wrong password' });
          return;
        }
        if (stream.viewers.has(clientId)) {
          safeJson(ws, { type: 'join_error', streamId: msg.streamId, reason: 'Already watching' });
          return;
        }

        stream.viewers.set(clientId, ws);
        client.watchingIds.add(msg.streamId);

        safeJson(ws, {
          type: 'join_ok',
          streamId: msg.streamId,
          viewerId: clientId,
          thumbnail: stream.thumbnail,
          broadcasterName: stream.broadcasterName,
        });

        // Ask broadcaster to create a WebRTC offer for this viewer
        safeJson(stream.broadcasterWs, {
          type: 'viewer_joined',
          viewerId: clientId,
          viewerName: client.username,
          streamId: msg.streamId,
        });

        broadcastStreamList();
        break;
      }

      // ── Leave Stream ─────────────────────────────────────────────────────
      case 'leave_stream': {
        const stream = streams.get(msg.streamId);
        if (stream) {
          stream.viewers.delete(clientId);
          client.watchingIds.delete(msg.streamId);
          safeJson(stream.broadcasterWs, {
            type: 'viewer_left',
            viewerId: clientId,
            streamId: msg.streamId,
          });
          broadcastStreamList();
        }
        break;
      }

      // ── WebRTC: Offer (broadcaster → viewer) ─────────────────────────────
      case 'webrtc_offer': {
        const stream = streams.get(msg.streamId);
        if (!stream) return;
        const viewerWs = stream.viewers.get(msg.viewerId);
        safeJson(viewerWs, {
          type: 'webrtc_offer',
          offer: msg.offer,
          streamId: msg.streamId,
        });
        break;
      }

      // ── WebRTC: Answer (viewer → broadcaster) ─────────────────────────────
      case 'webrtc_answer': {
        const stream = streams.get(msg.streamId);
        if (!stream) return;
        safeJson(stream.broadcasterWs, {
          type: 'webrtc_answer',
          answer: msg.answer,
          viewerId: msg.viewerId,
          streamId: msg.streamId,
        });
        break;
      }

      // ── WebRTC: ICE Candidate relay ───────────────────────────────────────
      case 'webrtc_ice': {
        const stream = streams.get(msg.streamId);
        if (!stream) return;

        if (msg.target === 'broadcaster') {
          safeJson(stream.broadcasterWs, {
            type: 'webrtc_ice',
            candidate: msg.candidate,
            viewerId: msg.viewerId,
            streamId: msg.streamId,
          });
        } else {
          const viewerWs = stream.viewers.get(msg.viewerId);
          safeJson(viewerWs, {
            type: 'webrtc_ice',
            candidate: msg.candidate,
            streamId: msg.streamId,
          });
        }
        break;
      }

      // ── Thumbnail update (broadcaster → lobby) ────────────────────────────
      case 'thumbnail': {
        const stream = streams.get(client.streamId);
        if (!stream || stream.broadcasterWs !== ws) return;
        stream.thumbnail = msg.data; // base64 JPEG

        const thumbMsg = JSON.stringify({
          type: 'thumbnail_update',
          streamId: client.streamId,
          data: msg.data,
        });
        wss.clients.forEach((c) => {
          if (c !== ws && c.readyState === WebSocket.OPEN) c.send(thumbMsg);
        });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;

    // Cleanup broadcaster
    if (client.role === 'broadcaster' && client.streamId) {
      const stream = streams.get(client.streamId);
      if (stream) {
        stream.viewers.forEach((vWs) => safeJson(vWs, { type: 'stream_ended', streamId: client.streamId }));
        streams.delete(client.streamId);
      }
    }

    // Cleanup viewer connections
    client.watchingIds.forEach((streamId) => {
      const stream = streams.get(streamId);
      if (stream) {
        stream.viewers.delete(client.id);
        safeJson(stream.broadcasterWs, {
          type: 'viewer_left',
          viewerId: client.id,
          streamId,
        });
      }
    });

    clients.delete(ws);
    broadcastStreamList();
  });

  ws.on('error', () => ws.terminate());
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🖥️  ScreenShare server running → http://localhost:${PORT}`);
});
