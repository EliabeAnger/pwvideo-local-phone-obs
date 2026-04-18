// Generate local HTTPS certificates.
// Prefers mkcert (locally-trusted). Falls back to a self-signed cert via Node's crypto.
// Usage:  node scripts/make-certs.js
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

const OUT = resolve('certs');
mkdirSync(OUT, { recursive: true });

function lanIPs() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of (list || [])) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function hasMkcert() {
  try { execSync('mkcert -version', { stdio: 'ignore' }); return true; } catch { return false; }
}

const hosts = ['localhost', '127.0.0.1', ...lanIPs()];
const certPath = resolve(OUT, 'cert.pem');
const keyPath  = resolve(OUT, 'key.pem');

if (hasMkcert()) {
  console.log('[certs] mkcert detected — creating locally-trusted certificate');
  try { execSync('mkcert -install', { stdio: 'inherit' }); } catch {}
  execSync(`mkcert -cert-file "${certPath}" -key-file "${keyPath}" ${hosts.join(' ')}`, { stdio: 'inherit' });
  console.log(`[certs] written:\n  ${certPath}\n  ${keyPath}`);
  console.log('[certs] On the phone, install the mkcert CA root so Chrome/Safari trust the LAN IP.');
  console.log('[certs] Run `mkcert -CAROOT` to find the rootCA.pem; share it to the phone.');
  process.exit(0);
}

// ---- Fallback: self-signed via Node's built-in crypto (node 19+) ----
console.log('[certs] mkcert not found — generating self-signed cert (browsers will warn once).');
console.log('[certs] Install mkcert for a smoother experience: https://github.com/FiloSottile/mkcert');

const { generateKeyPairSync, createPrivateKey, X509Certificate } = await import('node:crypto');

// Node does not expose a high-level X.509 generator; fall back to a minimal OpenSSL call if present.
try {
  execSync('openssl version', { stdio: 'ignore' });
  const san = hosts.map((h, i) => /^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP.${i+1} = ${h}` : `DNS.${i+1} = ${h}`).join('\n');
  const cnf = `
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = pwvd-local
[v3]
subjectAltName = @alt
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
[alt]
${san}
`;
  const cnfPath = resolve(OUT, 'openssl.cnf');
  writeFileSync(cnfPath, cnf);
  execSync(`openssl req -x509 -nodes -newkey rsa:2048 -days 825 -keyout "${keyPath}" -out "${certPath}" -config "${cnfPath}"`, { stdio: 'inherit' });
  console.log(`[certs] written:\n  ${certPath}\n  ${keyPath}`);
  process.exit(0);
} catch (e) {
  console.error('[certs] Neither mkcert nor openssl is available. Install one and re-run.');
  console.error('[certs]   mkcert:  https://github.com/FiloSottile/mkcert');
  console.error('[certs]   openssl: included with Git for Windows (usr/bin/openssl.exe)');
  process.exit(1);
}
