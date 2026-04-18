// Monitoring aggregator: CPU/mem + MediaMTX paths/sessions.
import { cpus, totalmem, freemem, uptime as osUptime, loadavg, hostname } from 'node:os';
import { getDeviceByIp } from './devices.js';

const MTX_API = 'http://127.0.0.1:9997';

let prevCpu = snapshotCpu();
function snapshotCpu() {
  const c = cpus();
  let idle = 0, total = 0;
  for (const cpu of c) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total, at: Date.now() };
}
export function cpuPercent() {
  const now = snapshotCpu();
  const idle = now.idle - prevCpu.idle;
  const total = now.total - prevCpu.total;
  prevCpu = now;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

async function mtx(path) {
  try {
    const r = await fetch(`${MTX_API}${path}`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function getStatus({ maxCpuPercent }) {
  const [paths, whipSess, whepSess, rtspSess, rtspConns] = await Promise.all([
    mtx('/v3/paths/list'),
    mtx('/v3/webrtcsessions/list'),
    mtx('/v3/webrtcsessions/list'), // same endpoint, filtered below
    mtx('/v3/rtspsessions/list'),
    mtx('/v3/rtspconns/list'),
  ]);

  const mem = { total: totalmem(), free: freemem() };
  const cpuPct = cpuPercent();

  // Split WebRTC sessions by role via state (publish/read).
  const wrtc = whipSess?.items || [];
  const publishers = wrtc.filter(s => (s.state || '').toLowerCase() === 'publish').map(mapWrtc);
  const readers    = wrtc.filter(s => (s.state || '').toLowerCase() === 'read').map(mapWrtc);

  const rtsp = (rtspSess?.items || []).map(s => {
    const dev = getDeviceByIp(s.remoteAddr || '');
    return {
      id: s.id,
      path: s.path,
      role: (s.state || '').toLowerCase(),
      remoteAddr: s.remoteAddr,
      bytesSent: s.bytesSent,
      bytesReceived: s.bytesReceived,
      created: s.created,
      device: dev ? {
        os: dev.os, osVersion: dev.osVersion,
        browser: dev.browser, browserVersion: dev.browserVersion,
        model: dev.uaModel || dev.model,
      } : null,
    };
  });

  return {
    server: {
      host: hostname(),
      uptimeSec: Math.round(osUptime()),
      cpuPercent: Math.round(cpuPct),
      cpuBudget: maxCpuPercent,
      mem: {
        totalMB: Math.round(mem.total / 1024 / 1024),
        usedMB: Math.round((mem.total - mem.free) / 1024 / 1024),
      },
      load: loadavg(),
    },
    paths: (paths?.items || []).map(p => ({
      name: p.name,
      ready: p.ready,
      source: p.source?.type || null,
      readers: p.readers?.length || 0,
      bytesReceived: p.bytesReceived,
      bytesSent: p.bytesSent,
      tracks: p.tracks || [],
    })),
    publishers,
    readers,
    rtsp,
  };
}

function mapWrtc(s) {
  const dev = getDeviceByIp(s.remoteAddr || '');
  return {
    id: s.id,
    path: s.path,
    role: (s.state || '').toLowerCase(),
    remoteAddr: s.remoteAddr,
    peerConnectionEstablished: s.peerConnectionEstablished,
    bytesSent: s.bytesSent,
    bytesReceived: s.bytesReceived,
    created: s.created,
    device: dev ? {
      os: dev.os, osVersion: dev.osVersion,
      browser: dev.browser, browserVersion: dev.browserVersion,
      model: dev.uaModel || dev.model,
      brands: dev.uaBrands,
    } : null,
  };
}
