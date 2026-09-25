/**
 * semrush-telegram.js — Link Monitor botuna Semrush komut entegrasyonu
 *
 * Kullanici Telegram'da bot'a su komutlari gonderir:
 *   /semrush <domain>              → tum backlinkler
 *   /semrush <domain> <keyword>    → anchor'a gore filtrelenmis backlinkler
 *
 * Ornek:
 *   /semrush sabacirc.org
 *   /semrush sabacirc.org freespin
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

function getWatchToken() {
  if (WATCH_TOKEN) return WATCH_TOKEN;
  try {
    const env = {};
    const eco = fs.readFileSync('/opt/Loki/ecosystem.config.cjs', 'utf8');
    const m = eco.match(/LOKI_WATCH_TG_TOKEN["\']?\s*:\s*["\']([^"']+)/);
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

async function semrushBacklinks(target, keyword, limit) {
  const key = getSemrushKey();
  if (!key) throw new Error('Semrush anahtari yok');
  const p = new URLSearchParams({ url: target, scope: 'ROOT_DOMAIN', limit: String(limit), format: 'json' });
  if (keyword) p.set('filter', `anchor LIKE '%${keyword.replace(/['\\]/g, '')}%'`);
  const r = await axios.get(`https://api.semrush.com/apis/v4/backlinks/v1/links?${p.toString()}`, {
    headers: { Authorization: `Apikey ${key}` },
    timeout: 45000
  });
  return (r.data.data || []).map(r => ({
    source_domain: r.source_domain || '?',
    source_url: r.source_url || '',
    target_url: r.target_url || '',
    anchor: r.anchor || '-',
    domain_score: r.domain_score || 0,
    is_nofollow: r.is_nofollow || false,
    first_seen: (r.first_seen_at || '').slice(0, 10)
  }));
}

function fmt(n) {
  try { return Number(n).toLocaleString('tr-TR'); } catch { return String(n); }
}

function buildReport(domain, keyword, rows) {
  const L = [];
  L.push(`\u{1F4CB} <b>SEMRUSH \u2014 ${domain}</b>`);
  if (keyword) L.push(`\U0001F50D Filtre: <i>${keyword}</i>`);
  L.push(`\U0001F517 Backlink: <b>${rows.length}</b>`);
  L.append = null; // noop
  L.push('');
  L.push('<b>\u2693 \u00d6RNEK YERLE\u015e\u0130MLER:</b>');
  for (const r of rows.slice(0, 10)) {
    L.push(`\u2022 <b>${r.source_domain}</b>`);
    L.push(`   \u2514 ${r.source_url.slice(0, 60)}`);
    L.push(`   anchor: <i>${r.anchor}</i> | DS: ${r.domain_score} | ${r.first_seen}`);
  }
  return L.join('\n');
}

let lastOffset = 0;
try { lastOffset = parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim(), 10) || 0; } catch {}

async function poll() {
  try {
    const token = getWatchToken();
    if (!token) return;
    const res = await axios.get(`${API}/bot${token}/getUpdates?offset=${lastOffset}&timeout=25`, { timeout: 30000 });
    const updates = res.data.result || [];
    for (const u of updates) {
      lastOffset = u.update_id + 1;
      const msg = u.message;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat.id;
      const text = msg.text.trim();
      if (!text.startsWith('/semrush')) continue;
      const parts = text.split(/\s+/);
      const domain = parts[1];
      const keyword = parts[2] || '';
      if (!domain) {
        await tgApi('sendMessage', { chat_id: chatId, text: '\u274c Kullan\u0131m: /semrush <domain> [keyword]', parse_mode: 'HTML' });
        continue;
      }
      // "Y\u00fckleniyor..." mesaji
      await tgApi('sendMessage', { chat_id: chatId, text: `\u23f3 ${domain}${keyword ? ' / ' + keyword : ''} sorgulan\u0131yor...` });
      try {
        const rows = await semrushBacklinks(domain, keyword, 15);
        if (!rows.length) {
          await tgApi('sendMessage', { chat_id: chatId, text: `\u274c ${domain}${keyword ? ' (' + keyword + ')' : ''} i\u00e7in backlink bulunamad\u0131` });
          continue;
        }
        const L = [];
        L.push(`\u{1F4CB} <b>SEMRUSH \u2014 ${domain}</b>`);
        if (keyword) L.push(`\U0001F50D Filtre: <i>${keyword}</i>`);
        L.push(`\U0001F517 Backlink: <b>${rows.length}</b>`);
        L.push('');
        for (const r of rows.slice(0, 10)) {
          L.push(`\u2022 <b>${r.source_domain}</b>`);
          L.push(`   \u2514 ${r.source_url.slice(0, 60)}`);
          L.push(`   anchor: <i>${r.anchor || '-'}</i> | DS: ${r.domain_score} | ilk: ${r.first_seen}`);
        }
        if (rows.length > 10) L.push(`   ... +${rows.length - 10} satir daha`);
        await tgApi('sendMessage', { chat_id: chatId, text: L.join('\n'), parse_mode: 'HTML' });
      } catch (e) {
        await tgApi('sendMessage', { chat_id: chatId, text: `\u274c Hata: ${e.message.slice(0, 80)}` });
      }
    }
    fs.writeFileSync(OFFSET_FILE, String(lastOffset));
  } catch (e) {
    console.error('[semrush-tg] poll hatasi:', e.message.slice(0, 80));
  }
}

function startSemrushTelegram() {
  if (!getWatchToken()) return;
  console.log('[semrush-tg] Telegram komut dinleyici basladi');
  setInterval(() => poll().catch(e => console.error('[semrush-tg]', e.message.slice(0, 60))), 5000);
}

module.exports = { startSemrushTelegram };
