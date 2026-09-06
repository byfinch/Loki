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
// Yeni link bulundugunda etiketlenecek kullanicilar.
// LOKI_WATCH_MENTIONS = "id:ad,id:ad" (or. "8849693458:Burak Yalın")
const MENTIONS = (process.env.LOKI_WATCH_MENTIONS || '')
  .split(',').filter(Boolean)
  .map((e) => {
    const idx = e.indexOf(':');
    return idx > 0 ? { id: e.slice(0, idx).trim(), name: e.slice(idx + 1).trim() } : null;
  })
  .filter(Boolean);
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

let keywords = readJson(KEYWORDS_FILE, []).map((x) =>
  typeof x === 'string' ? { kw: x, label: x } : x
);
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
    for (const k of keywords) {
      if (haystack.includes(k.kw.toLowerCase())) {
        pairs.push({
          site, keyword: k.kw, label: k.label || k.kw,
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
let nextScanAt = null; // bir sonraki otomatik tarama (saat dilimli: :00/:30)

async function scanAll() {
  if (scanning) return;
  scanning = true;
  const now = new Date().toISOString();
  const newPairs = [];
  try {
    const scannedOk = new Set(); // bu turda basariyla taranan siteler
    for (const site of sites) {
      let html = '';
      // Yavas siteler icin: 90sn timeout + tur icinde bir kez tekrar dene
      for (let attempt = 1; attempt <= 2 && !html; attempt++) {
        try {
          const r = await axios.get(`https://${site}`, {
            timeout: 90000, maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
            validateStatus: () => true
          });
          if (r.status >= 400) throw new Error('HTTP ' + r.status);
          html = typeof r.data === 'string' ? r.data : '';
          scannedOk.add(site);
        } catch (e) {
          console.warn(`[watch] ${site} erisilemedi (deneme ${attempt}/2): ${e.message}`);
          if (attempt < 2) await new Promise((r2) => setTimeout(r2, 3000));
        }
      }
      if (!html) continue;
      for (const p of findPairs(html, site)) {
        // Anahtar keyword+href: ayni link baska bir izlenen sitede de cikarsa
        // yeni bulgu SAYILMAZ; bulgunun site listesine eklenir.
        const key = `${p.keyword.toLowerCase()}|${p.href}`;
        const existing = findings.find((f) => f.key === key);
        if (existing) {
          if (!existing.sites) existing.sites = [existing.site];
          if (!existing.sites.includes(site)) existing.sites.push(site);
          existing.site = site; // son goruldugu site (geriye donuk uyum)
          // Yanlis/gercek kaybolma sonrasi geri geldiyse yeni gibi bildir
          if (existing.gone) newPairs.push(p);
          existing.lastSeen = now; existing.gone = false;
        } else {
          findings.push({ key, ...p, sites: [site], firstSeen: now, lastSeen: now, gone: false });
          newPairs.push(p);
        }
      }
    }
    // Kaybolan ikililer: bulgunun goruldugu TUM siteler bu turda basariyla
    // taranmis olmali VE link hicbirinde bulunmamis olmali. Tek bir site bile
    // acilamadiysa "kaldirildi" denmez (orada hala duruyor olabilir).
    const gonePairs = [];
    for (const f of findings) {
      const fSites = f.sites || [f.site];
      const allScanned = fSites.every((s) => scannedOk.has(s));
      if (!f.gone && allScanned && f.lastSeen !== now) {
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

    // Degisiklik-odakli bildirim: yeni/kaldirilan varsa SADECE onlar
    // listelenir; hic degisiklik yoksa tek satirlik "temiz" notu gider.
    const linkOf = (href) => {
      const domain = href.replace(/^https?:\/\//i, '').split('/')[0] || href;
      return `<a href="${esc(href)}">${esc(domain)}</a>`;
    };
    // Label her zaman GUNCEL keyword listesinden cozulur (bulgu eski
    // formatta kayitli olabilir; keyword'e sonradan label verilebilir).
    const labelOf = (kw) => {
      const k = keywords.find((x) => x.kw.toLowerCase() === String(kw).toLowerCase());
      return (k && k.label) || kw;
    };
    const activePairs = findings.filter((f) => !f.gone);

    let msg;
    if (!newPairs.length && !gonePairs.length) {
      // Temiz tur: liste yok, tek not
      msg = [
        `✅ <b>LOKI — TARAMA TEMİZ</b>`,
        '─────────────────',
        `🔍 ${scannedOk.size}/${sites.length} site tarandı · değişiklik yok`,
        `🕐 <i>${stamp()}</i>`
      ];
    } else {
      msg = [`🟢 <b>LOKI — TARAMA SONUCU</b>`, '─────────────────'];
      if (newPairs.length) {
        msg.push(`🆕 <b>Yeni:</b>`);
        msg.push(...groupByKw(newPairs).slice(0, 40).map((p) =>
          p === null ? '───' : `🔗 <code>${esc(labelOf(p.keyword))}</code> → ${linkOf(p.href)}`
        ));
      }
      if (gonePairs.length) {
        msg.push('─────────────────', `⛔ <b>Kaldırılan:</b>`);
        msg.push(...groupByKw(gonePairs).slice(0, 20).map((p) =>
          p === null ? '───' : `⛔ <code>${esc(labelOf(p.keyword))}</code> → ${linkOf(p.href)}`
        ));
      }
      msg.push('─────────────────', `🔍 ${scannedOk.size}/${sites.length} site tarandı · ${activePairs.length} aktif ikili (${newPairs.length} yeni, ${gonePairs.length} kaldırılan)`, `🕐 <i>${stamp()}</i>`);
    }
    // Degisiklik varsa kayitli kullanicilari etiketle
    if ((newPairs.length || gonePairs.length) && MENTIONS.length) {
      msg.push('👥 ' + MENTIONS.map((m) => `<a href="tg://user?id=${m.id}">${esc(m.name)}</a>`).join(' '));
    }
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
  // Otomatik turlar saat dilimlerine hizali: :00 ve :30 (09:00, 09:30, 10:00...)
  const scheduleNext = () => {
    const now = Date.now();
    const next = Math.ceil(now / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS;
    nextScanAt = new Date(next).toISOString();
    setTimeout(() => {
      // Baska tarama suruyorsa kuyruga al (basmaya kalkmaz)
      if (scanning) queuedAuto = true;
      else scanAll().catch(() => {});
      scheduleNext();
    }, next - now);
  };
  scheduleNext();
  setTimeout(() => {
    if (scanning) queuedAuto = true; else scanAll().catch(() => {});
  }, 15000);
  console.log(`[watch] Link gozcusu aktif (${sites.length} site, ${keywords.length} keyword, 30dk tarama${TG_TOKEN && TG_CHAT ? ', telegram aktif' : ', telegram devre disi'})`);
}

function getState() {
  return {
    keywords, sites,
    findings: findings.slice().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    scanning, lastScan, lastScanSummary, nextScanAt
  };
}

function addKeyword(k, label) {
  k = String(k || '').trim();
  label = String(label || '').trim() || k;
  if (!k) return { error: 'Boş keyword' };
  if (!keywords.some((x) => x.kw.toLowerCase() === k.toLowerCase())) keywords.push({ kw: k, label });
  writeJson(KEYWORDS_FILE, keywords);
  return { keywords };
}

function removeKeyword(k) {
  keywords = keywords.filter((x) => x.kw.toLowerCase() !== String(k || '').toLowerCase());
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
