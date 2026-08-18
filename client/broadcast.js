/* ─────────────────────────────────────────────────────────────────────────
   ScreenShare — Broadcaster Page
   (broadcast.js)
───────────────────────────────────────────────────────────────────────── */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/* ── State ──────────────────────────────────────────────────────────── */
let ws = null;
let localStream = null;
let streamId    = null;
let channelId   = null;  // Discord voice channel ID (recebido via URL param)
let selectedQuality = 'high';
let viewerCount = 0;
let startTime   = null;
let durationInterval = null;
let thumbnailInterval = null;
let username = '';

// Map<viewerId, RTCPeerConnection>
const peerConnections = new Map();

function debugLog(msg) {
  let log = document.getElementById('debug-log');
  if (!log) {
    log = document.createElement('div');
    log.id = 'debug-log';
    log.style.cssText = 'position:fixed;bottom:10px;left:10px;background:rgba(0,0,0,0.8);color:#0f0;padding:10px;z-index:99999;font-family:monospace;font-size:12px;max-width:300px;pointer-events:none;';
    document.body.appendChild(log);
  }
  log.innerHTML += '<div>' + msg + '</div>';
}

/* ── DOM ─────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const QUALITY_MAP = {
  high:   { width: 1920, height: 1080, frameRate: 30, label: '1080p' },
  medium: { width: 1280, height: 720,  frameRate: 30, label: '720p'  },
  low:    { width: 854,  height: 480,  frameRate: 15, label: '480p'  },
};

/* ── Init ─────────────────────────────────────────────────────────────── */
window.addEventListener('load', () => {
  // Verifica suporte a getDisplayMedia (não disponível em iOS)
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if (!supported) {
    document.querySelector('.broadcast-setup h2').textContent = '❌ Dispositivo não suportado';
    document.querySelector('.broadcast-setup > p').innerHTML =
      'Compartilhamento de tela não é suportado neste dispositivo.<br><br>' +
      '<strong>Dispositivos compatíveis:</strong><br>' +
      '✅ PC (Chrome, Firefox, Edge)<br>' +
      '⚠️ Android Chrome (suporte parcial)<br>' +
      '❌ iOS Safari (não suportado)';
    $('btn-start-stream').disabled = true;
    $('btn-start-stream').textContent = 'Não disponível neste dispositivo';
    return;
  }

  // Read params from URL (passed by lobby when opening this tab)
  const params = new URLSearchParams(location.search);
  username  = params.get('username') || 'Broadcaster';
  channelId = params.get('channelId') || null;

  $('setup-username-label').textContent = `Olá, ${username}`;
  $('input-stream-name').value = `${username}'s Stream`;
  $('input-stream-name').focus();

  connectWS();
  setupQualityPicker();
  setupPrivateToggle();
});

/* ── WebSocket ────────────────────────────────────────────────────────── */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({
    type: 'identify',
    username,
    channelId,  // necessário para filtrar streams por canal no servidor
  }));
  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleMessage(msg);
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => ws.close();
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

/* ── Messages ─────────────────────────────────────────────────────────── */
async function handleMessage(msg) {
  switch (msg.type) {

    case 'stream_started':
      streamId = msg.streamId;
      startLiveView();
      break;

    case 'viewer_joined':
      await handleViewerJoined(msg.viewerId, msg.viewerName, msg.streamId);
      viewerCount++;
      $('stat-viewers').textContent = viewerCount;
      break;

    case 'viewer_left':
      handleViewerLeft(msg.viewerId);
      viewerCount = Math.max(0, viewerCount - 1);
      $('stat-viewers').textContent = viewerCount;
      break;

    case 'webrtc_answer':
      await handleAnswer(msg.viewerId, msg.answer, msg.streamId);
      break;

    case 'webrtc_ice':
      await handleRemoteIce(msg.viewerId, msg.candidate, msg.streamId);
      break;

    default:
      break;
  }
}

/* ── Setup UI ─────────────────────────────────────────────────────────── */
function setupQualityPicker() {
  document.querySelectorAll('.quality-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      document.querySelectorAll('.quality-opt').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      selectedQuality = opt.dataset.quality;
    });
  });
}

function setupPrivateToggle() {
  $('toggle-private').addEventListener('change', (e) => {
    $('password-field').style.display = e.target.checked ? 'block' : 'none';
  });
}

/* ── Start Stream ─────────────────────────────────────────────────────── */
$('btn-start-stream').addEventListener('click', startStream);
$('btn-start-camera').addEventListener('click', startCameraStream);

async function startStream() {
  const name = $('input-stream-name').value.trim() || `${username}'s Stream`;
  const isPrivate = $('toggle-private').checked;
  const password = isPrivate ? $('input-password').value : '';

  if (isPrivate && !password) {
    showSetupError('Insira uma senha para o stream privado.');
    return;
  }
  hideSetupError();

  // Get screen capture — prefer entire screen
  const q = QUALITY_MAP[selectedQuality];
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        // displaySurface: 'monitor' pede tela inteira por padrão
        displaySurface: 'monitor',
        width:     { ideal: q.width },
        height:    { ideal: q.height },
        frameRate: { ideal: q.frameRate },
        cursor:    'always',
      },
      audio: {
        echoCancellation:  false,
        noiseSuppression:  false,
        sampleRate:        44100,
      },
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showSetupError('Você precisa permitir o compartilhamento de tela para continuar.');
    } else {
      showSetupError(`Erro ao capturar tela: ${err.message}`);
    }
    return;
  }

  finishStartStream(name, isPrivate, password);
}

async function startCameraStream() {
  const name = $('input-stream-name').value.trim() || `${username}'s Camera`;
  const isPrivate = $('toggle-private').checked;
  const password = isPrivate ? $('input-password').value : '';

  if (isPrivate && !password) {
    showSetupError('Insira uma senha para o stream privado.');
    return;
  }
  hideSetupError();

  const q = QUALITY_MAP[selectedQuality];
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user', // prefer front camera
        width:     { ideal: q.width },
        height:    { ideal: q.height },
        frameRate: { ideal: q.frameRate }
      },
      audio: {
        echoCancellation:  true,
        noiseSuppression:  true,
      },
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showSetupError('Você precisa permitir acesso à câmera e microfone para continuar.');
    } else {
      showSetupError(`Erro ao capturar câmera: ${err.message}`);
    }
    return;
  }

  finishStartStream(name, isPrivate, password);
}

function finishStartStream(name, isPrivate, password) {
  // Show preview
  $('preview-video').srcObject = localStream;

  // Register stream on server
  send({
    type:      'start_stream',
    name,
    isPrivate,
    password,
    channelId,  // agrupa stream pelo canal de voz do Discord
  });

  // Handle stream ending from OS-level stop
  localStream.getVideoTracks()[0].addEventListener('ended', stopStream);

  $('live-stream-name').textContent = name;
  $('stat-quality').textContent = q.label;
}

function startLiveView() {
  $('setup-view').classList.add('hidden');
  $('live-view').classList.remove('hidden');

  startTime = Date.now();
  durationInterval = setInterval(updateDuration, 1000);

  // Send thumbnails every 2 seconds
  thumbnailInterval = setInterval(sendThumbnail, 2000);
}

function updateDuration() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  $('live-duration').textContent = `${mm}:${ss}`;
}

/* ── Thumbnail Generation ─────────────────────────────────────────────── */
const thumbCanvas = document.createElement('canvas');
const thumbCtx = thumbCanvas.getContext('2d');

function sendThumbnail() {
  if (!localStream || !streamId) return;
  const video = $('preview-video');
  if (!video || !video.videoWidth) return;

  thumbCanvas.width = 320;
  thumbCanvas.height = 180;
  thumbCtx.drawImage(video, 0, 0, 320, 180);
  const data = thumbCanvas.toDataURL('image/jpeg', 0.7);
  send({ type: 'thumbnail', data });
}

/* ── Stop Stream ─────────────────────────────────────────────────────── */
$('btn-stop-stream').addEventListener('click', stopStream);

function stopStream() {
  clearInterval(durationInterval);
  clearInterval(thumbnailInterval);

  // Close all peer connections
  peerConnections.forEach(pc => pc.close());
  peerConnections.clear();

  // Stop local tracks
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;

  send({ type: 'stop_stream' });

  // Close this tab / reset UI
  window.close();
  // Fallback if window.close() is blocked:
  $('live-view').classList.add('hidden');
  $('setup-view').classList.remove('hidden');
  viewerCount = 0;
  streamId = null;
}

/* ── WebRTC: Broadcaster side ─────────────────────────────────────────── */
async function handleViewerJoined(viewerId, viewerName, sid) {
  debugLog(`> Viewer ${viewerName} solicitou entrada!`);
  try {
    const PCConstructor = typeof RTCPeerConnection === 'function' ? RTCPeerConnection 
                        : (window.webkitRTCPeerConnection || window.mozRTCPeerConnection);
    if (!PCConstructor) {
      throw new Error("Construtor WebRTC indisponível!");
    }
    const pc = new PCConstructor({ iceServers: ICE_SERVERS });
    peerConnections.set(viewerId, pc);

    // Add all local tracks to this peer connection
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        send({
          type: 'webrtc_ice',
          streamId: sid,
          candidate: e.candidate,
          viewerId,
          target: 'viewer',
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        handleViewerLeft(viewerId);
      }
    };

    debugLog(`Criando offer para ${viewerName}...`);
    const offer = await pc.createOffer();
    debugLog(`setLocalDescription...`);
    await pc.setLocalDescription(offer);
    debugLog(`Enviando webrtc_offer...`);
    send({
      type: 'webrtc_offer',
      streamId: sid,
      offer,
      viewerId,
    });
  } catch (err) {
    debugLog(`ERRO ao lidar com viewer: ${err.message}`);
    console.error('Error handling viewer joined', viewerId, err);
  }
}

async function handleAnswer(viewerId, answer, sid) {
  const pc = peerConnections.get(viewerId);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error('Error setting remote description:', err);
  }
}

async function handleRemoteIce(viewerId, candidate, sid) {
  const pc = peerConnections.get(viewerId);
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch { /* ignore */ }
}

function handleViewerLeft(viewerId) {
  const pc = peerConnections.get(viewerId);
  if (pc) {
    pc.close();
    peerConnections.delete(viewerId);
  }
}

/* ── Utilities ────────────────────────────────────────────────────────── */
function showSetupError(msg) {
  const el = $('setup-error');
  el.textContent = msg;
  el.classList.add('visible');
}
function hideSetupError() {
  $('setup-error').classList.remove('visible');
}
