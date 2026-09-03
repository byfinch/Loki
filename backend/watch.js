/**
 * watch.js — Link Gözcüsü (keyword->link izleme)
 *
 * Izlenen sitelerin HTML'inde keyword'leri arar, keyword->link ikililerini
 * cikarir. Saatlik tarama; yeni ikili ve kaybolan ikili ayri Telegram
 * grubuna bildirilir (LOKI_WATCH_TG_TOKEN / LOKI_WATCH_TG_CHAT).
 *
 * Veriler backend/data/watch-*.json dosyalarinda tutulur (Loki kalibi).
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const KEYWORDS_FILE = path.join(DATA_DIR, 'watch-keywords.json');
const SITES_FILE = path.join(DATA_DIR, 'watch-sites.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'watch-findings.json');

const TG_TOKEN = process.env.LOKI_WATCH_TG_TOKEN || '';
const TG_CHAT = process.env.LOKI_WATCH_TG_CHAT || '';
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // yarim saatte bir

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let keywords = readJson(KEYWORDS_FILE, []);
let sites = readJson(SITES_FILE, []);
let findings = readJson(FINDINGS_FILE, []); // {key, site, keyword, anchor, href, firstSeen, lastSeen, gone}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stamp = () => new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

async function tg(message) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT, text: message, parse_mode: 'HTML', disable_web_page_preview: true
    }, { timeout: 10000 });
  } catch (e) { console.warn('[watch-tg] gonderilemedi:', e.message); }
}

function findPairs(html, site) {
  const pairs = [];
  const anchorRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const href = m[1];
    const inner = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const titleMatch = m[0].match(/title=["']([^"']+)["']/i);
    const haystack = `${titleMatch ? titleMatch[1] : ''} ${inner}`.toLowerCase();
    for (const kw of keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        pairs.push({
          site, keyword: kw,
          anchor: (titleMatch ? titleMatch[1] : inner).slice(0, 120),
          href: href.slice(0, 300)
        });
        break;
      }
    }
  }
  return pairs;
}

let scanning = false;
// Otomatik tarama, manuel tarama surerken geldiyse: manuel bitene kadar
// bekler, sonra kendi turunu calistirir (tikama/cakisma olmaz).
let queuedAuto = false;
let lastScan = null;
let lastScanSummary = null;

async function scanAll() {
  if (scanning) return;
  scanning = true;
  const now = new Date().toISOString();
  const newPairs = [];
  try {
    const scannedOk = new Set(); // bu turda basariyla taranan siteler
    for (const site of sites) {
      let html = '';
      try {
        const r = await axios.get(`https://${site}`, {
          timeout: 45000, maxRedirects: 5,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
          validateStatus: () => true
        });
        if (r.status >= 400) throw new Error('HTTP ' + r.status);
        html = typeof r.data === 'string' ? r.data : '';
        scannedOk.add(site);
      } catch (e) {
        // Site acilmadi: bu siteye ait bulgulara dokunma (kayboldu sayilamaz)
        console.warn(`[watch] ${site} erisilemedi: ${e.message}`);
        continue;
      }
      for (const p of findPairs(html, site)) {
        const key = `${site}|${p.keyword.toLowerCase()}|${p.href}`;
        const existing = findings.find((f) => f.key === key);
        if (existing) {
          // Yanlis/gercek kaybolma sonrasi geri geldiyse yeni gibi bildir
          if (existing.gone) newPairs.push(p);
          existing.lastSeen = now; existing.gone = false;
        } else {
          findings.push({ key, ...p, firstSeen: now, lastSeen: now, gone: false });
          newPairs.push(p);
        }
      }
    }
    // Kaybolan ikililer: YALNIZCA bu turda basariyla taranan sitelere ait,
    // o turda gorulmemis bulgular. Site acilmadiysa bulgulari es geç.
    const gonePairs = [];
    for (const f of findings) {
      if (!f.gone && scannedOk.has(f.site) && f.lastSeen !== now) {
        f.gone = true;
        gonePairs.push(f);
      }
    }
    writeJson(FINDINGS_FILE, findings);
    lastScan = now;
    lastScanSummary = {
      sites: sites.length, keywords: keywords.length,
      total: findings.filter((f) => !f.gone).length,
      new: newPairs.length, gone: gonePairs.length
    };

    // Bildirim satirlari keyword'e gore gruplanir: bir keyword'un tum
    // sonuclari arka arkaya gelir; keyword gecislerinde ayirac konur.
    const groupByKw = (pairs) => {
      const order = [...new Set(pairs.map((p) => p.keyword.toLowerCase()))];
      const lines = [];
      order.forEach((kw, i) => {
        if (i > 0) lines.push(null); // ayirac
        for (const p of pairs.filter((x) => x.keyword.toLowerCase() === kw)) {
          lines.push(p);
        }
      });
      return lines;
    };

    // Her tarama sonucu bildirir: aktif ikililer keyword gruplu listelenir,
    // bu turda ilk kez bulunanlar 🆕 ile isaretlenir.
    const newKeys = new Set(newPairs.map((p) => `${p.site}|${p.keyword.toLowerCase()}|${p.href}`));
    const activePairs = findings.filter((f) => !f.gone);
    const lines = groupByKw(activePairs).slice(0, 60).map((p) => {
      if (p === null) return '───';
      const isNew = newKeys.has(p.key);
      return `${isNew ? '🆕' : '🔗'} <code>${esc(p.keyword)}</code> → <code>${esc(p.href)}</code>${isNew ? ' <b>(YENİ)</b>' : ''}`;
    });
    const msg = [`🟢 <b>LOKI — TARAMA SONUCU</b>`, '─────────────────'];
    if (lines.length) msg.push(...lines);
    else msg.push('<i>bulgu yok</i>');
    if (gonePairs.length) {
      msg.push('─────────────────', `⛔ <b>Kaldırılan:</b>`);
      msg.push(...groupByKw(gonePairs).slice(0, 20).map((p) =>
        p === null ? '───' : `⛔ <code>${esc(p.keyword)}</code> → <code>${esc(p.href)}</code>`
      ));
    }
    msg.push('─────────────────', `🔍 ${scannedOk.size}/${sites.length} site tarandı · ${activePairs.length} aktif ikili (${newPairs.length} yeni, ${gonePairs.length} kaldırılan)`, `🕐 <i>${stamp()}</i>`);
    await tg(msg.join('\n'));
  } finally {
    scanning = false;
    // Otomatik tur bekliyorduysa simdi calistir
    if (queuedAuto) {
      queuedAuto = false;
      setTimeout(() => scanAll().catch(() => {}), 1000);
    }
  }
}

function initWatch() {
  // Otomatik tur: baska tarama suruyorsa kuyruga al (basmaya kalkmaz)
  setInterval(() => {
    if (scanning) { queuedAuto = true; return; }
    scanAll().catch(() => {});
  }, SCAN_INTERVAL_MS);
  setTimeout(() => {
    if (scanning) queuedAuto = true; else scanAll().catch(() => {});
  }, 15000);
  console.log(`[watch] Link gozcusu aktif (${sites.length} site, ${keywords.length} keyword, 30dk tarama${TG_TOKEN && TG_CHAT ? ', telegram aktif' : ', telegram devre disi'})`);
}

function getState() {
  return {
    keywords, sites,
    findings: findings.slice().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    scanning, lastScan, lastScanSummary
  };
}

function addKeyword(k) {
  k = String(k || '').trim();
  if (!k) return { error: 'Boş keyword' };
  if (!keywords.some((x) => x.toLowerCase() === k.toLowerCase())) keywords.push(k);
  writeJson(KEYWORDS_FILE, keywords);
  return { keywords };
}

function removeKeyword(k) {
  keywords = keywords.filter((x) => x.toLowerCase() !== String(k || '').toLowerCase());
  writeJson(KEYWORDS_FILE, keywords);
  return { keywords };
}

function addSite(raw) {
  // Kullanici tam URL de yapistirabilir: domain'i ayikla (protokol, path, www. atilir)
  let s = String(raw || '').trim().replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return { error: 'Geçersiz domain' };
  if (!sites.includes(s)) sites.push(s);
  writeJson(SITES_FILE, sites);
  return { sites };
}

function removeSite(s) {
  sites = sites.filter((x) => x !== s);
  writeJson(SITES_FILE, sites);
  return { sites };
}

// Manuel tarama: baska tarama suruyorsa baslatmaz (false doner).
function triggerScan() {
  if (scanning) return false;
  scanAll().catch(() => {});
  return true;
}

module.exports = { initWatch, getState, addKeyword, removeKeyword, addSite, removeSite, triggerScan };
