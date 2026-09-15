/**
 * netutil.js — SSRF korumasi icin host dogrulama.
 * Panelden eklenen hedefler sunucudan fetch ediliyor (curl/chrome);
 * loopback/RFC1918/link-local/metadata adreslerine istek engellenir.
 */
const dns = require('dns').promises;
const net = require('net');

// IPv4 ozel araliklari (RFC1918 + loopback + link-local + metadata)
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 10) return true;                        // 10.0.0.0/8
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16.0.0/12
  if (p[0] === 192 && p[1] === 168) return true;       // 192.168.0.0/16
  if (p[0] === 127) return true;                       // loopback
  if (p[0] === 169 && p[1] === 254) return true;       // link-local + metadata
  if (p[0] === 0) return true;                         // 0.0.0.0/8
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64.0.0/10
  if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;  // 192.0.0.0/24
  if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true;  // TEST-NET-1
  if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true; // TEST-NET-2
  if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true;  // TEST-NET-3
  if (p[0] >= 224) return true;                        // multicast+reserved
  return false;
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  return s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
}

/** Host'un (domain veya IP) public olup olmadigini dogrular.
 *  Domain'ler DNS cozumlenir; herhangi bir ozel adres donerse false. */
async function isPublicHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (net.isIPv4(h)) return !isPrivateIPv4(h);
  if (net.isIPv6(h)) return !isPrivateIPv6(h);
  try {
    const { address } = await dns.lookup(h, { verbatim: false });
    if (net.isIPv4(address)) return !isPrivateIPv4(address);
    return !isPrivateIPv6(address);
  } catch {
    return false; // cozumlenemeyen host reddedilir
  }
}

module.exports = { isPublicHost };
