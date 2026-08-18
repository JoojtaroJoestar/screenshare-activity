/* ─────────────────────────────────────────────────────────────────────────
   ScreenShare — Lobby + Multi-stream Viewer
   (app.js)
───────────────────────────────────────────────────────────────────────── */

/* ── Config ─────────────────────────────────────────────────────────── */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/* ── State ──────────────────────────────────────────────────────────── */
let ws = null;
let username  = '';
let avatarUrl = null;   // Discord avatar URL (se autenticado via Discord)
let channelId = null;   // Discord voice channel ID (filtra streams por call)
let reconnectTimer = null;

// Map<streamId, RTCPeerConnection>
const peerConnections = new Map();

// Map<streamId, { stream: StreamInfo, panelEl: HTMLElement }>
const watchingStreams = new Map();

// All available streams from server
let allStreams = [];

// Pending stream join (waiting for password)
let pendingJoinStreamId = null;

/* ── DOM refs ────────────────────────────────────────────────────────── */
const $    = (id) => document.getElementById(id);
const views = {
  loading:  $('view-loading'),
  identity: $('view-identity'),
  lobby:    $('view-lobby'),
  viewer:   $('view-viewer'),
};

function showView(name) {
  debugLog("Trocando tela para: " + name);
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[name].classList.add('active');
}

/* ══════════════════════════════════════════════════════════════════════
   Boot — Verifica Discord antes de qualquer coisa
══════════════════════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {
  // A promise foi criada pelo módule script no <head> assim que a página carregou
  const discordUser = await (window.__discordAuthPromise || Promise.resolve(null));

  if (discordUser) {
    // ✅ Está dentro do Discord e autenticado — entra direto no lobby
    username  = discordUser.username;
    avatarUrl = discordUser.avatarUrl;
    channelId = discordUser.channelId || null;
    connectWS();
    updateTopbar();
    showView('lobby');
  } else {
    // Fora do Discord ou sem credenciais — mostra tela de login
    showView('identity');
  }
});

function debugLog(msg) {
  let log = document.getElementById('debug-log');
  if (!log) {
    log = document.createElement('div');
    log.id = 'debug-log';
    log.style.cssText = 'display:none;position:fixed;bottom:10px;right:10px;background:rgba(0,0,0,0.8);color:#0f0;padding:10px;z-index:99999;font-family:monospace;font-size:12px;max-width:300px;pointer-events:none;';
    document.body.appendChild(log);
  }
  log.innerHTML += '<div>' + msg + '</div>';
}

/* ══════════════════════════════════════════════════════════════════════
   WebSocket Connection
══════════════════════════════════════════════════════════════════════ */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    clearTimeout(reconnectTimer);
    if (username) ws.send(JSON.stringify({
      type:      'identify',
      username,
      channelId, // null em modo standalone
    }));
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    reconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Message Handler
══════════════════════════════════════════════════════════════════════ */
function handleMessage(msg) {
  switch (msg.type) {

    case 'stream_list':
      allStreams = msg.streams;
      renderLobby();
      renderSidebar();
      break;

    case 'thumbnail_update':
      updateThumbnail(msg.streamId, msg.data);
      break;

    // ── Viewer: WebRTC signaling ─────────────────────────────────────
    case 'join_ok': {
      debugLog("Servidor aceitou! Iniciando player...");
      // Store viewerId so we can send it back in ICE/answer messages
      try {
        debugLog("WebRTC typeof: " + typeof RTCPeerConnection);
        debugLog("webkit typeof: " + typeof window.webkitRTCPeerConnection);
      } catch (e) {
        debugLog("ERRO WebRTC: " + e.message);
      }
      const entry = watchingStreams.get(msg.streamId);
      if (entry) entry.viewerId = msg.viewerId;
      startViewerPeer(msg.streamId, msg.viewerId, msg.broadcasterName, msg.thumbnail);
      break;
    }

    case 'join_error':
      handleJoinError(msg.streamId, msg.reason);
      break;

    case 'webrtc_offer':
      debugLog(">> Recebeu webrtc_offer do broadcaster!");
      handleOffer(msg.streamId, msg.offer);
      break;

    case 'webrtc_ice':
      handleRemoteIce(msg.streamId, msg.candidate);
      break;

    case 'stream_ended':
      removeWatchStream(msg.streamId);
      break;

    default:
      break;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   IDENTITY SCREEN
══════════════════════════════════════════════════════════════════════ */
$('btn-enter').addEventListener('click', enterLobby);
$('input-username').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enterLobby();
});

function enterLobby() {
  const raw = $('input-username').value.trim();
  if (!raw) {
    showError('identity-error', 'Por favor, insira um nome.');
    return;
  }
  username = raw.slice(0, 32);
  hideError('identity-error');
  connectWS();
  updateTopbar();
  showView('lobby');
}

function updateTopbar() {
  $('topbar-username').textContent = username;
  const avatar = $('topbar-avatar');
  if (avatarUrl) {
    // Usa o avatar real do Discord
    avatar.innerHTML = `<img src="${avatarUrl}" alt="${escHtml(username)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    avatar.textContent = username.charAt(0).toUpperCase();
  }
}

/* ══════════════════════════════════════════════════════════════════════
   LOBBY
══════════════════════════════════════════════════════════════════════ */
function renderLobby() {
  const grid = $('streams-grid');
  const count = $('lobby-count');

  if (allStreams.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎬</div>
        <h3>Nenhuma transmissão ativa</h3>
        <p>Clique em "Transmitir tela" para começar. Seus amigos verão seu stream aqui.</p>
      </div>`;
    count.textContent = 'Nenhuma transmissão ativa';
    return;
  }

  count.textContent = `${allStreams.length} transmissão${allStreams.length > 1 ? 'ões' : ''} ao vivo`;

  grid.innerHTML = allStreams.map(s => buildStreamCard(s)).join('');

  // Attach click events
  grid.querySelectorAll('.stream-card').forEach(card => {
    card.addEventListener('click', () => {
      debugLog("Botão clicado! Tentando entrar...");
      const id = card.dataset.streamId;
      requestJoinStream(id);
    });
  });
}

function buildStreamCard(s) {
  const thumb = s.thumbnail
    ? `<img src="${s.thumbnail}" alt="Preview de ${escHtml(s.broadcasterName)}">`
    : `<div class="stream-thumbnail-placeholder">
         <span>🖥️</span>
         <span>Aguardando preview...</span>
       </div>`;

  const watchingBadge = watchingStreams.has(s.id)
    ? `<span style="position:absolute;bottom:10px;left:10px;background:rgba(114,87,255,0.9);color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;">Assistindo</span>`
    : '';

  return `
    <div class="stream-card" data-stream-id="${s.id}">
      <div class="stream-thumbnail">
        ${thumb}
        <div class="live-badge">AO VIVO</div>
        ${s.isPrivate ? '<div class="private-badge">🔒 Privado</div>' : ''}
        ${watchingBadge}
      </div>
      <div class="stream-info">
        <div class="stream-name">${escHtml(s.name)}</div>
        <div class="stream-meta">
          <div class="stream-broadcaster">
            <div class="stream-broadcaster-avatar">${escHtml(s.broadcasterName.charAt(0).toUpperCase())}</div>
            ${escHtml(s.broadcasterName)}
          </div>
          <div class="stream-viewers">👥 ${s.viewerCount}</div>
        </div>
      </div>
      <div class="watch-btn">
        <div class="watch-btn-inner">
          ${watchingStreams.has(s.id) ? '➕ Adicionar à grade' : '▶ Assistir'}
        </div>
      </div>
    </div>`;
}

function updateThumbnail(streamId, data) {
  // Update in allStreams cache
  const s = allStreams.find(x => x.id === streamId);
  if (s) s.thumbnail = data;

  // Update in lobby cards
  const card = document.querySelector(`.stream-card[data-stream-id="${streamId}"]`);
  if (card) {
    const thumb = card.querySelector('.stream-thumbnail');
    const existing = thumb.querySelector('img');
    if (existing) {
      existing.src = data;
    } else {
      thumb.querySelector('.stream-thumbnail-placeholder')?.remove();
      const img = document.createElement('img');
      img.src = data;
      img.alt = 'Preview';
      thumb.prepend(img);
    }
  }

  // Update in sidebar
  const sideThumb = document.querySelector(`.sidebar-stream-thumb[data-stream-id="${streamId}"]`);
  if (sideThumb) sideThumb.src = data;
}

/* ─── Open Broadcaster Page ─────────────────────────────────────────────── */
$('btn-open-broadcast').addEventListener('click', () => {
  const params = new URLSearchParams({
    username,
    ...(channelId ? { channelId } : {}),
  });
  const url = `${location.origin}/broadcast.html?${params}`;
  if (window.discordSdk) {
    window.discordSdk.commands.openExternalLink({ url });
  } else {
    window.open(url, '_blank', 'width=960,height=640');
  }
});

/* ══════════════════════════════════════════════════════════════════════
   JOIN STREAM (with password flow)
══════════════════════════════════════════════════════════════════════ */
function requestJoinStream(streamId) {
  if (watchingStreams.has(streamId)) {
    // Already watching — switch to viewer view
    showView('viewer');
    return;
  }

  const stream = allStreams.find(s => s.id === streamId);
  if (!stream) {
    debugLog("Erro: stream " + streamId + " não encontrado!");
    return;
  }

  if (stream.isPrivate) {
    // Show password modal
    pendingJoinStreamId = streamId;
    $('modal-password-desc').textContent = `"${escHtml(stream.name)}" é privado. Insira a senha para entrar.`;
    $('input-stream-password').value = '';
    hideError('modal-password-error');
    $('modal-password').classList.remove('hidden');
    $('input-stream-password').focus();
  } else {
    joinStream(streamId, '');
  }
}

function joinStream(streamId, password) {
  send({ type: 'join_stream', streamId, password });
}

function handleJoinError(streamId, reason) {
  if (reason === 'Wrong password') {
    showError('modal-password-error', 'Senha incorreta. Tente novamente.');
    $('input-stream-password').focus();
  } else {
    debugLog(`Erro ao entrar no stream: ${reason}`);
    $('modal-password').classList.add('hidden');
  }
}

// Password modal events
$('btn-password-confirm').addEventListener('click', confirmPassword);
$('input-stream-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmPassword();
});
$('btn-password-cancel').addEventListener('click', () => {
  pendingJoinStreamId = null;
  $('modal-password').classList.add('hidden');
});

function confirmPassword() {
  const pw = $('input-stream-password').value;
  if (!pw) {
    showError('modal-password-error', 'Digite a senha.');
    return;
  }
  $('modal-password').classList.add('hidden');
  joinStream(pendingJoinStreamId, pw);
  pendingJoinStreamId = null;
}

/* ══════════════════════════════════════════════════════════════════════
   WebRTC — VIEWER
══════════════════════════════════════════════════════════════════════ */
async function startViewerPeer(streamId, viewerId, broadcasterName, thumbnail) {
  let pc;
  try {
    const PCConstructor = typeof RTCPeerConnection === 'function' ? RTCPeerConnection 
                        : (window.webkitRTCPeerConnection || window.mozRTCPeerConnection);
    if (!PCConstructor) {
      throw new Error("Nenhum construtor WebRTC suportado neste navegador");
    }
    pc = new PCConstructor({ iceServers: ICE_SERVERS });
    debugLog("PC criado com sucesso!");
  } catch(e) {
    debugLog("ERRO CRÍTICO no startViewerPeer: " + e.message);
    return;
  }
  peerConnections.set(streamId, pc);

  // Add video panel immediately (with loading state)
  // watchingStreams entry may already exist (created in join_ok handler) — update it
  const panel = addVideoPanel(streamId, broadcasterName, viewerId);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      // Use stored viewerId from watchingStreams in case it was updated
      const storedViewerId = watchingStreams.get(streamId)?.viewerId || viewerId;
      send({
        type: 'webrtc_ice',
        streamId,
        candidate: e.candidate,
        viewerId: storedViewerId,
        target: 'broadcaster',
      });
    }
  };

  pc.ontrack = (e) => {
    const video = panel.querySelector('video');
    const connecting = panel.querySelector('.video-panel-connecting');
    if (video) {
      video.srcObject = e.streams[0];
      video.play().catch(() => {});
      connecting?.classList.add('hidden');
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      removeWatchStream(streamId);
    }
  };

  // Show viewer view
  showView('viewer');
  updateVideoGrid();
}

async function handleOffer(streamId, offer) {
  debugLog("Processando oferta...");
  const pc = peerConnections.get(streamId);
  if (!pc) {
    debugLog("ERRO: pc não encontrado em handleOffer!");
    return;
  }

  try {
    debugLog("setRemoteDescription");
    await pc.setRemoteDescription(offer);
    debugLog("createAnswer");
    const answer = await pc.createAnswer();
    debugLog("setLocalDescription");
    await pc.setLocalDescription(answer);

    debugLog("Enviando webrtc_answer...");
    const entry = watchingStreams.get(streamId);
    send({
      type: 'webrtc_answer',
      streamId,
      answer,
      viewerId: entry ? entry.viewerId : null,
    });
  } catch (err) {
    debugLog("ERRO no handleOffer: " + err.message);
    console.error('Error handling offer', err);
  }
}

async function handleRemoteIce(streamId, candidate) {
  const pc = peerConnections.get(streamId);
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch { /* ignore */ }
}

/* ══════════════════════════════════════════════════════════════════════
   Video Grid Management
══════════════════════════════════════════════════════════════════════ */
function addVideoPanel(streamId, broadcasterName, viewerId) {
  const grid = $('video-grid');

  const panel = document.createElement('div');
  panel.className = 'video-panel';
  panel.dataset.streamId = streamId;

  panel.innerHTML = `
    <video autoplay playsinline></video>
    <div class="video-panel-connecting">
      <div class="spinner"></div>
      <p>Conectando a ${escHtml(broadcasterName)}...</p>
    </div>
    <div class="video-panel-overlay">
      <div class="video-panel-top">
        <button class="btn-icon btn-fullscreen" title="Tela cheia">⛶</button>
        <button class="btn-icon btn-danger" title="Fechar" style="color:#ed4245">✕</button>
      </div>
      <div class="video-panel-bottom" style="display:flex; justify-content:space-between; align-items:center;">
        <div class="video-panel-name">${escHtml(broadcasterName)}</div>
        <div class="video-panel-volume" style="display:flex; align-items:center; gap:8px;">
          <button class="btn-icon btn-mute" title="Mutar" style="font-size:16px;">🔊</button>
          <input type="range" class="volume-slider" min="0" max="1" step="0.05" value="1" style="width:80px; accent-color:var(--accent);">
        </div>
      </div>
    </div>`;

  const video = panel.querySelector('video');
  const muteBtn = panel.querySelector('.btn-mute');
  const volSlider = panel.querySelector('.volume-slider');

  muteBtn.onclick = () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
  };

  volSlider.oninput = (e) => {
    video.volume = e.target.value;
    if (video.volume === 0) {
      video.muted = true;
      muteBtn.textContent = '🔇';
    } else {
  const stream = allStreams.find(s => s.id === streamId);
  if (!stream) {
    debugLog("Erro: stream " + streamId + " não encontrado!");
    return;
  }

  if (stream.isPrivate) {
    // Show password modal
    pendingJoinStreamId = streamId;
    $('modal-password-desc').textContent = `"${escHtml(stream.name)}" é privado. Insira a senha para entrar.`;
    $('input-stream-password').value = '';
    hideError('modal-password-error');
    $('modal-password').classList.remove('hidden');
    $('input-stream-password').focus();
  } else {
    joinStream(streamId, '');
  }
}

function joinStream(streamId, password) {
  send({ type: 'join_stream', streamId, password });
}

function handleJoinError(streamId, reason) {
  if (reason === 'Wrong password') {
    showError('modal-password-error', 'Senha incorreta. Tente novamente.');
    $('input-stream-password').focus();
  } else {
    debugLog(`Erro ao entrar no stream: ${reason}`);
    $('modal-password').classList.add('hidden');
  }
}

// Password modal events
$('btn-password-confirm').addEventListener('click', confirmPassword);
$('input-stream-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmPassword();
});
$('btn-password-cancel').addEventListener('click', () => {
  pendingJoinStreamId = null;
  $('modal-password').classList.add('hidden');
});

function confirmPassword() {
  const pw = $('input-stream-password').value;
  if (!pw) {
    showError('modal-password-error', 'Digite a senha.');
    return;
  }
  $('modal-password').classList.add('hidden');
  joinStream(pendingJoinStreamId, pw);
  pendingJoinStreamId = null;
}

/* ══════════════════════════════════════════════════════════════════════
   WebRTC — VIEWER
══════════════════════════════════════════════════════════════════════ */
async function startViewerPeer(streamId, viewerId, broadcasterName, thumbnail) {
  let pc;
  try {
    const PCConstructor = typeof RTCPeerConnection === 'function' ? RTCPeerConnection 
                        : (window.webkitRTCPeerConnection || window.mozRTCPeerConnection);
    if (!PCConstructor) {
      throw new Error("Nenhum construtor WebRTC suportado neste navegador");
    }
    pc = new PCConstructor({ iceServers: ICE_SERVERS });
    debugLog("PC criado com sucesso!");
  } catch(e) {
    debugLog("ERRO CRÍTICO no startViewerPeer: " + e.message);
    return;
  }
  peerConnections.set(streamId, pc);

  // Add video panel immediately (with loading state)
  // watchingStreams entry may already exist (created in join_ok handler) — update it
  const panel = addVideoPanel(streamId, broadcasterName, viewerId);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      // Use stored viewerId from watchingStreams in case it was updated
      const storedViewerId = watchingStreams.get(streamId)?.viewerId || viewerId;
      send({
        type: 'webrtc_ice',
        streamId,
        candidate: e.candidate,
        viewerId: storedViewerId,
        target: 'broadcaster',
      });
    }
  };

  pc.ontrack = (e) => {
    const video = panel.querySelector('video');
    const connecting = panel.querySelector('.video-panel-connecting');
    if (video) {
      video.srcObject = e.streams[0];
      video.play().catch(() => {});
      connecting?.classList.add('hidden');
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      removeWatchStream(streamId);
    }
  };

  // Show viewer view
  showView('viewer');
  updateVideoGrid();
}

async function handleOffer(streamId, offer) {
  debugLog("Processando oferta...");
  const pc = peerConnections.get(streamId);
  if (!pc) {
    debugLog("ERRO: pc não encontrado em handleOffer!");
    return;
  }

  try {
    debugLog("setRemoteDescription");
    await pc.setRemoteDescription(offer);
    debugLog("createAnswer");
    const answer = await pc.createAnswer();
    debugLog("setLocalDescription");
    await pc.setLocalDescription(answer);

    debugLog("Enviando webrtc_answer...");
    const entry = watchingStreams.get(streamId);
    send({
      type: 'webrtc_answer',
      streamId,
      answer,
      viewerId: entry ? entry.viewerId : null,
    });
  } catch (err) {
    debugLog("ERRO no handleOffer: " + err.message);
    console.error('Error handling offer', err);
  }
}

async function handleRemoteIce(streamId, candidate) {
  const pc = peerConnections.get(streamId);
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch { /* ignore */ }
}

/* ══════════════════════════════════════════════════════════════════════
   Video Grid Management
══════════════════════════════════════════════════════════════════════ */
function addVideoPanel(streamId, broadcasterName, viewerId) {
  const grid = $('video-grid');

  const panel = document.createElement('div');
  panel.className = 'video-panel';
  panel.dataset.streamId = streamId;

  panel.innerHTML = `
    <video autoplay playsinline></video>
    <div class="video-panel-connecting">
      <div class="spinner"></div>
      <p>Conectando a ${escHtml(broadcasterName)}...</p>
    </div>
    <div class="video-panel-overlay">
      <div class="video-panel-top">
        <button class="btn-icon btn-fullscreen" title="Tela cheia">⛶</button>
        <button class="btn-icon btn-danger" title="Fechar" style="color:#ed4245">✕</button>
      </div>
      <div class="video-panel-bottom" style="display:flex; justify-content:space-between; align-items:center;">
        <div class="video-panel-name">${escHtml(broadcasterName)}</div>
        <div class="video-panel-volume" style="display:flex; align-items:center; gap:8px;">
          <button class="btn-icon btn-mute" title="Mutar" style="font-size:16px;">🔊</button>
          <input type="range" class="volume-slider" min="0" max="1" step="0.05" value="1" style="width:80px; accent-color:var(--accent);">
        </div>
      </div>
    </div>`;

  const video = panel.querySelector('video');
  const muteBtn = panel.querySelector('.btn-mute');
  const volSlider = panel.querySelector('.volume-slider');

  muteBtn.onclick = () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
  };

  volSlider.oninput = (e) => {
    video.volume = e.target.value;
    if (video.volume === 0) {
      video.muted = true;
      muteBtn.textContent = '🔇';
    } else {
      video.muted = false;
      muteBtn.textContent = '🔊';
    }
  };

  const fullscreenBtn = panel.querySelector('.btn-fullscreen');
  const closeBtn = panel.querySelector('.btn-danger');

  fullscreenBtn.onclick = () => toggleFullscreen(streamId);
  closeBtn.onclick = () => removeWatchStream(streamId);

  grid.appendChild(panel);

  // Track (preserve viewerId if already stored by join_ok handler)
  const existing = watchingStreams.get(streamId);
  const stream = allStreams.find(s => s.id === streamId);
  watchingStreams.set(streamId, {
    stream: stream || { id: streamId, name: broadcasterName, broadcasterName },
    panelEl: panel,
    viewerId: viewerId || existing?.viewerId || null,
  });

  updateVideoGrid();
  renderSidebar();
  renderLobby();
  return panel;
}

function updateVideoGrid() {
  const grid = $('video-grid');
  const count = watchingStreams.size;
  grid.dataset.count = Math.min(count, 6).toString();
}

function removeWatchStream(streamId) {
  const entry = watchingStreams.get(streamId);
  if (entry) {
    entry.panelEl.remove();
    watchingStreams.delete(streamId);
  }
  const pc = peerConnections.get(streamId);
  if (pc) {
    pc.close();
    peerConnections.delete(streamId);
  }
  send({ type: 'leave_stream', streamId });
  updateVideoGrid();
  renderSidebar();
  renderLobby();

  // Go back to lobby if no streams left
  if (watchingStreams.size === 0) showView('lobby');
}

function toggleFullscreen(streamId) {
  const panel = document.querySelector(`.video-panel[data-stream-id="${streamId}"]`);
  if (!panel) return;
  const isExpanded = panel.classList.toggle('pseudo-fullscreen');
  const btn = panel.querySelector('.btn-fullscreen');
  if (btn) {
    btn.textContent = isExpanded ? '🗕' : '⛶';
    btn.title = isExpanded ? 'Minimizar' : 'Tela cheia';
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SIDEBAR
══════════════════════════════════════════════════════════════════════ */
function renderSidebar() {
  const list = $('sidebar-streams-list');
  const available = allStreams.filter(s => !watchingStreams.has(s.id));

  if (available.length === 0) {
    list.innerHTML = '<p style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">Sem outros streams disponíveis.</p>';
    return;
  }

  list.innerHTML = available.map(s => `
    <div class="sidebar-stream-item" onclick="requestJoinStream('${s.id}')">
      ${s.thumbnail
        ? `<img class="sidebar-stream-thumb" data-stream-id="${s.id}" src="${s.thumbnail}" alt="">`
        : `<div class="sidebar-stream-thumb" style="background:#0a0a0f;display:flex;align-items:center;justify-content:center;font-size:16px">🖥️</div>`}
      <div class="sidebar-stream-info">
        <div class="sidebar-stream-name">${escHtml(s.name)}</div>
        <div class="sidebar-stream-meta">${escHtml(s.broadcasterName)} · 👥 ${s.viewerCount}</div>
      </div>
      ${s.isPrivate ? '<span title="Privado">🔒</span>' : ''}
    </div>`).join('');
}

// Sidebar toggle
$('btn-sidebar-toggle').addEventListener('click', () => {
  $('viewer-sidebar').classList.toggle('collapsed');
});
$('btn-close-sidebar').addEventListener('click', () => {
  $('viewer-sidebar').classList.add('collapsed');
});

// Back to lobby
$('btn-back-lobby').addEventListener('click', () => {
  showView('lobby');
});

/* ══════════════════════════════════════════════════════════════════════
   Utilities
══════════════════════════════════════════════════════════════════════ */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showError(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
}

function hideError(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('visible');
}

window.toggleDebugLogs = function() { const log = document.getElementById('debug-log'); if(log) log.style.display = (log.style.display === 'none') ? 'block' : 'none'; };
