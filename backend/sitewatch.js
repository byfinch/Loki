/**
 * sitewatch.js — SiteWatcher (uptime izleme) Loki surumu
 *
 * Website-Watcher (PHP) aracinin Node portu: izlenen siteleri HTTP ile
 * kontrol eder (2xx/3xx up), yarim saatte bir otomatik tur, telegram'a
 * kanit ekran goruntusu ile bildirir; DOWN'da grup + admin DM alarmi.
 *
 * Veriler backend/data/sitewatch-sites.json dosyasinda tutulur (Loki kalibi).
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { isPublicHost } = require('./netutil');

const DATA_DIR = path.join(__dirname, 'data');
const SITES_FILE = path.join(DATA_DIR, 'sitewatch-sites.json');

// Token koda GOMMEZ; ecosystem (LOKI_SITEWATCH_TG_TOKEN) uzerinden gelir.
const TG_TOKEN = process.env.LOKI_SITEWATCH_TG_TOKEN || process.env.SITEWATCH_TG_TOKEN || '';
const TG_CHAT = process.env.LOKI_SITEWATCH_TG_CHAT || process.env.SITEWATCH_TG_CHAT || '';
// DOWN alarmlari ozelden gidenler (Burak, Turco)
const DM_USERS = (process.env.SITEWATCH_DM || '8849693458,8757169131').split(',').filter(Boolean);
const PROOF_SERVICE = process.env.SITEWATCH_PROOF_SERVICE || 'https://image.thum.io/get/width/1024/';

const CHECK_TIMEOUT_MS = 8000;
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const HISTORY_LIMIT = 50;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let sites = readJson(SITES_FILE, []); // {url, addedAt, status, ms, lastCheckedAt, downSince, history[]}
let scanning = false;
let nextScanAt = null;

const stamp = () => new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

/** Bir siteyi HTTP ile kontrol eder. 2xx/3xx = up, gerisi/erisilememe = down.
 *  Govde okunmaz: stream acilip header'lar alinir alinmaz kapatilir. */
async function httpCheck(url) {
  const started = Date.now();
  try {
    const r = await axios.get(url, {
      timeout: CHECK_TIMEOUT_MS,
      maxRedirects: 3,
      responseType: 'stream',
      headers: { 'User-Agent': 'Watcher/1.0 (uptime monitor)' },
      validateStatus: () => true
    });
    const ms = Date.now() - started;
    r.data.destroy(); // govdeyi indirmeden kapat
    if (r.status >= 200 && r.status < 400) {
      return { status: 'up', ms, reason: `HTTP ${r.status}` };
    }
    return { status: 'down', ms: null, reason: `HTTP ${r.status}` };
  } catch (e) {
    const reason = /timeout/i.test(e.message)
      ? `bağlantı zaman aşımı (${CHECK_TIMEOUT_MS / 1000} sn)`
      : `erişilemedi — ${e.message}`.slice(0, 90);
    return { status: 'down', ms: null, reason };
  }
}

/** Kanit ekran goruntusu: sunucudaki headless Chrome ile (thum.io dis servisi
 *  bizi 403'luyor; dis bagimlilik kaldirildi). Basarisizsa null. */
const { execFile } = require('child_process');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const PROOF_DIR = path.join(DATA_DIR, 'sitewatch-proofs');
const SHOT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537';
const { chromeEnv } = require('./chrometmp');

function captureProof(siteUrl) {
  if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true });
  const out = path.join(PROOF_DIR, `${Date.now()}.png`);
  return new Promise((resolve) => {
    execFile(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--window-size=1366,900', `--user-agent=${SHOT_UA}`,
      // Sayfa agir JS ile gec yukleniyorsa diye: yuk sonrasi render icin
      // sakinlesme butcesi (erken biterse beklemez, gecikirse 3sn tolerans)
      '--timeout=15000', '--virtual-time-budget=3000',
      `--screenshot=${out}`, siteUrl
    ], { timeout: 60000, env: chromeEnv() }, (err) => {
      resolve(err || !fs.existsSync(out) ? null : out);
    });
  });
}

async function tgApi(method, body, isFile = false) {
  if (!TG_TOKEN || !TG_CHAT) return; // token yoksa bildirimler sessizce devre disi
  if (isFile) {
    const FormData = require('form-data');
    const form = new FormData();
    Object.entries(body).forEach(([k, v]) => form.append(k, v));
    return axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, form, {
      headers: form.getHeaders(), timeout: 30000
    });
  }
  return axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, body, { timeout: 15000 });
}

async function tgText(chatId, text) {
  try {
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) { console.warn('[sitewatch-tg] mesaj gidemedi:', e.message); }
}

async function tgPhoto(chatId, photoBuf, caption) {
  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    // Dosya adi/content-type sart; aksi halde Telegram fotoyu reddeder
    // ve bildirim sessizce metne duser (grup gorselsiz kalir).
    form.append('photo', photoBuf, { filename: 'proof.png', contentType: 'image/png' });
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, form, {
      headers: form.getHeaders(), timeout: 30000
    });
    return true;
  } catch (e) {
    console.warn('[sitewatch-tg] foto gidemedi:', e.response?.data?.description || e.message);
    return false;
  }
}

function humanDuration(sinceIso) {
  const sec = Math.max(0, (Date.now() - new Date(sinceIso).getTime()) / 1000);
  if (sec < 60) return `${Math.round(sec)} sn`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} dk`;
  return `${Math.floor(min / 60)} sa ${min % 60} dk`;
}

/** Tarama sonucunu bildirir: UP -> grup+kanit; DOWN -> grup + admin DM. */
async function notifyScanResult(site, result, kind, prevDownSince = null) {
  const label = kind === 'manuel' ? 'manuel tarama' : 'otomatik tarama';
  const isUp = result.status === 'up';
  let caption;
  if (isUp) {
    // downSince recordResult'da null'lanir; kesinti suresi icin ONCEKI deger lazim
    const downRef = prevDownSince || site.downSince;
    const backNote = downRef ? `\n⏱️ Kesinti süresi: ${humanDuration(downRef)}` : '';
    caption = `🟢 <b>UP</b> — ${site.url}\n⚡ Yanıt: ${result.ms} ms\n🔁 Tür: ${label}${backNote}\n🕐 <i>${stamp()}</i>`;
  } else {
    caption = `🔴 <b>DOWN</b> — ${site.url}\n⚠️ Sebep: ${result.reason}\n🔁 Tür: ${label}\n🕐 <i>${stamp()}</i>`;
  }

  let sent = false;
  if (isUp) {
    const proofPath = await captureProof(site.url);
    if (proofPath) {
      sent = await tgPhoto(TG_CHAT, fs.readFileSync(proofPath), caption);
      try { fs.unlinkSync(proofPath); } catch { /* yoksay */ }
    }
  }
  if (!sent) await tgText(TG_CHAT, caption);

  if (!isUp) {
    for (const uid of DM_USERS) {
      await tgText(uid, caption);
    }
  }
}

function recordResult(site, result) {
  site.status = result.status;
  site.ms = result.ms;
  site.lastCheckedAt = new Date().toISOString();
  site.history = site.history || [];
  site.history.push({ at: site.lastCheckedAt, status: result.status, ms: result.ms, reason: result.reason });
  if (site.history.length > HISTORY_LIMIT) site.history = site.history.slice(-HISTORY_LIMIT);
  if (result.status === 'down') {
    if (!site.downSince) site.downSince = site.lastCheckedAt;
  } else {
    site.downSince = null;
  }
}

async function scanSite(site, kind, silent) {
  const result = await httpCheck(site.url);
  const prevStatus = site.status;
  const prevDownSince = site.downSince; // recordResult UP'ta null'luyor
  recordResult(site, result);
  // Boot/sessiz turda mesaj yok; normal turda her site bildirir (orijinal davranis)
  if (!silent) await notifyScanResult(site, result, kind, prevDownSince);
  return { url: site.url, prevStatus, ...result };
}

async function scanAll(kind = 'auto', silent = false) {
  if (scanning) return { skipped: true };
  scanning = true;
  try {
    for (const site of sites) {
      await scanSite(site, kind, silent);
    }
    writeJson(SITES_FILE, sites);
    if (!silent) {
      const up = sites.filter((s) => s.status === 'up').length;
      // Metin durumu dogru soylesin: eksik site varken "tumu ayakta" denmiyordu
      const allUp = up === sites.length;
      await tgText(TG_CHAT, allUp
        ? `✅ <b>Tarama turu tamamlandı</b> — tüm siteler ayakta (${up}/${sites.length})`
        : `⚠️ <b>Tarama turu tamamlandı</b> — ${up}/${sites.length} ayakta, ${sites.length - up} down`);
    }
    return { scanned: sites.length };
  } finally {
    scanning = false;
  }
}

async function scanOne(url, silent = false) {
  const site = sites.find((s) => s.url === url);
  if (!site) return { error: 'site bulunamadi' };
  await scanSite(site, 'manuel', silent);
  writeJson(SITES_FILE, sites);
  return { url, status: site.status, ms: site.ms };
}

async function addSite(url) {
  let u = String(url || '').trim();
  if (!u) return { error: 'url gerekli' };
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  // SSRF korumasi: loopback/RFC1918/link-local/metadata hostlari reddet
  const host = u.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  if (!(await isPublicHost(host))) return { error: 'Bu adres izlenemez (özel/iç ağ adresi)' };
  u = u.replace(/\/+$/, '') + '/';
  if (sites.some((s) => s.url === u)) return { error: 'site zaten izleniyor' };
  const site = { url: u, addedAt: new Date().toISOString(), status: null, ms: null, lastCheckedAt: null, downSince: null, history: [] };
  sites.push(site);
  writeJson(SITES_FILE, sites);
  return { ok: true, site };
}

function removeSite(url) {
  const before = sites.length;
  sites = sites.filter((s) => s.url !== url && s.url !== url.replace(/\/+$/, '') + '/');
  writeJson(SITES_FILE, sites);
  return { ok: sites.length < before };
}

function getState() {
  return {
    sites: sites.map((s) => ({
      url: s.url, status: s.status, ms: s.ms,
      lastCheckedAt: s.lastCheckedAt, downSince: s.downSince,
      history: (s.history || []).slice(-20)
    })),
    nextScanAt,
    scanning
  };
}

function initSitewatch() {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('[sitewatch] TG token/chat tanimli degil; telegram bildirimleri devre disi');
  }
  // Otomatik turlar yarim saat dilimlerine hizali (:00/:30)
  const scheduleNext = () => {
    const now = Date.now();
    const next = Math.ceil(now / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS;
    nextScanAt = new Date(next).toISOString();
    setTimeout(() => {
      scanAll('auto').catch(() => {});
      scheduleNext();
    }, next - now);
  };
  scheduleNext();
  // Boot taramasi sessiz (deploy'da grup spami olmaz — watch.js dersi)
  setTimeout(() => { scanAll('auto', true).catch(() => {}); }, 20000);
  console.log(`[sitewatch] baslatildi (${sites.length} site izleniyor)`);
}

module.exports = { initSitewatch, getState, addSite, removeSite, scanAll, scanOne };
