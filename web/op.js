// Operator dashboard.
// Real-time via Server-Sent Events (SSE) with polling fallback.
// One card per publisher, with its own WHEP preview + live RTP stats + OBS URLs.

const $ = (id) => document.getElementById(id);
let cfg = null;
let authToken = '';

function authHeaders() {
  const h = {};
  if (authToken) h['Authorization'] = `Bearer ${authToken}`;
  return h;
}

// -------------------- login --------------------
async function checkAuth() {
  cfg = await (await fetch('/api/config')).json();
  if (!cfg.authRequired) return true;
  // Try sessionStorage first
  const saved = sessionStorage.getItem('pwvd.token');
  if (saved) {
    authToken = saved;
    const r = await fetch('/api/status', { headers: authHeaders() });
    if (r.ok) return true;
    sessionStorage.removeItem('pwvd.token');
    authToken = '';
  }
  return showLogin();
}

function showLogin() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'login-overlay';
    overlay.innerHTML = `
      <form class="login-form" autocomplete="off">
        <h2>PWVD — Operador</h2>
        <label>Senha do painel<input type="password" id="loginPass" autofocus /></label>
        <button type="submit">Entrar</button>
        <p id="loginErr" style="color:#e15454;display:none"></p>
      </form>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = document.getElementById('loginPass').value;
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass }),
      });
      const j = await r.json();
      if (j.ok) {
        authToken = j.token;
        sessionStorage.setItem('pwvd.token', authToken);
        overlay.remove();
        resolve(true);
      } else {
        const err = document.getElementById('loginErr');
        err.textContent = j.error || 'Senha incorreta';
        err.style.display = '';
      }
    });
  });
}

// -------------------- boot --------------------
async function init() {
  await checkAuth();
  $('lan').textContent =
    `LAN: ${cfg.lan.ip}:${cfg.lan.port}  •  CPU budget: ${cfg.maxCpuPercent}%`;

  // Phone share block
  $('phoneUrl').textContent = cfg.phoneUrl;
  $('phoneOpen').href       = cfg.phoneUrl;
  $('qrImg').src            = `/api/qr?text=${encodeURIComponent(cfg.phoneUrl)}`;
  $('shareBtn').addEventListener('click', async () => {
    const payload = { title: 'PWVD', text: 'Abrir captura no celular:', url: cfg.phoneUrl };
    if (navigator.share) {
      try { await navigator.share(payload); } catch { /* cancelled */ }
    } else {
      try { await navigator.clipboard.writeText(cfg.phoneUrl); alert('Link copiado.'); }
      catch { prompt('Copie o link:', cfg.phoneUrl); }
    }
  });
  document.querySelectorAll('button[data-copy]').forEach(b => {
    b.addEventListener('click', async () => {
      const el = document.getElementById(b.dataset.copy);
      const text = el.textContent;
      try { await navigator.clipboard.writeText(text); flash(b, 'Copiado'); }
      catch {}
    });
  });

  ensureServerGrid();
  connectLive();
}

function flash(btn, msg) {
  const t = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = t; }, 1200);
}

// -------------------- live status (SSE) --------------------
let esReconnectTimer = null;
function connectLive() {
  let es;
  const url = authToken ? `/api/status/stream?auth=${encodeURIComponent(authToken)}` : '/api/status/stream';
  try { es = new EventSource(url); }
  catch { return startPolling(); }

  es.onmessage = (ev) => {
    $('liveDot').classList.remove('off');
    try { applyStatus(JSON.parse(ev.data)); } catch {}
  };
  es.onerror = () => {
    $('liveDot').classList.add('off');
    es.close();
    clearTimeout(esReconnectTimer);
    esReconnectTimer = setTimeout(connectLive, 1500);
  };
}
function startPolling() {
  const poll = async () => {
    try {
      const r = await fetch('/api/status', { headers: authHeaders() });
      if (r.ok) { applyStatus(await r.json()); $('liveDot').classList.remove('off'); }
    } catch { $('liveDot').classList.add('off'); }
  };
  poll(); setInterval(poll, 1000);
}

// -------------------- server tiles --------------------
const serverCells = {};
function ensureServerGrid() {
  const grid = $('serverGrid');
  if (!grid || grid.childElementCount) return;
  const defs = [
    ['cpu', 'CPU', '%'], ['mem', 'Memória', 'MB'], ['uptime', 'Uptime', ''],
    ['publishers', 'Publicadores', ''], ['readers', 'Leitores WHEP', ''], ['rtsp', 'Leitores RTSP', ''],
  ];
  for (const [k, label, unit] of defs) {
    const el = document.createElement('div'); el.className = 'stat';
    el.innerHTML = `<div class="k">${label}</div><div class="v">—${unit ? ' ' + unit : ''}</div>`;
    grid.appendChild(el);
    serverCells[k] = { unit, v: el.querySelector('.v') };
  }
}
function setCell(k, val) {
  const c = serverCells[k]; if (!c) return;
  c.v.textContent = c.unit ? `${val} ${c.unit}` : String(val);
}

// -------------------- status -> UI --------------------
function applyStatus(s) {
  setCell('cpu',        `${s.server.cpuPercent} / ${s.server.cpuBudget}`);
  setCell('mem',        `${s.server.mem.usedMB} / ${s.server.mem.totalMB}`);
  setCell('uptime',     fmtUptime(s.server.uptimeSec));
  setCell('publishers', s.publishers.length);
  setCell('readers',    s.readers.length);
  setCell('rtsp',       s.rtsp.length);

  renderPublishers(s);
  renderViewers(s);
}

// -------------------- publishers (transmitindo) --------------------
const publisherCards = new Map(); // name -> card

function renderPublishers(s) {
  const list = $('publishersList');
  const byName = new Map();
  for (const p of (s.publishers || [])) {
    if (!p.path) continue;
    byName.set(p.path, p);
  }

  $('pubCount').textContent = byName.size;

  if (!byName.size) {
    for (const [, c] of publisherCards) teardownCard(c);
    publisherCards.clear();
    list.innerHTML = '<p class="empty">Nenhum celular transmitindo agora.</p>';
    return;
  }

  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  for (const name of [...publisherCards.keys()]) {
    if (!byName.has(name)) {
      const c = publisherCards.get(name);
      teardownCard(c);
      c.root.remove();
      publisherCards.delete(name);
    }
  }

  for (const [name, pub] of byName) {
    let card = publisherCards.get(name);
    if (!card) {
      card = createPublisherCard(name);
      publisherCards.set(name, card);
      list.appendChild(card.root);
      // Preview fica DESLIGADO por padrão. Usuário liga clicando no botão.
      // Isso evita baixar/decodificar o stream principal quando ninguém está olhando.
    }
    const pathInfo = (s.paths || []).find(p => p.name === name);
    updateCardMeta(card, pub, pathInfo);
  }
}

function createPublisherCard(name) {
  const host  = cfg?.lan?.ip || location.hostname;
  const port  = cfg?.lan?.port || location.port;
  const whep  = `https://${host}:${port}/whep/${name}`;
  const whepL = `http://localhost:8889/${name}/whep`;
  const rtsp  = `rtsp://${host}:8554/${name}`;
  const rtspL = `rtsp://localhost:8554/${name}`;
  const obsUrl = `https://localhost:${port}/obs.html?stream=${encodeURIComponent(name)}`;

  const root = document.createElement('div');
  root.className = 'pub-card';
  root.innerHTML = `
    <div class="pub-header">
      <strong>${escapeHtml(name)}</strong>
      <span class="badge pub">ao vivo</span>
      <button class="preview-toggle" data-role="toggle">Ver preview</button>
      <button class="kick-btn" data-role="kick" title="Derrubar este celular">Parar</button>
    </div>
    <div class="preview-slot" data-role="slot">
      <div class="preview-off">Preview desligado (economia de banda/CPU)</div>
    </div>
    <div class="pub-body">
      <div class="pub-meta" data-role="meta">—</div>
      <div class="url obs-url"><code>${escapeHtml(obsUrl)}</code><button data-copy-val="${escapeHtml(obsUrl)}">OBS Browser (WHEP)</button></div>
      <div class="url"><code>${escapeHtml(rtspL)}</code><button data-copy-val="${escapeHtml(rtspL)}">RTSP (local)</button></div>
      <div class="url"><code>${escapeHtml(rtsp)}</code><button data-copy-val="${escapeHtml(rtsp)}">RTSP (LAN)</button></div>
      <div class="url"><code>${escapeHtml(whepL)}</code><button data-copy-val="${escapeHtml(whepL)}">WHEP (local)</button></div>
      <div class="url"><code>${escapeHtml(whep)}</code><button data-copy-val="${escapeHtml(whep)}">WHEP (LAN)</button></div>
      <div class="pub-server-stats" data-role="server-stats">
        <span>bitrate <b>—</b></span><span>codec <b>—</b></span><span>tracks <b>—</b></span>
        <span>leitores <b>—</b></span><span>trafego <b>—</b></span><span>tempo <b>—</b></span>
      </div>
      <div class="pub-stats" data-role="stats" style="display:none">
        <span>prev.bitrate <b>—</b></span><span>fps <b>—</b></span><span>res <b>—</b></span>
        <span>rtt <b>—</b> ms</span><span>jitter <b>—</b> ms</span><span>perda <b>—</b> %</span>
      </div>
    </div>`;
  root.querySelectorAll('button[data-copy-val]').forEach(b => {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copyVal); flash(b, 'Copiado'); } catch {}
    });
  });
  const card = {
    root,
    name,
    slot:   root.querySelector('[data-role="slot"]'),
    toggle: root.querySelector('[data-role="toggle"]'),
    meta:   root.querySelector('[data-role="meta"]'),
    stats:  root.querySelector('[data-role="stats"]'),
    video:  null,
    pc: null, interval: null, previewOn: false,
  };
  card.toggle.addEventListener('click', () => togglePreview(card));
  root.querySelector('[data-role="kick"]').addEventListener('click', () => kickPublisher(card));
  return card;
}

async function kickPublisher(card) {
  if (!confirm(`Derrubar a transmissão de "${card.name}"?`)) return;
  const btn = card.root.querySelector('[data-role="kick"]');
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await fetch('/api/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ path: card.name }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'falhou');
    btn.textContent = 'Derrubado';
  } catch (e) {
    alert('Erro ao derrubar: ' + e.message);
    btn.disabled = false; btn.textContent = 'Parar';
  }
}

function togglePreview(card) {
  if (card.previewOn) {
    teardownCard(card);
    card.slot.innerHTML = '<div class="preview-off">Preview desligado (economia de banda/CPU)</div>';
    card.video = null;
    card.previewOn = false;
    card.toggle.textContent = 'Ver preview';
    card.toggle.classList.remove('on');
    card.stats.style.display = 'none';
    card.stats.querySelectorAll('b').forEach(b => b.textContent = '—');
  } else {
    card.slot.innerHTML = '<video autoplay muted playsinline></video>';
    card.video = card.slot.querySelector('video');
    card.previewOn = true;
    card.toggle.textContent = 'Parar preview';
    card.toggle.classList.add('on');
    card.stats.style.display = '';
    startWhep(card, `/whep/${encodeURIComponent(card.name)}`);
  }
}

function updateCardMeta(card, pub, pathInfo) {
  const d = pub.device || {};
  const model = d.uaModel || d.model;
  const os    = d.os ? `${d.os}${d.osVersion ? ' ' + d.osVersion : ''}` : '';
  const who   = [model, os].filter(Boolean).join(' · ') || (pub.remoteAddr || '—');
  const traf  = `↑ ${fmtBytes(pub.bytesReceived)}`;
  card.meta.textContent = `${who}   •   ${pub.remoteAddr || '—'}   •   ${traf}   •   há ${fmtAgo(pub.created)}`;

  // Server-side stats (always visible, no preview needed)
  if (pathInfo) {
    const ss = card.root.querySelector('[data-role="server-stats"]');
    if (ss) {
      const bs = ss.querySelectorAll('b');
      // Bitrate from MediaMTX (bytes received on the path)
      const prev = card._prevPathBytes || 0;
      const prevT = card._prevPathTime || 0;
      const now = Date.now();
      const bytes = pathInfo.bytesReceived || 0;
      let kbps = '—';
      if (prev > 0 && now > prevT) {
        kbps = Math.round((bytes - prev) * 8 / ((now - prevT)) ) + ' kbps';
      }
      card._prevPathBytes = bytes;
      card._prevPathTime = now;
      // Tracks / codec
      const tracks = pathInfo.tracks || [];
      const codecs = tracks.map(t => t.codec || '?').join('+');
      bs[0].textContent = kbps;
      bs[1].textContent = codecs || '—';
      bs[2].textContent = tracks.length;
      bs[3].textContent = pathInfo.readers ?? '—';
      bs[4].textContent = fmtBytes(bytes);
      bs[5].textContent = fmtAgo(pub.created);
    }
  }
}

function teardownCard(card) {
  try { card.pc?.close(); } catch {}
  if (card.interval) clearInterval(card.interval);
  card.pc = null; card.interval = null;
}

async function startWhep(card, whepUrl) {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  card.pc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (ev) => {
    if (!card.video) return;
    card.video.srcObject = ev.streams[0];
    try { ev.receiver.playoutDelayHint = 0; } catch {}
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') resolve();
    });
    setTimeout(resolve, 1200);
  });

  try {
    const r = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!r.ok) { console.warn('WHEP failed:', r.status); return; }
    const answer = await r.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  } catch (e) { console.warn('WHEP error:', e); return; }

  let last = null;
  card.interval = setInterval(async () => {
    if (!card.pc) return;
    const report = await card.pc.getStats();
    let inb = null, cand = null;
    report.forEach(st => {
      if (st.type === 'inbound-rtp' && st.kind === 'video') inb = st;
      if (st.type === 'candidate-pair' && st.state === 'succeeded') cand = st;
    });
    if (!inb) return;
    const kbps = last ? Math.round((inb.bytesReceived - last.bytesReceived) * 8 / 1000) : 0;
    const rtt  = cand?.currentRoundTripTime ? Math.round(cand.currentRoundTripTime * 1000) : '—';
    const jit  = inb.jitter != null ? Math.round(inb.jitter * 1000) : '—';
    const loss = inb.packetsReceived ? ((inb.packetsLost / (inb.packetsLost + inb.packetsReceived)) * 100).toFixed(1) : '0';
    const bs = card.stats.querySelectorAll('b');
    bs[0].textContent = `${kbps} kbps`;
    bs[1].textContent = `${inb.framesPerSecond ?? '—'}`;
    bs[2].textContent = `${inb.frameWidth ?? '—'}×${inb.frameHeight ?? '—'}`;
    bs[3].textContent = rtt;
    bs[4].textContent = jit;
    bs[5].textContent = loss;
    last = inb;
  }, 1000);
}

// -------------------- viewers (no painel, não transmitindo) --------------------
function renderViewers(s) {
  const tbody = document.querySelector('#devicesTable tbody');
  const publisherIps = new Set((s.publishers || []).map(p => (p.remoteAddr || '').split(':')[0]));
  const rows = [];

  for (const r of (s.readers || [])) rows.push({ kind: 'reader', ...r });
  for (const r of (s.rtsp    || [])) rows.push({ kind: 'rtsp',   ...r });
  for (const d of (s.devices || [])) {
    if (publisherIps.has(d.ip)) continue;
    if (rows.some(r => (r.remoteAddr || '').startsWith(d.ip))) continue;
    rows.push({
      kind: d.role === 'reader' || d.role === 'rtsp' ? d.role : 'phone',
      remoteAddr: d.ip,
      created: new Date(d.lastSeen).toISOString(),
      device: {
        os: d.os, osVersion: d.osVersion,
        browser: d.browser, browserVersion: d.browserVersion,
        model: d.uaModel || d.model,
      }
    });
  }

  $('viewerCount').textContent = rows.length;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Aguardando conexões…</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const cls = r.kind === 'reader' ? 'read' : r.kind === 'rtsp' ? 'rtsp' : 'phone';
    const lbl = r.kind === 'reader' ? 'WHEP' : r.kind === 'rtsp' ? 'RTSP' : 'painel';
    return `<tr>
      <td>${escapeHtml(deviceLabel(r.device))}</td>
      <td>${escapeHtml(browserLabel(r.device))}</td>
      <td>${escapeHtml((r.remoteAddr || '').split(':')[0])}</td>
      <td><span class="badge ${cls}">${lbl}</span></td>
      <td>${fmtAgo(r.created)}</td>
    </tr>`;
  }).join('');
}

// -------------------- utils --------------------
function deviceLabel(d) {
  if (!d) return '—';
  const model = d.model;
  const os    = d.os ? `${d.os}${d.osVersion ? ' ' + d.osVersion : ''}` : '';
  if (model && os) return `${model} · ${os}`;
  return model || os || '—';
}
function browserLabel(d) {
  if (!d) return '—';
  return d.browser ? `${d.browser}${d.browserVersion ? ' ' + d.browserVersion.split('.')[0] : ''}` : '—';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${h}h ${m}m ${ss}s`;
}
function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const m = Math.floor(s / 60); return m ? `${m}m ${s % 60}s` : `${s}s`;
}

init().catch(e => { console.error(e); alert(e.message || e); });
