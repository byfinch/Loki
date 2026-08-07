/**
 * rrt-core.js
 * Google Rich Results Test'in tarayici tabanli cekirdek akisi.
 *
 * Hem backend/rrt.js (lokal kosucu + kuyruk/cache) hem backend/rrt-worker.js
 * (uzak worker servisi, or. residential IP'li ev PC) bu modulu kullanir.
 *
 * Kanitlanan akis (.rrt-recon notlari):
 * - Test baslatma RPC'si (RVtklb) BotGuard token'i ister; token sadece
 *   gercek tarayici ortaminda uretilir (saf curl ile baslatma mumkun degil).
 * - Bu yuzden test, sistem Chrome'u HEADED modda (puppeteer-extra + stealth)
 *   calistirilir. headless:'new' YAPMA: BotGuard headless'i cogunlukla reddediyor.
 *   Linux'ta DISPLAY gerekir -> `xvfb-run -a` altinda calistir.
 * - Sonuc okuma tokensuzdur: inspection id ile MrNfbc (durum) ve
 *   zUbeBb (oge sonuclari) RPC'leri plain HTTP ile cagrilabilir.
 *
 * Disari acilan tek fonksiyon: runRrtTest(key, url) -> record
 * record: { host, testedAt, verdict, items, crawlError, partialLoad, resultUrl, durationSec }
 * Bu modul diske yazmaz; kuyruk/cache cagiran tarafin isi.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

const TEST_TIMEOUT_MS = 5 * 60 * 1000;  // test basina toplam ust sinir
const NAV_WAIT_MS = 12 * 1000;          // tek tiklamada sonuc sayfasina gecis bekleme
const MAX_CLICK_ATTEMPTS = 2;           // hizli basarisizlik: hata cache'i (10dk) zaten tekrar deniyor
const POLL_INTERVAL_MS = 5000;

let browser = null;
let browserLaunching = null;

function warn(...args) {
  console.warn('[rrt]', ...args);
}

function log(...args) {
  console.log('[rrt]', ...args);
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
      '--disable-blink-features=AutomationControlled',
      // Crash sonrasi "sayfalari geri yukle" davranisini kapat (sekme birikimi)
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--no-default-browser-check'
    ];
    // Opsiyonel proxy (or. http://user:pass@host:port): datacenter IP
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
    // LOKI_RRT_PROFILE_DIR verilirse o kullanilir (orn. gercek Chrome
    // profilinin kopyasi — acik Google oturumu BotGuard guvenini artirir).
    const userDataDir = process.env.LOKI_RRT_PROFILE_DIR || path.join(DATA_DIR, 'rrt-chrome-profile');
    log(`Chrome baslatiliyor (headed): ${executablePath}${proxyUrl ? ' +proxy' : ''}`);
    const b = await puppeteer.launch({
      executablePath,
      // BotGuard headless'i reddediyor; headed + (Linux'ta) xvfb DISPLAY'i sart.
      headless: false,
      userDataDir,
      args
    });
    b.on('disconnected', () => { browser = null; });
    // Onceki oturumdan restore edilen sekmeleri supur: Chrome crash/kill
    // sonrasi yeniden acilirken eski test sekmelerini geri yukler ve
    // bunlar birikir (kaynak tuketimi). Ilk (bos) sayfa haric hepsini kapat.
    try {
      const pages = await b.pages();
      for (const p of pages.slice(1)) {
        try { await p.close(); } catch (e) { /* sessiz */ }
      }
    } catch (e) { /* sessiz */ }
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
    let terminalText = null;
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
      // Bazi sonuclarda (ozellikle crawl hatasi) durum kodu 2'ye DONMUYOR.
      // Sonuc sayfasi server-rendered: result URL'sini dogrudan cekip terminal
      // isaret tara (SPA metni gec/guvenilmez guncellenir).
      try {
        const res = await fetch(record.resultUrl, { timeout: 20000 });
        const html = await res.text();
        const m = html.match(/Crawl failed|not available to Google|No rich results detected|\d+\s+valid items? detected/i);
        if (m) {
          terminalText = m[0];
          break;
        }
      } catch (e) { /* sonraki turda tekrar */ }
    }
    if (state !== 2 && !terminalText) throw new Error('Test durumu 5 dakikada tamamlanmadi');

    // Crawl hatasi kontrolu (sayfa metni uzerinden)
    const pageText = terminalText || await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    if (/not available to Google|Crawl failed/i.test(pageText)) {
      record.verdict = 'crawl_error';
      record.crawlError = (pageText.match(/(URL is not available to Google[^.]*|Crawl failed[^.]*)/i) || [])[0] || 'Crawl failed';
      return;
    }

    // zUbeBb (oge sonuclari) ve C4lTm (sayfa kaynak yukleme sorunlari) birlikte cekilir
    const id = new URL(page.url()).searchParams.get('id');
    const rpcRaw = await page.evaluate(async (inspId2) => {
      const zbPayload = JSON.stringify([inspId2, null, null, null, null, null, null, 1]);
      const c4Payload = JSON.stringify([inspId2, 3]);
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
 * Tek bir RRT testi kosar ve record dondurur. Hicbir zaman throw etmez;
 * hata durumunda verdict 'error' + crawlError mesaji doner.
 */
async function runRrtTest(key, url) {
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

  // Genel ust sinir: her durumda kayit doner
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
  log(`Test bitti: ${key} -> ${record.verdict} (${record.durationSec}sn)`);
  return record;
}

module.exports = { runRrtTest, parseBatchExecute, extractItems };
