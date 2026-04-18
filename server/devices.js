// In-memory registry of devices that touched WHIP/WHEP or called /api/hello.
// Parses User-Agent into { os, osVersion, browser, browserVersion, device, model }.
// Keyed by remote IP so we can merge with MediaMTX sessions (same IP).

const registry = new Map(); // ip -> Device

export function recordDevice(ip, { userAgent, uaData, role, path }) {
  if (!ip) return;
  const existing = registry.get(ip) || { ip, firstSeen: Date.now() };
  const parsed = parseUA(userAgent || '');
  const merged = {
    ...existing,
    lastSeen: Date.now(),
    userAgent: userAgent || existing.userAgent || '',
    role: role || existing.role,
    path: path || existing.path,
    ...parsed,
    ...cleanUaData(uaData),
  };
  registry.set(ip, merged);
  // Evict entries older than 10 min
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of registry) if (v.lastSeen < cutoff) registry.delete(k);
  return merged;
}

export function listDevices() {
  return [...registry.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export function getDeviceByIp(ip) {
  if (!ip) return null;
  // MediaMTX reports addresses like "192.168.0.5:54321". Normalize.
  const justIp = ip.split(']').pop().split(':')[0].replace('[','').trim() || ip;
  return registry.get(justIp) || registry.get(ip) || null;
}

function cleanUaData(u) {
  if (!u || typeof u !== 'object') return {};
  const brands = Array.isArray(u.brands) ? u.brands.filter(b => b && !/Not.?A.?Brand/i.test(b.brand)) : [];
  return {
    uaMobile: u.mobile,
    uaPlatform: u.platform,
    uaPlatformVersion: u.platformVersion,
    uaArchitecture: u.architecture,
    uaModel: u.model,
    uaBrands: brands.map(b => `${b.brand} ${b.version}`).join(', '),
  };
}

// ---- Minimal UA parser (no dependency). Focused on mobile/streaming ----
function parseUA(ua) {
  const out = { os: '', osVersion: '', browser: '', browserVersion: '', device: '', model: '' };
  if (!ua) return out;

  // OS
  let m;
  if ((m = ua.match(/Android\s([\d.]+)/))) { out.os = 'Android'; out.osVersion = m[1]; }
  else if ((m = ua.match(/iPhone OS\s([\d_]+)/)) || (m = ua.match(/CPU OS\s([\d_]+)/))) {
    out.os = 'iOS'; out.osVersion = m[1].replace(/_/g, '.');
  }
  else if (/iPad/i.test(ua)) { out.os = 'iPadOS'; }
  else if (/Windows NT 10\.0/.test(ua)) { out.os = 'Windows 10/11'; }
  else if (/Mac OS X/.test(ua)) { out.os = 'macOS'; }
  else if (/Linux/.test(ua)) { out.os = 'Linux'; }

  // Browser
  if ((m = ua.match(/EdgA?\/([\d.]+)/)))          { out.browser = 'Edge';    out.browserVersion = m[1]; }
  else if ((m = ua.match(/OPR\/([\d.]+)/)))       { out.browser = 'Opera';   out.browserVersion = m[1]; }
  else if ((m = ua.match(/SamsungBrowser\/([\d.]+)/))) { out.browser = 'Samsung Internet'; out.browserVersion = m[1]; }
  else if ((m = ua.match(/FxiOS\/([\d.]+)/))
        || (m = ua.match(/Firefox\/([\d.]+)/)))   { out.browser = 'Firefox'; out.browserVersion = m[1]; }
  else if ((m = ua.match(/CriOS\/([\d.]+)/))
        || (m = ua.match(/Chrome\/([\d.]+)/)))    { out.browser = 'Chrome';  out.browserVersion = m[1]; }
  else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) { out.browser = 'Safari'; out.browserVersion = m[1]; }

  // Android device model: the UA has "(...; Pixel 7 Pro Build/...)" or "(...; SM-G998B) "
  if (out.os === 'Android') {
    const inside = ua.match(/\(([^)]+)\)/);
    if (inside) {
      const parts = inside[1].split(';').map(s => s.trim());
      // The model is usually after "Android X.Y"
      const afterAndroid = parts.findIndex(p => /^Android/.test(p));
      if (afterAndroid >= 0 && parts[afterAndroid + 1]) {
        out.model = parts[afterAndroid + 1].replace(/Build\/.*/, '').trim();
        out.device = out.model;
      }
    }
  } else if (out.os === 'iOS') {
    out.model = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : 'iOS device';
    out.device = out.model;
  } else if (out.os === 'iPadOS') {
    out.model = 'iPad';
    out.device = 'iPad';
  }

  return out;
}
