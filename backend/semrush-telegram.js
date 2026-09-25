/**
 * semrush-telegram.js — Link Monitor botuna Semrush komut entegrasyonu
 *
 * Kullanici Telegram'da bot'a su komutlari gonderir:
 *   /semrush <domain>              → genel durum + tum backlinkler
 *   /semrush <domain> <keyword>    → anchor'a gore filtrelenmis backlinkler
 *
 * Ornek:
 *   /semrush sabacirc.org
 *   /semrush sabacirc.org freespin
 *
 * Not: Emojiler kaynak kodda GERCEK Unicode karakter olarak yazilmalidir;
 * \U0001F517 gibi escape dizileri Telegram'a ham metin olarak gecer.
 *
 * Bot: LOKI_WATCH_TG_TOKEN (Link Monitor botu)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const WATCH_TOKEN = process.env.LOKI_WATCH_TG_TOKEN || '';
const OFFSET_FILE = path.join(__dirname, 'data', 'semrush-tg-offset.txt');
const SEMRUSH_KEY_FILE = path.join(__dirname, 'data', 'semrush.json');
const API = 'https://api.telegram.org';
const LINK_LIMIT = 25;          // tek raporda listelenecek backlink sayisi
const TG_CHUNK = 3800;          // Telegram 4096 limitine guvenli pay

function getWatchToken() {
  if (WATCH_TOKEN) return WATCH_TOKEN;
  try {
    const eco = fs.readFileSync('/opt/Loki/ecosystem.config.cjs', 'utf8');
    const m = eco.match(/LOKI_WATCH_TG_TOKEN["']?\s*:\s*["']([^"']+)/);
    if (m) return m[1];
  } catch {}
  return '';
}

function getSemrushKey() {
  try {
    return JSON.parse(fs.readFileSync(SEMRUSH_KEY_FILE, 'utf8')).key || '';
  } catch { return ''; }
}

async function tgApi(method, params) {
  const url = `${API}/bot${getWatchToken()}/${method}`;
  const res = await axios.post(url, params, { timeout: 30000 });
  return res.data;
}

function fmt(n) {
  try { return Number(n).toLocaleString('tr-TR'); } catch (e) { return String(n); }
}

// Buyuk sayilari kisa yaz: 10034314 -> 10,0M, 92668 -> 92,7B
function compactNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',') + 'B';
  return String(n);
}

async function semrushApi(endpoint, params) {
  const key = getSemrushKey();
  if (!key) throw new Error('Semrush anahtari yok');
  const p = new URLSearchParams({ ...params, format: 'json' });
  const r = await axios.get(`https://api.semrush.com/apis/v4/backlinks/v1/${endpoint}?${p.toString()}`, {
    headers: { Authorization: `Apikey ${key}` },
    timeout: 45000
  });
  return r.data.data;
}

// Genel durum: authority score + toplam sayilar (overview ucu, 1 istek)
// NOT: overview data'yi NESNE olarak dondurur (links'teki gibi array degil)
async function semrushOverview(target) {
  const d = await semrushApi('overview', { url: target, scope: 'ROOT_DOMAIN' }) || {};
  return {
    score: d.score ?? '-',
    backlinks: d.backlinks_count ?? 0,
    domains: d.domains_count ?? 0,
    follow: d.follows_count ?? 0,
    nofollow: d.nofollows_count ?? 0,
    lost: d.lost_count ?? 0
  };
}

// Backlink listesi; keyword verildiyse anchor'a gore filtreler
async function semrushBacklinks(target, keyword, limit) {
  const params = { url: target, scope: 'ROOT_DOMAIN', limit: String(limit) };
  if (keyword) params.filter = `anchor LIKE '%${keyword.replace(/['\\]/g, '')}%'`;
  const rows = await semrushApi('links', params);
  return (Array.isArray(rows) ? rows : []).map(r => ({
    source_domain: r.source_domain || '?',
    source_url: r.source_url || '',
    anchor: r.anchor || '—',
    domain_score: r.domain_score ?? '?',
    first_seen: (r.first_seen_at || '').slice(0, 10)
  }));
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Rapor metni (HTML parse mode) — SADECE ISYE YARAYAN: genel durum + son 7 gunun yeni yerlesimleri
// Her yeni domain tek satir: kim — DS kac — ne zaman. Anchor listesi ve "..." dolgusu yok.
function buildReport(domain, keyword, ov, rows) {
  // Domain basina tek kayit: en yeni first_seen + en yuksek DS
  const byDomain = new Map();
  for (const r of rows) {
    const g = byDomain.get(r.source_domain);
    if (!g) {
      byDomain.set(r.source_domain, { domain: r.source_domain, ds: r.domain_score, first: r.first_seen });
    } else {
      if (r.first_seen > g.first) g.first = r.first_seen;
      if (Number(r.domain_score) > Number(g.ds)) g.ds = r.domain_score;
    }
  }
  const groups = [...byDomain.values()].sort((a, b) => (b.first || '').localeCompare(a.first || ''));

  // Son 7 gunun yerlesimleri
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const fresh = groups.filter(g => g.first >= weekAgo);
  const freshShown = fresh.slice(0, 10);

  const L = [];
  L.push(`📊 <b>${esc(domain)}</b> — SEMRUSH${keyword ? ` · filtre: ${esc(keyword)}` : ''}`);
  L.push(`⭐ Score <b>${esc(ov.score)}</b> | 🔗 <b>${compactNum(ov.backlinks)}</b> backlink | 🌐 <b>${fmt(ov.domains)}</b> domain`);
  L.push('');
  if (freshShown.length) {
    L.push(`🆕 <b>SON YERLEŞİMLER (7 gün):</b>`);
    for (const g of freshShown) {
      L.push(`• <b>${esc(g.domain)}</b> — DS ${esc(g.ds)} — ${esc((g.first || '').slice(8, 10) + '.' + (g.first || '').slice(5, 7))}`);
    }
  } else {
    L.push(`🆕 Son 7 günde yeni yerleşim yok`);
  }
  L.push('');
  L.push(`📉 Lost: <b>${fmt(ov.lost)}</b> · İlk ${rows.length} link tarandı`);

  // 4096 karakter siniri: satir sinirlarindan parcalara bol
  const text = L.join('\n');
  if (text.length <= TG_CHUNK) return [text];
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const line of L) {
    if (curLen + line.length + 1 > TG_CHUNK && cur.length) {
      chunks.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += line.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

let lastOffset = 0;
try { lastOffset = parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim(), 10) || 0; } catch {}

async function handleCommand(chatId, text) {
  const parts = text.split(/\s+/);
  const domain = parts[1];
  const keyword = parts.slice(2).join(' ');
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '❌ Kullanım:\n/semrush <domain>\n/semrush <domain> <keyword>\n\nÖrnek:\n/semrush sabacirc.org\n/semrush sabacirc.org freespin'
    });
    return;
  }
  await tgApi('sendMessage', { chat_id: chatId, text: `⏳ ${domain}${keyword ? ` (filtre: ${keyword})` : ''} sorgulanıyor...` });
  try {
    // Overview her zaman cekilir; keyword yoksa link listesi de cekilir
    const ov = await semrushOverview(domain);
    const rows = await semrushBacklinks(domain, keyword, LINK_LIMIT);
    if (!rows.length && keyword) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ "${keyword}" anchor'lı backlink bulunamadı (${domain})` });
      return;
    }
    if (!rows.length) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ ${domain} için backlink bulunamadı` });
      return;
    }
    const chunks = buildReport(domain, keyword, ov, rows);
    for (const c of chunks) {
      await tgApi('sendMessage', { chat_id: chatId, text: c, parse_mode: 'HTML', disable_web_page_preview: true });
    }
  } catch (e) {
    const detail = e.response?.data?.message || e.message || 'bilinmeyen hata';
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ Hata: ${esc(detail).slice(0, 200)}` });
  }
}

async function poll() {
  const token = getWatchToken();
  if (!token) return;
  const res = await axios.get(`${API}/bot${token}/getUpdates?offset=${lastOffset}&timeout=25`, { timeout: 30000 });
  const updates = res.data.result || [];
  for (const u of updates) {
    lastOffset = u.update_id + 1;
    const msg = u.message;
    if (!msg || !msg.text) continue;
    const text = msg.text.trim();
    if (!text.startsWith('/semrush')) continue;
    try {
      await handleCommand(msg.chat.id, text);
    } catch (e) {
      console.error('[semrush-tg] komut hatasi:', e.message.slice(0, 80));
    }
  }
  fs.writeFileSync(OFFSET_FILE, String(lastOffset));
}

function startSemrushTelegram() {
  if (!getWatchToken()) return;
  console.log('[semrush-tg] Telegram komut dinleyici basladi');
  setInterval(() => poll().catch(e => console.error('[semrush-tg] poll hatasi:', e.message.slice(0, 60))), 5000);
}

module.exports = { startSemrushTelegram, buildReport, semrushOverview, semrushBacklinks };
