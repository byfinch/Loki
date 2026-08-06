/**
 * rrt.js
 * Google Rich Results Test (RRT) otomatik kosucu (kuyruk + cache + kayit).
 *
 * Saldiri/loop basladiginda hedef host icin Google Rich Results Test'i
 * arka planda calistirir ve sonucu panelde gostermek uzere
 * data/rrt-results.json'a yazar.
 *
 * Testin kendisi iki yoldan kosulabilir:
 * - LOKI_RRT_WORKER_URL tanimliysa: uzak worker servisine HTTP ile devredilir
 *   (or. residential IP'li ev PC; VPS/datacenter IP'de BotGuard reddi yuksek).
 *   Worker hata verirse lokal Chrome'a dusulur (fallback).
 * - Degilse: lokal Chrome ile backend/rrt-core.js uzerinden.
 *
 * Tekillestirme: ayni host 24 saatte en fazla 1 kez test edilir
 * (hata verdict'i 10 dakikada tekrar denenebilir).
 * Kuyruk: ayni anda tek test; istekler siraya girer.
 * Bu modul asla throw etmez; tum hatalar console.warn ile gecistirilir.
 */

const fs = require('fs');
const path = require('path');
const core = require('./rrt-core');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'rrt-results.json');

const CACHE_MS = 24 * 60 * 60 * 1000;   // ayni host 24 saatte bir
// Hatali testler (Chrome yoktu, ag sorunu vb.) 24s KILITLENMESIN:
// kisa cache sonrasi tekrar denenebilsin.
const ERROR_CACHE_MS = 10 * 60 * 1000;
const MAX_KEPT_HOSTS = 200;

// Uzak worker delegasyonu (opsiyonel)
const WORKER_URL = (process.env.LOKI_RRT_WORKER_URL || '').replace(/\/+$/, '') || null;
const WORKER_SECRET = process.env.LOKI_RRT_SECRET || '';
const WORKER_TIMEOUT_MS = 4 * 60 * 1000; // worker cagrisi ust siniri (test 3dk + pay)

// Kuyruk ve durum
const queue = [];            // [{ host, enqueuedAt }]
const delayed = new Map();   // host -> timeoutId (delayMs bekleyenler)
let running = null;          // su an test edilen host
let results = loadResults();

if (WORKER_URL) {
  console.log(`[rrt] uzak worker aktif: ${WORKER_URL}`);
}

function warn(...args) {
  console.warn('[rrt]', ...args);
}

function log(...args) {
  console.log('[rrt]', ...args);
}

function loadResults() {
  try {
    if (fs.existsSync(RESULTS_FILE)) {
      return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    }
  } catch (err) {
    warn('Sonuc dosyasi okunamadi:', err.message);
  }
  return {};
}

function saveResults() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${RESULTS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(results, null, 2));
    fs.renameSync(tmp, RESULTS_FILE);
    try { fs.chmodSync(RESULTS_FILE, 0o600); } catch (e) { /* Windows'ta yok say */ }
  } catch (err) {
    warn('Sonuc dosyasi yazilamadi:', err.message);
  }
}

// host girdisi "example.com", "https://example.com/path" vb. olabilir;
// test edilecek tam URL'ye cevirir.
function toTestUrl(host) {
  if (!host || typeof host !== 'string') return null;
  let h = host.trim();
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  try {
    const u = new URL(h);
    return u.origin + '/';
  } catch (e) {
    return null;
  }
}

// Cache anahtari olarak normalize host (protokolsuz, kucuk harf, pathsiz).
function hostKey(host) {
  const url = toTestUrl(host);
  if (!url) return null;
  try {
    // server.js normalizeHost www. prefix'ini zaten atar; disaridan dogrudan
    // cagri ihtimaline karsi burada da tekillestir.
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

/**
 * Disari acilan API: host icin RRT zamanla.
 * delayMs sonra kuyruga girer; 24 saatlik cache ve bekleyen/aktif
 * kayitlar tekillestirir.
 */
function scheduleRrtCheck(host, { delayMs = 0 } = {}) {
  try {
    const key = hostKey(host);
    if (!key) return false;

    const cached = results[key];
    if (cached) {
      const age = Date.now() - new Date(cached.testedAt).getTime();
      const ttl = cached.verdict === 'error' ? ERROR_CACHE_MS : CACHE_MS;
      if (age < ttl) return false; // cache suresi icinde test edilmis
    }
    if (delayed.has(key) || running === key || queue.some((q) => q.key === key)) {
      return false; // zaten sirada veya calisiyor
    }

    const timerId = setTimeout(() => {
      delayed.delete(key);
      queue.push({ key, url: toTestUrl(host), enqueuedAt: Date.now() });
      pumpQueue();
    }, Math.max(0, delayMs));
    timerId.unref?.();
    delayed.set(key, timerId);
    log(`Test zamanlanan: ${key} (${Math.round(delayMs / 1000)}sn sonra)`);
    return true;
  } catch (err) {
    warn('scheduleRrtCheck hatasi:', err.message);
    return false;
  }
}

function pumpQueue() {
  if (running || queue.length === 0) return;
  const job = queue.shift();
  running = job.key;
  runTest(job.key, job.url)
    .catch((err) => warn(`Test hatasi (${job.key}):`, err.message))
    .finally(() => {
      running = null;
      setImmediate(pumpQueue);
    });
}

// --- Uzak worker delegasyonu -------------------------------------------------

// Tek denemelik worker cagrisi; hata/timeout'ta throw eder (cagiran retry/fallback yapar).
async function callWorkerOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
  try {
    const res = await fetch(`${WORKER_URL}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret: WORKER_SECRET }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`worker HTTP ${res.status}`);
    const record = await res.json();
    if (!record || typeof record.verdict !== 'string') {
      throw new Error('worker gecersiz record dondurdu');
    }
    return record;
  } finally {
    clearTimeout(timer);
  }
}

// Worker'a 1 retry ile devreder; olmazsa null doner (lokal fallback).
async function runViaWorker(key, url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const record = await callWorkerOnce(url);
      record.host = key; // guvenlik: cache anahtari bizim normalizasyonumuz
      log(`Test bitti (uzak worker): ${key} -> ${record.verdict} (${record.durationSec}sn)`);
      return record;
    } catch (err) {
      warn(`Worker cagrisi basarisiz (deneme ${attempt}/2, ${key}):`, err.message);
    }
  }
  return null;
}

// --- Tek test + kayit --------------------------------------------------------

async function runTest(key, url) {
  let record = null;

  // Once uzak worker; ulasilmazsa/hata verirse lokal Chrome'a dus.
  if (WORKER_URL) {
    record = await runViaWorker(key, url);
    if (!record) warn(`Worker kullanilamadi, lokal Chrome deneniyor: ${key}`);
  }
  if (!record) {
    record = await core.runRrtTest(key, url);
  }

  results[key] = record;

  // Dosya sisecekse en eski kayitlari at
  const keys = Object.keys(results);
  if (keys.length > MAX_KEPT_HOSTS) {
    keys
      .sort((a, b) => new Date(results[a].testedAt) - new Date(results[b].testedAt))
      .slice(0, keys.length - MAX_KEPT_HOSTS)
      .forEach((k) => delete results[k]);
  }

  saveResults();
}

/**
 * GET /api/rrt icin durum: kalici sonuclar (testedAt desc) + bekleyen/calisan.
 */
function getRrtState() {
  const list = Object.values(results)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt));
  const pending = [
    ...[...delayed.keys()].map((host) => ({ host, state: 'delayed' })),
    ...queue.map((q) => ({ host: q.key, state: 'queued' }))
  ];
  if (running) pending.push({ host: running, state: 'running' });
  return { results: list, pending };
}

module.exports = { scheduleRrtCheck, getRrtState };
