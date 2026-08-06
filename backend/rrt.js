/**
 * rrt.js
 * Google Rich Results Test (RRT) otomatik kosucu.
 *
 * Saldiri/loop basladiginda hedef host icin Google Rich Results Test'i
 * arka planda calistirir ve sonucu panelde gostermek uzere
 * data/rrt-results.json'a yazar.
 *
 * Kanitlanan akis (.rrt-recon notlari):
 * - Test baslatma RPC'si (RVtklb) BotGuard token'i ister; token sadece
 *   gercek tarayici ortaminda uretilir (saf curl ile baslatma mumkun degil).
 * - Bu yuzden test, sistem Chrome'u HEADED modda (puppeteer-core) calistirilir.
 *   headless:'new' YAPMA: BotGuard headless'i cogunlukla reddediyor.
 *   Linux/VPS'te DISPLAY gerekir -> servisi `xvfb-run -a` altinda calistir.
 * - Sonuc okuma tokensuzdur: inspection id ile MrNfbc (durum) ve
 *   zUbeBb (oge sonuclari) RPC'leri plain HTTP ile cagrilabilir.
 *
 * Tekillestirme: ayni host 24 saatte en fazla 1 kez test edilir.
 * Kuyruk: ayni anda tek tarayici/test; istekler siraya girer.
 * Bu modul asla throw etmez; tum hatalar console.warn ile gecistirilir.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'rrt-results.json');

const CACHE_MS = 24 * 60 * 60 * 1000;   // ayni host 24 saatte bir
// Hatali testler (Chrome yoktu, ag sorunu vb.) 24s KILITLENMESIN:
// kisa cache sonrasi tekrar denenebilsin.
const ERROR_CACHE_MS = 10 * 60 * 1000;
const TEST_TIMEOUT_MS = 3 * 60 * 1000;  // test basina toplam ust sinir
const NAV_WAIT_MS = 12 * 1000;          // tek tiklamada sonuc sayfasina gecis bekleme
const MAX_CLICK_ATTEMPTS = 2;           // hizli basarisizlik: hata cache'i (10dk) zaten tekrar deniyor
const POLL_INTERVAL_MS = 5000;
const MAX_KEPT_HOSTS = 200;

// Kuyruk ve durum
const queue = [];            // [{ host, enqueuedAt }]
const delayed = new Map();   // host -> timeoutId (delayMs bekleyenler)
let running = null;          // su an test edilen host
let browser = null;
let browserLaunching = null;
let results = loadResults();

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

// --- Chrome yonetimi -------------------------------------------------------

function resolveChromePath() {
  if (process.env.LOKI_CHROME_PATH) return process.env.LOKI_CHROME_PATH;
  if (process.platform === 'win32') {
    const candidates = [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return 'chrome';
  }
  // Linux: puppeteer PATH cozumlemez; bilinen yollari dene, yoksa `which`
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const { execSync } = require('child_process');
    const found = execSync('which google-chrome || which chromium || which chromium-browser', { encoding: 'utf8' }).trim().split('\n')[0];
    if (found) return found;
  } catch { /* asagida fallback */ }
  return 'google-chrome';
}

async function getBrowser() {
  if (browser && browser.connected !== false) return browser;
  if (browserLaunching) return browserLaunching;

  browserLaunching = (async () => {
    // puppeteer-extra + stealth: BotGuard'in automation tespit vektorlerini
    // (navigator.webdriver, chrome.runtime, permissions vb.) kapatir.
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());

    const executablePath = resolveChromePath();
    const args = [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1280,900',
      '--disable-blink-features=AutomationControlled'
    ];
    // Opsiyonel proxy (or. http://user:pass@host:port): VPS/datacenter IP
    // skorunu yukseltmek icin residential proxy takilabilir.
    const proxyUrl = process.env.LOKI_RRT_PROXY_URL || null;
    if (proxyUrl) {
      try {
        const p = new URL(proxyUrl);
        args.push(`--proxy-server=${p.protocol}//${p.host}`);
      } catch (e) {
        warn('LOKI_RRT_PROXY_URL parse edilemedi, proxysuz devam:', e.message);
      }
    }

    // Kalici profil: cerez/gecmis birikimi BotGuard skorunu yukseltir.
    const userDataDir = path.join(DATA_DIR, 'rrt-chrome-profile');
    log(`Chrome baslatiliyor (headed): ${executablePath}${proxyUrl ? ' +proxy' : ''}`);
    const b = await puppeteer.launch({
      executablePath,
      // BotGuard headless'i reddediyor; headed + (Linux'ta) xvfb DISPLAY'i sart.
      headless: false,
      userDataDir,
      args
    });
    b.on('disconnected', () => { browser = null; });
    browser = b;
    browserLaunching = null;
    return b;
  })();

  try {
    return await browserLaunching;
  } finally {
    browserLaunching = null;
  }
}

async function closeBrowser() {
  try {
    if (browser) await browser.close();
  } catch (e) { /* sessiz */ }
  browser = null;
}

// --- batchexecute yardimcilari ---------------------------------------------

// ")]}'" + satir bazli [uzunluk\nJSON] streaming formatini cozer.
// Donus: { rpcid: parsedPayload }
function parseBatchExecute(body) {
  const frames = {};
  const lines = String(body).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\d+$/.test(lines[i].trim()) && lines[i + 1]) {
      try {
        for (const f of JSON.parse(lines[i + 1])) {
          if (f[0] === 'wrb.fr' && f[2]) frames[f[1]] = JSON.parse(f[2]);
        }
      } catch (e) { /* parcali satir, atla */ }
      i++;
    }
  }
  return frames;
}

// zUbeBb payload'indan oge listesini cikarir.
// Yapi: [header, items|null, [1], null, bool, validCount, warnCount, errCount]
// item: [tag, subtrees, meta, warnings, errors, source]
function extractItems(z) {
  const out = { items: [], validCount: 0, warnings: 0, errors: 0 };
  if (!Array.isArray(z)) return out;
  out.validCount = Number.isInteger(z[5]) ? z[5] : 0;
  out.warnings = Number.isInteger(z[6]) ? z[6] : 0;
  out.errors = Number.isInteger(z[7]) ? z[7] : 0;
  const rawItems = Array.isArray(z[1]) ? z[1] : [];
  for (const it of rawItems) {
    // Ogrenin ilk "type" degerini agac icinde ara
    let name = null;
    const scan = (o) => {
      if (name || !Array.isArray(o)) return;
      if (o[0] === 'type' && typeof o[1] === 'string') { name = o[1]; return; }
      o.forEach(scan);
    };
    scan(it[1]);
    const w = Number.isInteger(it[it.length - 3]) ? it[it.length - 3] : 0;
    const e = Number.isInteger(it[it.length - 2]) ? it[it.length - 2] : 0;
    out.items.push({ name: name || 'Bilinmeyen oge', valid: e === 0, warnings: w, errors: e });
  }
  return out;
}

// --- Tek test akisi ---------------------------------------------------------

// BotGuard input pipeline'ini beslemek icin JS el.click() YERINE gercek
// mouse olaylari: butona insan gibi yaklas, kisa bekle, down/up.
// Buton bulunamazsa URL input'una odaklanip Enter (fallback).
async function clickTestButtonHuman(page) {
  const handle = await page.evaluateHandle(() => {
    const els = [...document.querySelectorAll('button, [role="button"]')];
    return els.find((e) => /test url/i.test(e.innerText || '')) || null;
  });
  const el = handle.asElement();
  if (el) {
    const box = await el.boundingBox();
    if (box) {
      const x = box.x + box.width / 2 + (Math.random() * 8 - 4);
      const y = box.y + box.height / 2 + (Math.random() * 4 - 2);
      await page.mouse.move(x, y, { steps: 20 + Math.floor(Math.random() * 15) });
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 300));
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 90));
      await page.mouse.up();
      return true;
    }
  }
  // Fallback: input alanina odaklan + Enter
  await page.evaluate(() => {
    const input = document.querySelector('input[type="url"], input[placeholder*="URL" i], form input');
    if (input) input.focus();
  });
  await page.keyboard.press('Enter');
  return false;
}

async function runTest(key, url) {
  const startedAt = Date.now();
  const record = {
    host: key,
    testedAt: new Date().toISOString(),
    verdict: 'error',
    items: [],
    crawlError: null,
    partialLoad: null,
    resultUrl: null,
    durationSec: 0
  };

  // Genel ust sinir: her durumda kayit duser
  await Promise.race([
    runTestInner(url, record),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Test zamanimi asti (3dk)')), TEST_TIMEOUT_MS))
  ]).catch(async (err) => {
    record.verdict = 'error';
    record.crawlError = err.message;
    // Cokme/askida kalma sonrasi tarayiciyi temiz baslat
    await closeBrowser();
  });

  record.durationSec = Math.round((Date.now() - startedAt) / 1000);
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
  log(`Test bitti: ${key} -> ${record.verdict} (${record.durationSec}sn)`);
}

async function runTestInner(url, record) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    // Proxy kimlik dogrulamasi (LOKI_RRT_PROXY_URL icindeki user:pass)
    const proxyUrl = process.env.LOKI_RRT_PROXY_URL || null;
    if (proxyUrl) {
      try {
        const p = new URL(proxyUrl);
        if (p.username) {
          await page.authenticate({ username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) });
        }
      } catch (e) { /* getBrowser'da zaten loglandi */ }
    }
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await page.goto('https://search.google.com/test/rich-results?url=' + encodeURIComponent(url), {
      waitUntil: 'networkidle2',
      timeout: 90000
    });

    // TEST URL tikla; BotGuard reddederse (sayfa /result'a gitmezse) tekrar dene
    let navigated = false;
    for (let attempt = 0; attempt < MAX_CLICK_ATTEMPTS && !navigated; attempt++) {
      await new Promise((r) => setTimeout(r, 2500));
      const realClick = await clickTestButtonHuman(page);
      if (!realClick) warn(`TEST URL butonu bulunamadi, Enter fallback kullanildi: ${url}`);
      const deadline = Date.now() + NAV_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (page.url().includes('/result')) { navigated = true; break; }
      }
      if (!navigated) warn(`Tiklamaya yanit yok (deneme ${attempt + 1}/${MAX_CLICK_ATTEMPTS}): ${url}`);
    }
    if (!navigated) throw new Error('Google testi baslatmadi (BotGuard reddi olabilir)');

    record.resultUrl = page.url();

    // MrNfbc ile durum poll'u (sayfa icinden, same-origin fetch)
    const inspId = new URL(page.url()).searchParams.get('id');
    const deadline = Date.now() + (TEST_TIMEOUT_MS - 30000);
    let state = 1;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const poll = await page.evaluate(async (id) => {
        const payload = JSON.stringify([id, '']);
        const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['MrNfbc', payload, null, 'generic']]]));
        const r = await fetch('/_/SearchConsoleUi/data/batchexecute?rpcids=MrNfbc&rt=c', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body
        });
        return r.text();
      }, inspId);
      const frames = parseBatchExecute(poll);
      const st = frames.MrNfbc;
      if (Array.isArray(st) && st[1]) state = st[1];
      if (state === 2) break;
    }
    if (state !== 2) throw new Error('Test durumu 3 dakikada tamamlanmadi');

    // Crawl hatasi kontrolu (sayfa metni uzerinden)
    const pageText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    if (/not available to Google|Crawl failed/i.test(pageText)) {
      record.verdict = 'crawl_error';
      record.crawlError = (pageText.match(/(URL is not available to Google[^.]*|Crawl failed[^.]*)/i) || [])[0] || 'Crawl failed';
      return;
    }

    // zUbeBb (oge sonuclari) ve C4lTm (sayfa kaynak yukleme sorunlari) birlikte cekilir
    const id = new URL(page.url()).searchParams.get('id');
    const rpcRaw = await page.evaluate(async (inspId) => {
      const zbPayload = JSON.stringify([inspId, null, null, null, null, null, null, 1]);
      const c4Payload = JSON.stringify([inspId, 3]);
      const body = 'f.req=' + encodeURIComponent(JSON.stringify([
        [['zUbeBb', zbPayload, null, 'generic']],
        [['C4lTm', c4Payload, null, 'generic']]
      ]));
      const r = await fetch('/_/SearchConsoleUi/data/batchexecute?rpcids=zUbeBb%2CC4lTm&rt=c', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body
      });
      return r.text();
    }, id);
    const frames = parseBatchExecute(rpcRaw);
    const parsed = extractItems(frames.zUbeBb);
    record.items = parsed.items;
    // C4lTm: [true, [[kod, mesaj, url, ...], ...]] -> sorunlu kaynak sayisi
    const c4 = frames.C4lTm;
    const resIssues = (Array.isArray(c4) && Array.isArray(c4[1])) ? c4[1].length : 0;
    record.partialLoad = resIssues > 0 ? resIssues : null;

    const validMatch = pageText.match(/(\d+)\s+valid items? detected/i);
    const validCount = validMatch ? parseInt(validMatch[1]) : (parsed.validCount || 0);
    if (/No rich results detected/i.test(pageText)) {
      record.verdict = 'none';
    } else if (validCount > 0 || parsed.items.length > 0) {
      record.verdict = 'items';
    } else {
      record.verdict = 'none';
    }
  } finally {
    try { await page.close(); } catch (e) { /* sayfa zaten kapali */ }
  }
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
