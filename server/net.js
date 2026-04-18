// Discover the primary LAN IPv4 address of this machine.
// Skips loopback, link-local, virtual adapters and docker/vEthernet interfaces.
import { networkInterfaces } from 'node:os';

const VIRTUAL_HINTS = [
  'vethernet', 'virtualbox', 'vmware', 'docker', 'hyper-v', 'wsl',
  'loopback', 'bluetooth', 'tap-', 'tailscale', 'zerotier', 'radmin'
];

function score(name, addr) {
  const n = name.toLowerCase();
  let s = 0;
  for (const bad of VIRTUAL_HINTS) if (n.includes(bad)) s -= 50;
  // Reject non-RFC1918 addresses outright (Radmin VPN uses 26.x public range)
  if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(addr)) s -= 200;
  if (n.includes('ethernet') || n.includes('eth')) s += 20;     // wired wins
  if (n.includes('wi-fi') || n.includes('wlan') || n.includes('wifi')) s += 10;
  // Prefer RFC1918 private ranges
  if (/^10\./.test(addr)) s += 5;
  if (/^192\.168\./.test(addr)) s += 5;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(addr)) s += 5;
  return s;
}

export function getLanIPs() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ name, address: info.address, score: score(name, info.address) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function getPrimaryLanIP() {
  const ips = getLanIPs();
  return ips[0]?.address || '127.0.0.1';
}
