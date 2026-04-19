// PWVD control plane.
// - Serves the phone + operator pages over HTTPS (required by getUserMedia).
// - Proxies WHIP/WHEP to MediaMTX so there's a single host:port for the phone.
// - Prints LAN URLs and a QR code at startup.
// - Exposes /api/config with everything the web UI needs.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { loadEnv } from './env.js';
import { getPrimaryLanIP, getLanIPs } from './net.js';
import { MediaMTX } from './mediamtx.js';
import { getStatus } from './monitor.js';
import { recordDevice, listDevices } from './devices.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const BIND_ADDR      = process.env.BIND_ADDR      || '0.0.0.0';
const HTTPS_PORT     = parseInt(process.env.HTTPS_PORT || '8443', 10);
const WHIP_PORT      = parseInt(process.env.WHIP_PORT  || '8889', 10);
const RTSP_PORT      = parseInt(process.env.RTSP_PORT  || '8554', 10);
const STREAM_NAME    = process.env.STREAM_NAME    || 'live';
const MAX_CPU        = parseInt(process.env.MAX_CPU_PERCENT || '75', 10);
const DEFAULT_CODEC  = process.env.DEFAULT_CODEC  || 'h264';
const TLS_CERT       = resolve(ROOT, process.env.TLS_CERT || './certs/cert.pem');
const TLS_KEY        = resolve(ROOT, process.env.TLS_KEY  || './certs/key.pem');
const MEDIAMTX_PATH  = resolve(ROOT, process.env.MEDIAMTX_PATH   || './bin/mediamtx.exe');
const MEDIAMTX_CONF  = resolve(ROOT, process.env.MEDIAMTX_CONFIG || './media/mediamtx.yml');
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';

// Session auth token — generated fresh on each server start.
const AUTH_TOKEN = PANEL_PASSWORD ? randomBytes(32).toString('hex') : '';
if (PANEL_PASSWORD) console.log('[pwvd] Painel protegido por senha.');

function requireAuth(req, reply, done) {
  if (!PANEL_PASSWORD) return done();
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const qAuth = req.query?.auth;
  if (bearer === AUTH_TOKEN || qAuth === AUTH_TOKEN) return done();
  reply.code(401).send({ error: 'Não autorizado' });
}

// ---- TLS ----
if (!existsSync(TLS_CERT) || !existsSync(TLS_KEY)) {
  console.error('[pwvd] TLS cert or key missing. Run `npm run certs` first.');
  console.error(`[pwvd]   cert: ${TLS_CERT}`);
  console.error(`[pwvd]   key : ${TLS_KEY}`);
  process.exit(1);
}

// ---- Patch MediaMTX config with detected LAN IP ----
// This ensures WebRTC ICE candidates use the correct interface,
// even when switching between Wi-Fi and Ethernet.
{
  const lanIp = getPrimaryLanIP();
  const yml = readFileSync(MEDIAMTX_CONF, 'utf8');
  const patched = yml.replace(
    /^(\s*webrtcAdditionalHosts:\s*)\[.*\]/m,
    `$1[${lanIp}]`
  );
  if (patched !== yml) {
    writeFileSync(MEDIAMTX_CONF, patched, 'utf8');
    console.log(`[pwvd] mediamtx.yml: webrtcAdditionalHosts atualizado para [${lanIp}]`);
  }
}

// ---- MediaMTX ----
const mtx = new MediaMTX({ binary: MEDIAMTX_PATH, config: MEDIAMTX_CONF });
mtx.start();

// ---- Fastify HTTPS ----
const app = Fastify({
  https: {
    key:  readFileSync(TLS_KEY),
    cert: readFileSync(TLS_CERT),
  },
  logger: false,
  bodyLimit: 2 * 1024 * 1024,
});

// Accept application/sdp (WHIP/WHEP) and any non-JSON body.
// Capture the raw bytes so the proxy can forward them unchanged.
app.addContentTypeParser(/^application\/json/, { parseAs: 'string' },
  (_req, body, done) => { try { done(null, body ? JSON.parse(body) : {}); } catch (e) { done(e); } });
app.addContentTypeParser(/.*/, { parseAs: 'buffer' },
  (_req, body, done) => done(null, body));

// Static web UI
await app.register(fastifyStatic, {
  root: join(ROOT, 'web'),
  prefix: '/',
  index: ['index.html'],
});

// Config endpoint consumed by phone/operator pages.
app.get('/api/config', async () => {
  const ip = getPrimaryLanIP();
  const phoneUrl = `https://${ip}:${HTTPS_PORT}/phone.html`;
  return {
    streamName: STREAM_NAME,
    defaultCodec: DEFAULT_CODEC,
    maxCpuPercent: MAX_CPU,
    phoneUrl,
    rootUrl: `https://${ip}:${HTTPS_PORT}/`,
    whipUrl: `/whip/${STREAM_NAME}`,
    whepUrl: `/whep/${STREAM_NAME}`,
    obs: {
      whep: `https://${ip}:${HTTPS_PORT}/whep/${STREAM_NAME}`,
      whepDirect: `http://${ip}:${WHIP_PORT}/${STREAM_NAME}/whep`,
      rtsp: `rtsp://${ip}:${RTSP_PORT}/${STREAM_NAME}`,
    },
    lan: { ip, port: HTTPS_PORT, interfaces: getLanIPs() },
    authRequired: !!PANEL_PASSWORD,
  };
});

// ---- Auth login (operator panel) ----
app.post('/api/login', async (req) => {
  const { password } = req.body || {};
  if (!PANEL_PASSWORD) return { ok: true, token: '' };
  if (password === PANEL_PASSWORD) return { ok: true, token: AUTH_TOKEN };
  return { ok: false, error: 'Senha incorreta' };
});

// ---- APK download (phone downloads native app over LAN) ----
app.get('/download/pwvd-cam.apk', async (req, reply) => {
  const apkPath = resolve(ROOT, 'android', 'release', 'pwvd-cam.apk');
  if (!existsSync(apkPath)) {
    reply.code(404);
    return { error: 'APK não encontrado. Compile o projeto Android primeiro.' };
  }
  const buf = readFileSync(apkPath);
  reply.header('Content-Type', 'application/vnd.android.package-archive');
  reply.header('Content-Disposition', 'attachment; filename="pwvd-cam.apk"');
  return reply.send(buf);
});

// QR code as SVG (or PNG data URL) for any URL.
app.get('/api/qr', async (req, reply) => {
  const text = req.query.text || `https://${getPrimaryLanIP()}:${HTTPS_PORT}/phone.html`;
  const format = (req.query.format || 'svg').toLowerCase();
  const opts = { errorCorrectionLevel: 'M', margin: 1, width: 320,
                 color: { dark: '#ffffff', light: '#0b0b11' } };
  if (format === 'png') {
    const dataUrl = await QRCode.toDataURL(String(text), opts);
    return { dataUrl };
  }
  const svg = await QRCode.toString(String(text), { ...opts, type: 'svg' });
  reply.header('Content-Type', 'image/svg+xml; charset=utf-8');
  return reply.send(svg);
});

// Live server + devices status (polled by the operator dashboard).
app.get('/api/status', { preHandler: requireAuth }, async () => {
  const [status, devices] = await Promise.all([
    getStatus({ maxCpuPercent: MAX_CPU }),
    Promise.resolve(listDevices()),
  ]);
  return { ...status, devices };
});

// Real-time status via Server-Sent Events.
app.get('/api/status/stream', { preHandler: requireAuth }, async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  req.raw.on('close', () => { closed = true; });
  const tick = async () => {
    if (closed) return;
    try {
      const [status, devices] = await Promise.all([
        getStatus({ maxCpuPercent: MAX_CPU }),
        Promise.resolve(listDevices()),
      ]);
      reply.raw.write(`data: ${JSON.stringify({ ...status, devices })}\n\n`);
    } catch (e) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
    }
    if (!closed) setTimeout(tick, 500);
  };
  tick();
});

// Phone announces itself with extra UA-Client-Hints data right after load.
app.post('/api/hello', async (req) => {
  const ip = req.ip;
  const body = req.body || {};
  const dev = recordDevice(ip, {
    userAgent: req.headers['user-agent'] || '',
    uaData: body.uaData || null,
    role: 'phone',
    path: body.path || null,
  });
  return { ok: true, ip, device: dev };
});

// ---- Kick a publisher: expels an active WebRTC session from MediaMTX ----
// The phone's PeerConnection will go to 'disconnected' and stop sending.
// Accepts either a session id (preferred) or a path name (kicks all sessions on that path).
app.post('/api/kick', { preHandler: requireAuth }, async (req, reply) => {
  const { id, path } = req.body || {};
  if (!id && !path) {
    reply.code(400);
    return { ok: false, error: 'Informe id ou path' };
  }
  const killed = [];
  try {
    if (id) {
      const r = await fetch(`http://127.0.0.1:9997/v3/webrtcsessions/kick/${encodeURIComponent(id)}`,
        { method: 'POST', signal: AbortSignal.timeout(2000) });
      if (r.ok) killed.push(id);
    } else {
      // Path-based: find matching sessions and kick each.
      const list = await (await fetch('http://127.0.0.1:9997/v3/webrtcsessions/list',
        { signal: AbortSignal.timeout(2000) })).json();
      const victims = (list.items || []).filter(s => s.path === path);
      for (const s of victims) {
        const r = await fetch(`http://127.0.0.1:9997/v3/webrtcsessions/kick/${encodeURIComponent(s.id)}`,
          { method: 'POST', signal: AbortSignal.timeout(2000) });
        if (r.ok) killed.push(s.id);
      }
    }
  } catch (e) {
    reply.code(502);
    return { ok: false, error: String(e) };
  }
  return { ok: true, killed };
});

// ---- WHIP / WHEP proxy -> MediaMTX ----
// MediaMTX exposes WHIP at http://<host>:<WHIP_PORT>/<path>/whip and WHEP at /<path>/whep.
// We proxy so the phone only needs to trust ONE origin (our HTTPS control plane).
async function proxyTo(req, reply, target) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];

  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    // Fastify already parsed the body (Buffer for non-JSON, object for JSON).
    if (Buffer.isBuffer(req.body)) {
      body = req.body;
    } else if (typeof req.body === 'string') {
      body = Buffer.from(req.body);
    } else if (req.body && typeof req.body === 'object') {
      body = Buffer.from(JSON.stringify(req.body));
      headers['content-type'] = 'application/json';
    } else {
      body = Buffer.alloc(0);
    }
    headers['content-length'] = String(body.length);
  }

  const upstream = await fetch(target, { method: req.method, headers, body });
  reply.status(upstream.status);
  upstream.headers.forEach((v, k) => {
    if (k === 'transfer-encoding' || k === 'connection') return;
    reply.header(k, v);
  });
  const buf = Buffer.from(await upstream.arrayBuffer());
  return reply.send(buf);
}

app.all('/whip/:name', async (req, reply) => {
  recordDevice(req.ip, { userAgent: req.headers['user-agent'], role: 'publisher', path: req.params.name });
  const target = `http://127.0.0.1:${WHIP_PORT}/${req.params.name}/whip`;
  return proxyTo(req, reply, target);
});

app.all('/whep/:name', async (req, reply) => {
  recordDevice(req.ip, { userAgent: req.headers['user-agent'], role: 'reader', path: req.params.name });
  const target = `http://127.0.0.1:${WHIP_PORT}/${req.params.name}/whep`;
  return proxyTo(req, reply, target);
});

// Some clients send DELETE to the session URL (session resource). MediaMTX accepts them on the same path.
app.all('/whip/:name/*', async (req, reply) => {
  const rest = req.params['*'];
  const target = `http://127.0.0.1:${WHIP_PORT}/${req.params.name}/whip/${rest}`;
  return proxyTo(req, reply, target);
});
app.all('/whep/:name/*', async (req, reply) => {
  const rest = req.params['*'];
  const target = `http://127.0.0.1:${WHIP_PORT}/${req.params.name}/whep/${rest}`;
  return proxyTo(req, reply, target);
});

// ---- Start ----
await app.listen({ host: BIND_ADDR, port: HTTPS_PORT });

const ip = getPrimaryLanIP();
const phoneUrl = `https://${ip}:${HTTPS_PORT}/`;
const opUrl    = `https://${ip}:${HTTPS_PORT}/op.html`;
const whepUrl  = `https://${ip}:${HTTPS_PORT}/whep/${STREAM_NAME}`;
const rtspUrl  = `rtsp://${ip}:${RTSP_PORT}/${STREAM_NAME}`;

console.log('');
console.log('==========================================================');
console.log(' PWVD — phone camera to OBS');
console.log('==========================================================');
console.log(` Phone (scan QR or open)   : ${phoneUrl}`);
console.log(` Operator dashboard        : ${opUrl}`);
console.log(` OBS WHEP URL              : ${whepUrl}`);
console.log(` OBS RTSP URL              : ${rtspUrl}`);
console.log(` CPU budget                : ${MAX_CPU}%`);
console.log('==========================================================');
console.log('');
qrcode.generate(phoneUrl, { small: true });
console.log('');

function shutdown() {
  console.log('\n[pwvd] shutting down…');
  mtx.stop();
  app.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
