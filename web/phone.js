// Phone capture page.
// Probes camera capabilities, opens a WebRTC connection to the local server via WHIP,
// sends video-only, and exposes bitrate/resolution/codec controls.

const $ = (id) => document.getElementById(id);
const preview = $('preview');
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const resSel = $('resSel');
const fpsSel = $('fpsSel');
const brRange = $('brRange');
const brLabel = $('brLabel');
const codecSel = $('codecSel');
const presetSel = $('presetSel');
const hintSel = $('hintSel');
const camSel = $('camSel');
const orientSel = $('orientSel');
const streamNameInput = $('streamName');
const statsEl = $('stats');
const msgEl = $('msg');
const gridEl = $('grid');
const previewStage = document.querySelector('.preview-stage');
const gridToggle = $('gridToggle');
const abrCheck = $('abrCheck');
const torchCheck = $('torchCheck');
const zoomRange = $('zoomRange');
const zoomLabel = $('zoomLabel');
const expRange = $('expRange');
const expLabel = $('expLabel');

// Grid overlay is preview-only. Persist user preference.
(function initGrid() {
  const saved = localStorage.getItem('pwvd.grid');
  if (saved === 'off') gridEl.classList.add('off');
  gridToggle.addEventListener('click', () => {
    gridEl.classList.toggle('off');
    localStorage.setItem('pwvd.grid', gridEl.classList.contains('off') ? 'off' : 'on');
  });
})();

function setMsg(t, isErr = false) {
  msgEl.style.color = isErr ? '#e15454' : '#6ee17c';
  msgEl.textContent = t || '';
}

function updateBrLabel() {
  brLabel.textContent = `${(brRange.value / 1000).toFixed(1)} Mbps`;
}
brRange.addEventListener('input', updateBrLabel);

let cfg = null;
let stream = null;
let pc = null;
let sessionUrl = null;
let statsTimer = null;
let card_bitrateTimer = null;
let card_bitrateTarget = 0;
let autoReconnect = false;
let reconnectTimer = null;
let wakeLockSentinel = null;
let abrEnabled = false;
let configuredBitrate = 0;
let minBitrate = 0;

async function loadConfig() {
  const r = await fetch('/api/config');
  cfg = await r.json();
  codecSel.value = cfg.defaultCodec || 'h264';
  // Unique stream name per phone (persisted). Allows multiple phones at once.
  let name = localStorage.getItem('pwvd.streamName');
  if (!name) {
    name = 'cam-' + Math.random().toString(36).slice(2, 7);
    localStorage.setItem('pwvd.streamName', name);
  }
  streamNameInput.value = name;
  streamNameInput.addEventListener('change', () => {
    const v = (streamNameInput.value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'cam';
    streamNameInput.value = v;
    localStorage.setItem('pwvd.streamName', v);
  });
  sayHello();
}

function currentStreamName() {
  return (streamNameInput?.value || cfg?.streamName || 'live').trim() || 'live';
}

// Announce ourselves to the server with enriched device info (model via UA-CH).
async function sayHello() {
  let uaData = null;
  try {
    const d = navigator.userAgentData;
    if (d?.getHighEntropyValues) {
      uaData = await d.getHighEntropyValues([
        'architecture', 'model', 'platform', 'platformVersion', 'fullVersionList'
      ]);
      uaData.mobile = d.mobile;
      uaData.brands = d.brands;
    }
  } catch { /* ignore */ }
  try {
    await fetch('/api/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uaData, path: cfg?.streamName || 'live' })
    });
  } catch { /* ignore */ }
}

// ---- enumerate cameras and populate the selector ---------------------------
async function enumerateCameras(preferredId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  camSel.innerHTML = '';
  // Always offer the logical 'environment' / 'user' choices first.
  const envOpt = document.createElement('option');
  envOpt.value = 'env'; envOpt.textContent = 'Traseira (environment)';
  camSel.appendChild(envOpt);
  const userOpt = document.createElement('option');
  userOpt.value = 'user'; userOpt.textContent = 'Frontal (user)';
  camSel.appendChild(userOpt);
  if (cams.length) {
    const sep = document.createElement('option');
    sep.disabled = true; sep.textContent = '──────────';
    camSel.appendChild(sep);
    cams.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label || `Câmera ${i + 1}`;
      camSel.appendChild(o);
    });
  }
  if (preferredId && [...camSel.options].some(o => o.value === preferredId)) {
    camSel.value = preferredId;
  } else {
    camSel.value = 'env';
  }
}

function buildVideoConstraints({ width, height, frameRate } = {}) {
  const sel = camSel?.value || 'env';
  const v = {};
  if (sel === 'env')      v.facingMode = { ideal: 'environment' };
  else if (sel === 'user') v.facingMode = { ideal: 'user' };
  else                     v.deviceId  = { exact: sel };
  // Resolutions in the select are landscape pairs (e.g. 1920x1080).
  // If the phone is in portrait, swap so the aspect ratio matches the sensor orientation
  // and the browser doesn't crop/distort to a square.
  if (width && height) {
    const portrait = (window.screen?.orientation?.type || '').startsWith('portrait')
      || window.innerHeight > window.innerWidth;
    const longEdge  = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    const W = portrait ? shortEdge : longEdge;
    const H = portrait ? longEdge  : shortEdge;
    v.width       = { ideal: W };
    v.height      = { ideal: H };
  }
  if (frameRate) v.frameRate = { ideal: frameRate, max: frameRate };
  return v;
}

// ---- preview-only rotation / mirror (does NOT affect outgoing track) ------
function applyOrientation() {
  const v = orientSel?.value || '0';
  let t = '';
  if (v === 'mirror') t = 'scaleX(-1)';
  else if (v === '90' || v === '180' || v === '270') t = `rotate(${v}deg)`;
  if (preview) preview.style.transform = t;
}

// ---- capability probe: open a permissive stream, read capabilities, then close -----
// On iOS Safari, getUserMedia requires a user gesture. When called without one
// (e.g. during page init), it throws NotAllowedError.  In that case we fall back
// to a sensible default list so the UI is still usable.
async function probeCapabilities() {
  let caps = {}, settings = {};
  try {
    const probe = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: buildVideoConstraints()
    });
    const track = probe.getVideoTracks()[0];
    caps = (typeof track.getCapabilities === 'function') ? track.getCapabilities() : {};
    settings = (typeof track.getSettings === 'function') ? track.getSettings() : {};
    probe.getTracks().forEach(t => t.stop());
  } catch (e) {
    // iOS Safari blocks getUserMedia without user gesture – use defaults
    console.warn('[pwvd] probeCapabilities failed (expected on iOS first load):', e.name);
  }

  // Capabilities.width/height represent the SHORT and LONG edges of the sensor.
  // Use the long edge so portrait mode still offers 1080p/4K.
  const rawMaxW = caps.width?.max || settings.width || 1920;
  const rawMaxH = caps.height?.max || settings.height || 1080;
  const maxLong  = Math.max(rawMaxW, rawMaxH);
  const maxShort = Math.min(rawMaxW, rawMaxH) || Math.round(maxLong * 9 / 16);
  // Express profiles in landscape form (long×short); buildVideoConstraints swaps for portrait.
  const maxW = maxLong;
  const maxH = maxShort;
  const maxF = Math.round(caps.frameRate?.max || settings.frameRate || 30);

  // Build resolution list (capped at the reported max).
  const profiles = [
    [3840, 2160, '4K'], [2560, 1440, '1440p'], [1920, 1080, '1080p'],
    [1280, 720, '720p'], [854, 480, '480p'],
  ].filter(([w, h]) => w <= maxW && h <= maxH);
  if (profiles.length === 0) profiles.push([maxW, maxH, `${maxH}p`]);

  resSel.innerHTML = '';
  for (const [w, h, label] of profiles) {
    const o = document.createElement('option');
    o.value = `${w}x${h}`;
    o.textContent = `${label} (${w}×${h})`;
    resSel.appendChild(o);
  }
  resSel.value = resSel.options[0].value;

  // fps list
  const fpsCandidates = [120, 90, 60, 50, 30, 25, 24].filter(f => f <= maxF);
  if (!fpsCandidates.length) fpsCandidates.push(maxF);
  fpsSel.innerHTML = '';
  for (const f of fpsCandidates) {
    const o = document.createElement('option');
    o.value = String(f);
    o.textContent = `${f} fps`;
    fpsSel.appendChild(o);
  }
  fpsSel.value = String(Math.min(60, fpsCandidates[0]));

  updateBrLabel();
  return { maxW, maxH, maxF };
}

// ---- codec preference via SDP mangling -------------------------------------
function preferCodec(sdp, codec) {
  const mimes = {
    h264: 'H264',
    vp9:  'VP9',
    av1:  'AV1',
    vp8:  'VP8',
  };
  const wanted = mimes[codec] || 'H264';
  const lines = sdp.split('\r\n');
  const mIdx = lines.findIndex(l => l.startsWith('m=video '));
  if (mIdx < 0) return sdp;
  const pts = [];
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+)\s+([^/]+)\//);
    if (m && m[2].toUpperCase() === wanted) pts.push(m[1]);
  }
  if (!pts.length) return sdp;
  const parts = lines[mIdx].split(' ');
  const head = parts.slice(0, 3);
  const existing = parts.slice(3);
  const reordered = [...pts, ...existing.filter(p => !pts.includes(p))];
  lines[mIdx] = [...head, ...reordered].join(' ');
  return lines.join('\r\n');
}

// ---- WHIP handshake --------------------------------------------------------
async function whipPublish(offer) {
  const whipUrl = `/whip/${encodeURIComponent(currentStreamName())}`;
  const r = await fetch(whipUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offer.sdp,
  });
  if (!r.ok) throw new Error(`WHIP failed: ${r.status} ${await r.text()}`);
  sessionUrl = r.headers.get('Location');
  return await r.text();
}

async function whipUnpublish() {
  if (!sessionUrl) return;
  try { await fetch(sessionUrl, { method: 'DELETE' }); } catch { /* ignore */ }
  sessionUrl = null;
}

// ---- wake lock (keeps screen on during streaming) --------------------------
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
  } catch { /* not supported or denied */ }
}
function releaseWakeLock() {
  if (wakeLockSentinel) { try { wakeLockSentinel.release(); } catch {} wakeLockSentinel = null; }
}
// Browser releases wake lock when tab is hidden; re-acquire when visible again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && autoReconnect && stream) acquireWakeLock();
});

// ---- main start / stop -----------------------------------------------------
async function start() {
  try {
    startBtn.disabled = true;
    autoReconnect = false;
    setMsg('Solicitando câmera…');

    // On iOS Safari the initial probe (page load) may have failed because
    // getUserMedia requires a user gesture. Now we ARE inside a gesture, so
    // re-probe to get real capabilities and repopulate selectors.
    if (resSel.options.length <= 1) {
      await probeCapabilities();
      await enumerateCameras(camSel.value);
    }

    const [w, h] = resSel.value.split('x').map(Number);
    const fps = parseInt(fpsSel.value, 10);

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: buildVideoConstraints({ width: w, height: h, frameRate: fps })
    });
    preview.srcObject = stream;
    applyOrientation();

    const track = stream.getVideoTracks()[0];
    // contentHint not available on Safari
    if ('contentHint' in track) track.contentHint = hintSel.value;
    const st = (typeof track.getSettings === 'function') ? track.getSettings() : {};
    if (st.width && st.height) {
      setMsg(`Câmera: ${st.width}×${st.height} @ ${Math.round(st.frameRate||0)}fps`);
    }
    setupCameraControls(track);

    autoReconnect = true;
    saveSettings();
    await connect();
    await acquireWakeLock();
  } catch (e) {
    console.error(e);
    const errMsg = e.stack || e.message || String(e);
    setMsg(errMsg, true);
    const dbg = document.getElementById('dbg');
    if (dbg) dbg.textContent += 'START-ERR: ' + errMsg + '\n';
    autoReconnect = false;
    // Don't call stop() here — it overwrites the error message.
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    preview.srcObject = null;
    startBtn.disabled = false;
  }
}

// Creates a new WebRTC PeerConnection and WHIP session, re-using the existing camera stream.
async function connect() {
  const dbg = document.getElementById('dbg');
  const log = (s) => { if (dbg) dbg.textContent += s + '\n'; };
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') throw new Error('Câmera indisponível');
  log('connect: track OK (' + track.readyState + ')');

  const fps = parseInt(fpsSel.value, 10);
  const bitrate = parseInt(brRange.value, 10) * 1000;
  const codec = codecSel.value;
  const preset = presetSel.value;

  pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  log('connect: pc created');

  // Detect connection loss → auto-reconnect (keeps camera alive).
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === 'disconnected' || st === 'failed') {
      if (autoReconnect) {
        setMsg('Conexão perdida. Reconectando…', true);
        scheduleReconnect();
      } else {
        setMsg('Desconectado.', true);
      }
    }
  };

  const sender = pc.addTransceiver(track, { direction: 'sendonly' }).sender;
  log('connect: transceiver added');

  // Tune encoding for maximum quality on LAN.
  const p = sender.getParameters();
  const degradation = {
    balanced: 'balanced',
    fps:     'maintain-framerate',
    res:     'maintain-resolution',
    low:     'maintain-framerate',
  }[preset] || 'balanced';
  // degradationPreference not supported on Safari — guard it
  try { p.degradationPreference = degradation; } catch {}
  p.encodings = [{
    maxBitrate: bitrate,
    maxFramerate: fps,
    priority: 'high',
    networkPriority: 'high',
  }];
  try {
    await sender.setParameters(p);
    log('connect: params set');
  } catch (e) {
    log('connect: setParameters failed: ' + e.message);
    // Safari may reject some params — continue anyway
  }

  const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
  log('connect: offer created');
  let sdp = preferCodec(offer.sdp, codec);
  sdp = sdp.replace(/^b=(AS|TIAS):.*\r?\n/gm, '');
  offer.sdp = sdp;
  await pc.setLocalDescription(offer);
  log('connect: local desc set');

  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); } };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 1500);
  });
  log('connect: ICE gathered');

  setMsg('Conectando ao servidor…');
  log('connect: WHIP publish…');
  const answerSdp = await whipPublish(pc.localDescription);
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  setMsg('Transmitindo.');
  stopBtn.disabled = false;
  startStats();

  card_bitrateTarget = bitrate;
  configuredBitrate = bitrate;
  minBitrate = Math.round(bitrate * 0.70);
  abrEnabled = abrCheck.checked;
  card_bitrateTimer = setInterval(async () => {
    if (!pc || pc.connectionState === 'closed') return;
    try {
      const senders = pc.getSenders().filter(s => s.track?.kind === 'video');
      for (const s of senders) {
        const p = s.getParameters();
        if (p.encodings?.[0]) {
          if (abrEnabled) {
            // ABR: let browser reduce but keep floor at 70% of configured
            const cur = p.encodings[0].maxBitrate || card_bitrateTarget;
            // Re-apply target so browser can negotiate up/down within bounds
            p.encodings[0].maxBitrate = card_bitrateTarget;
          } else {
            p.encodings[0].maxBitrate = card_bitrateTarget;
          }
          await s.setParameters(p);
        }
      }
    } catch { /* ignore */ }
  }, 2000);
}

// Tear down WebRTC + WHIP but keep the camera stream alive for reconnect.
function cleanup() {
  stopStats();
  if (card_bitrateTimer) { clearInterval(card_bitrateTimer); card_bitrateTimer = null; }
  if (pc) { try { pc.close(); } catch {} pc = null; }
  whipUnpublish();
}

function scheduleReconnect() {
  cleanup();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!autoReconnect || !stream) return;
    try {
      await connect();
    } catch (e) {
      console.warn('[pwvd] reconnect failed:', e);
      setMsg('Falha ao reconectar. Tentando…', true);
      if (autoReconnect) scheduleReconnect();
    }
  }, 2000);
}

async function stop() {
  autoReconnect = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopBtn.disabled = true;
  cleanup();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  preview.srcObject = null;
  releaseWakeLock();
  torchCheck.disabled = true; torchCheck.checked = false;
  zoomRange.disabled = true; zoomLabel.textContent = '1.0x';
  expRange.disabled = true; expLabel.textContent = 'Auto';
  startBtn.disabled = false;
  setMsg('Parado.');
}

startBtn.addEventListener('click', () => {
  start().catch(e => {
    const dbg = document.getElementById('dbg');
    if (dbg) dbg.textContent += 'START-ERR: ' + (e.stack || e.message || e) + '\n';
  });
});
stopBtn.addEventListener('click', stop);

// ---- stats -----------------------------------------------------------------
function startStats() {
  let last = null;
  statsTimer = setInterval(async () => {
    if (!pc) return;
    const report = await pc.getStats();
    let out = null, cand = null;
    report.forEach(s => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
      if (s.type === 'candidate-pair' && s.state === 'succeeded') cand = s;
    });
    if (!out) return;
    const kbps = last ? Math.round((out.bytesSent - last.bytesSent) * 8 / 1000) : 0;
    const mbps = (kbps / 1000).toFixed(1);
    const fps  = out.framesPerSecond ?? 0;
    const rtt  = cand?.currentRoundTripTime ? Math.round(cand.currentRoundTripTime * 1000) : '—';
    const res  = `${out.frameWidth ?? '?'}x${out.frameHeight ?? '?'}`;
    const encMs = out.framesEncoded ? Math.round((out.totalEncodeTime/out.framesEncoded)*1000) : '—';
    const sent = (out.bytesSent / (1024*1024)).toFixed(1);
    const qual = out.qualityLimitationReason || '—';
    const codecUsed = (codecSel.value || 'h264').toUpperCase();
    const abrTag = abrCheck.checked ? ' ABR' : '';
    statsEl.textContent =
      `${mbps} Mbps (${kbps} kbps)   ${fps} fps   ${res}\n` +
      `rtt ${rtt}ms   encode ${encMs}ms/f   ${codecUsed}${abrTag}\n` +
      `limit: ${qual}   enviado: ${sent} MB   keyframes: ${out.keyFramesEncoded ?? '—'}`;
    last = out;
  }, 1000);
}
function stopStats() { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } statsEl.textContent = ''; }

// ---- settings persistence --------------------------------------------------
const SETTINGS_KEY = 'pwvd.settings';
function saveSettings() {
  const s = {
    codec: codecSel.value, preset: presetSel.value, hint: hintSel.value,
    bitrate: brRange.value, abr: abrCheck.checked, orient: orientSel.value,
    cam: camSel.value,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (s.codec) codecSel.value = s.codec;
    if (s.preset) presetSel.value = s.preset;
    if (s.hint) hintSel.value = s.hint;
    if (s.bitrate) brRange.value = s.bitrate;
    if (s.abr != null) abrCheck.checked = s.abr;
    if (s.orient) orientSel.value = s.orient;
    updateBrLabel();
  } catch {}
}
// Save on any change.
for (const el of [codecSel, presetSel, hintSel, orientSel, camSel, abrCheck]) {
  el.addEventListener('change', saveSettings);
}
brRange.addEventListener('input', saveSettings);

// ---- camera hardware controls (torch, zoom, exposure) ----------------------
// Safari does not support getCapabilities() or applyConstraints({advanced}).
// All control setup is guarded so iOS doesn't crash.
function setupCameraControls(track) {
  const caps = (typeof track.getCapabilities === 'function') ? track.getCapabilities() : {};
  // Torch
  if (caps.torch) {
    torchCheck.disabled = false;
    torchCheck.addEventListener('change', () => {
      try { track.applyConstraints({ advanced: [{ torch: torchCheck.checked }] }); } catch {}
    });
  } else {
    torchCheck.disabled = true; torchCheck.checked = false;
  }
  // Zoom
  if (caps.zoom) {
    zoomRange.disabled = false;
    zoomRange.min = Math.round(caps.zoom.min * 100);
    zoomRange.max = Math.round(caps.zoom.max * 100);
    zoomRange.step = Math.round(caps.zoom.step * 100) || 10;
    const curZoom = (typeof track.getSettings === 'function') ? (track.getSettings().zoom || caps.zoom.min) : caps.zoom.min;
    zoomRange.value = Math.round(curZoom * 100);
    zoomLabel.textContent = `${(zoomRange.value / 100).toFixed(1)}x`;
    zoomRange.addEventListener('input', () => {
      const z = zoomRange.value / 100;
      zoomLabel.textContent = `${z.toFixed(1)}x`;
      try { track.applyConstraints({ advanced: [{ zoom: z }] }); } catch {}
    });
  } else {
    zoomRange.disabled = true; zoomLabel.textContent = 'N/A';
  }
  // Exposure compensation
  if (caps.exposureCompensation) {
    expRange.disabled = false;
    const min = caps.exposureCompensation.min;
    const max = caps.exposureCompensation.max;
    expRange.min = Math.round(min * 10);
    expRange.max = Math.round(max * 10);
    expRange.step = Math.round((caps.exposureCompensation.step || 0.1) * 10) || 1;
    const curExp = (typeof track.getSettings === 'function') ? (track.getSettings().exposureCompensation || 0) : 0;
    expRange.value = Math.round(curExp * 10);
    const updateExpLabel = () => {
      const v = expRange.value / 10;
      expLabel.textContent = v === 0 ? 'Auto' : (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
    };
    updateExpLabel();
    expRange.addEventListener('input', () => {
      updateExpLabel();
      try { track.applyConstraints({ advanced: [{ exposureCompensation: expRange.value / 10 }] }); } catch {}
    });
  } else {
    expRange.disabled = true; expLabel.textContent = 'N/A';
  }
}

// ---- init ------------------------------------------------------------------
(async () => {
  const dbg = document.getElementById('dbg');
  const log = (s) => { if (dbg) dbg.textContent += s + '\n'; };
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    setMsg('Este navegador não suporta WebRTC / getUserMedia.', true);
    startBtn.disabled = true; return;
  }
  if (!window.isSecureContext) {
    setMsg('Abra via HTTPS para liberar a câmera.', true);
    startBtn.disabled = true; return;
  }
  try {
    log('init: loadConfig…');
    await loadConfig();
    loadSettings();
    log('init: enumerate…');
    await enumerateCameras();
    log('init: probe…');
    await probeCapabilities();
    await enumerateCameras(camSel.value);
    applyOrientation();
    log('init: OK');
    setMsg('Pronto. Toque em "Iniciar captura".');
  } catch (e) {
    console.warn('[pwvd] init error (non-fatal):', e);
    log('init-err: ' + (e.stack || e.message || e));
    setMsg('Pronto. Toque em "Iniciar captura".');
  }
})();

// React to camera/orientation changes.
orientSel?.addEventListener('change', applyOrientation);
camSel?.addEventListener('change', async () => {
  // If transmitting, swap the source track live.
  if (pc && stream) {
    try {
      const [w, h] = resSel.value.split('x').map(Number);
      const fps = parseInt(fpsSel.value, 10);
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: buildVideoConstraints({ width: w, height: h, frameRate: fps })
      });
      const newTrack = newStream.getVideoTracks()[0];
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      stream.getTracks().forEach(t => t.stop());
      stream = newStream;
      preview.srcObject = stream;
      applyOrientation();
      setMsg('Câmera trocada.');
    } catch (e) { setMsg(e.message || String(e), true); }
  } else {
    // Not running yet: just re-probe so resolution list reflects the new camera.
    try { await probeCapabilities(); } catch {}
  }
});
