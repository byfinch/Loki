/**
 * invader.js — Invader Control (Node surumu)
 *
 * PHP/GBWatch'in yerine: siteleri Googlebot + normal kullanici kimligiyle
 * GERCEK Chrome TLS parmak iziyle (curl-impersonate) ceker. PHP surumunun
 * "kullaniciya aciliyor ama bota acilmiyor" yanlis sonuclarinin sebebi ham
 * HTTP istemcisiydi; TLS taklidiyle bot engeli cogunlukla asilir.
 *
 * Veri: data/invader-sites.json  [{ name, url, expect }]
 * Durum: data/invader-state.json { name: { status, ustatus, since } }
 * Bildirim: LOKI_WATCH botuyla sadece Burak'in DM'ine (degisimde).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const SITES_FILE = path.join(DATA_DIR, 'invader-sites.json');
const STATE_FILE = path.join(DATA_DIR, 'invader-state.json');

const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const USER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10dk
const NOTIFY_DM = process.env.INVADER_DM_CHAT || '8849693458'; // Burak
const TG_TOKEN = process.env.INVADER_TG_TOKEN || process.env.LOKI_WATCH_TG_TOKEN || '';

const CURL_IMP = process.env.CURL_IMP || '/opt/curl-imp/curl_chrome150';
const CURL_CACERT = process.env.CURL_CACERT || '/etc/pki/tls/certs/ca-bundle.crt';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const SHOT_DIR = path.join(DATA_DIR, 'invader-shots');

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, d) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(d, null, 2)); fs.renameSync(t, f); };

function curlFetch(url, ua, timeoutSec = 30) {
  return new Promise((resolve) => {
    execFile(CURL_IMP, [
      '--cacert', CURL_CACERT, '-sL', '-A', ua, '--max-time', String(timeoutSec),
      '-o', '-', '-w', '\n%{http_code}', url
    ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ code: 0, body: '', err: err.message });
      const m = /\n(\d{3})$/.exec(stdout || '');
      resolve({ code: m ? parseInt(m[1], 10) : 0, body: m ? stdout.slice(0, -m[0].length) : (stdout || ''), err: err ? err.message : '' });
    });
  });
}

function hostOf(href) {
  href = String(href || '').trim();
  if (!href) return '';
  if (href.startsWith('//')) href = 'https:' + href;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) href = 'https://' + href;
  try { return new URL(href).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function alternatesOf(body) {
  const alts = [];
  for (const m of String(body).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["'][^"']*\balternate\b[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href) { const h = hostOf(href[1]); if (h) alts.push(h); }
  }
  return [...new Set(alts)];
}

function isChallenge(code, body) {
  if (code === 403) return true;
  const b = String(body).toLowerCase();
  return ['just a moment', 'checking your browser', 'attention required', 'cf-browser-verification']
    .some((n) => b.includes(n));
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stamp = () => new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

async function tgDm(message) {
  if (!TG_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: NOTIFY_DM, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });
    return res.ok;
  } catch { return false; }
}

// Ekran goruntusu: headless Chrome ile gercek gorunum (bot/kullanici UA ile)
function captureShot(url, ua, tag) {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const out = path.join(SHOT_DIR, `${Date.now()}-${tag}.png`);
  return new Promise((resolve) => {
    execFile(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--window-size=1366,900', `--user-agent=${ua}`, `--screenshot=${out}`, url
    ], { timeout: 60000 }, (err) => {
      resolve(err || !fs.existsSync(out) ? null : out);
    });
  });
}

async function tgDmPhoto(photoPath, caption) {
  if (!TG_TOKEN) return false;
  try {
    const form = new FormData();
    form.append('chat_id', NOTIFY_DM);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([fs.readFileSync(photoPath)]), path.basename(photoPath));
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(30000)
    });
    return res.ok;
  } catch { return false; }
}

async function checkSite(site) {
  let url = site.url;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const expect = hostOf(site.expect || '');

  const bot = await curlFetch(url, BOT_UA);
  const usr = await curlFetch(url, USER_UA);

  let status, note = '';
  if (bot.code === 0) { status = 'ERROR'; note = bot.err || 'erişilemedi'; }
  else if (isChallenge(bot.code, bot.body)) { status = 'BLOCKED'; note = 'bot koruması (HTTP ' + bot.code + ')'; }
  else {
    const alts = alternatesOf(bot.body);
    if (!expect) {
      status = 'OBSERVED'; note = alts.length ? '' : 'alternate link yok';
    } else {
      const hit = alts.includes(expect) || bot.body.toLowerCase().includes(expect.toLowerCase());
      if (hit) status = 'OK';
      else {
        status = 'DOWN';
        note = alts.length ? 'beklenen yok, alternate: ' + alts.join(', ') : 'beklenen domain sayfada yok';
      }
    }
  }

  let ustatus = 'OK', unote = '';
  if (usr.code === 0) { ustatus = 'ERROR'; unote = usr.err || 'erişilemedi'; }
  else if (isChallenge(usr.code, usr.body)) { ustatus = 'BLOCKED'; unote = 'bot koruması'; }
  else if (usr.code >= 400) { ustatus = 'DOWN'; unote = 'HTTP ' + usr.code; }
  else if (usr.body.length < 512) { ustatus = 'EMPTY'; unote = 'gövde ' + usr.body.length + ' bayt (boş/kısmi)'; }

  return { name: site.name || url, url, expect, status, note, http: bot.code, ustatus, unote };
}

const EMOJI = { OK: '✅', DOWN: '🔴', BLOCKED: '🟡', OBSERVED: '🔵', ERROR: '⚠️', EMPTY: '⚪' };

let state = readJson(STATE_FILE, {});
let timer = null;

async function runChecks() {
  const sites = readJson(SITES_FILE, []);
  if (!sites.length) return;
  const changes = [];
  for (const site of sites) {
    const r = await checkSite(site);
    const prev = state[r.name];
    if (!prev || prev.status !== r.status || prev.ustatus !== r.ustatus) {
      changes.push({ prev, r });
    }
    state[r.name] = { status: r.status, ustatus: r.ustatus, since: new Date().toISOString() };
  }
  writeJson(STATE_FILE, state);

  // Sadece durum degisince bildir (ilk turda da bildir — kayit baslangici)
  if (changes.length) {
    const lines = changes.map(({ prev, r }) =>
      `${EMOJI[r.status] || '❔'} <b>${esc(r.name)}</b>\n` +
      `   bot: ${prev ? prev.status : '—'} → <b>${r.status}</b>${r.note ? ` (${esc(r.note)})` : ''}\n` +
      `   kullanıcı: ${prev ? prev.ustatus : '—'} → <b>${r.ustatus}</b>${r.unote ? ` (${esc(r.unote)})` : ''}` +
      (r.expect ? `\n   beklenen: <code>${esc(r.expect)}</code>` : '')
    );
    await tgDm([`🛡️ <b>Invader Control — durum değişimi</b>`, '─────────────────', ...lines, `🕐 <i>${stamp()}</i>`].join('\n'));
  }
}

function initInvader() {
  const sites = readJson(SITES_FILE, []);
  if (!sites.length) {
    console.log('[invader] site listesi bos (data/invader-sites.json); devre disi');
    return;
  }
  timer = setInterval(() => runChecks().catch((e) => console.warn('[invader]', e.message)), CHECK_INTERVAL_MS);
  setTimeout(() => runChecks().catch((e) => console.warn('[invader]', e.message)), 20000);
  console.log(`[invader] aktif: ${sites.length} site, 10dk aralik, DM: ${NOTIFY_DM}`);
}

// Site basina tek birlesik kanit gorseli: baslik + durum + iki gorunum
// (Googlebot / Kullanici) buyuk etiketli. Metin ozeti ayri mesajda gider.
async function buildSiteCard(r, shotBot, shotUsr) {
  const cell = (p, bigLabel, sub) => p
    ? `<div class="cell"><img src="file://${p}"><div class="lblrow"><span class="big">${bigLabel}</span><span class="sub">${sub}</span></div></div>`
    : `<div class="cell empty">${bigLabel}<br>görüntü alınamadı</div>`;
  const html = `<html><head><meta charset="utf-8"><style>
    body{background:#050705;color:#c9d6cc;font-family:Consolas,monospace;margin:0;padding:28px;width:1350px}
    .top{display:flex;align-items:center;gap:14px;margin-bottom:6px}
    .st{font-weight:700;font-size:20px;padding:6px 18px;border-radius:8px}
    .st-OK{background:rgba(0,255,65,.15);color:#00ff41}
    .st-DOWN{background:rgba(255,68,68,.15);color:#ff6b6b}
    .st-BLOCKED{background:rgba(255,200,0,.15);color:#ffd166}
    .st-OBSERVED{background:rgba(0,200,255,.15);color:#4dd0ff}
    .st-ERROR{background:rgba(255,255,255,.1);color:#ccc}
    h1{color:#e5f5ea;font-size:30px;margin:0}
    .stamp{color:#5d7a64;font-size:13px;margin:4px 0 20px}
    .pair{display:flex;gap:14px}
    .cell{flex:1;border:1px solid rgba(0,255,65,.18);border-radius:10px;background:#0a0f0c;padding:10px}
    .cell img{width:100%;border-radius:6px;display:block;margin-bottom:8px}
    .lblrow{display:flex;align-items:baseline;gap:10px;justify-content:center;padding:6px 0 2px;border-top:1px solid rgba(0,255,65,.15)}
    .big{font-size:17px;font-weight:700;color:#00ff41;letter-spacing:1px}
    .sub{font-size:12px;color:#5d7a64}
    .empty{color:#5d7a64;font-size:14px;padding:40px;text-align:center}
  </style></head><body>
    <div class="top"><span class="st st-${r.status}">${r.status}</span><h1>${esc(r.name)}</h1></div>
    <div class="stamp">bot HTTP ${r.http}${r.note ? ' · ' + esc(r.note) : ''} · kullanıcı: ${r.ustatus}${r.unote ? ' (' + esc(r.unote) + ')' : ''}${r.expect ? ' · beklenen: ' + esc(r.expect) : ''} · ${stamp()}</div>
    <div class="pair">
      ${cell(shotBot, 'GOOGLEBOT', 'arama motorunun gördüğü')}
      ${cell(shotUsr, 'KULLANICI', 'ziyaretçinin gördüğü')}
    </div>
  </body></html>`;
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const reportPath = path.join(SHOT_DIR, `card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.html`);
  fs.writeFileSync(reportPath, html);
  const outPng = reportPath.replace(/\.html$/, '.png');
  await new Promise((resolve) => {
    execFile(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--allow-file-access-from-files', '--window-size=1406,655',
      `--screenshot=${outPng}`, 'file://' + reportPath
    ], { timeout: 60000 }, () => resolve());
  });
  return fs.existsSync(outPng) ? outPng : null;
}

// Manuel test: metin ozeti + her site icin TEK birlesik kart gorseli
async function testAndNotify() {
  const sites = readJson(SITES_FILE, []);
  const results = [];
  for (const site of sites) results.push(await checkSite(site));

  // 1) metin ozeti (temiz tasarim)
  const lines = results.map((r) =>
    `${EMOJI[r.status] || '❔'} <b>${esc(r.name)}</b>\n   🤖 Googlebot: <b>${r.status}</b> (HTTP ${r.http})\n   👤 Kullanıcı: <b>${r.ustatus}</b>` +
    (r.expect ? `\n   🎯 beklenen: <code>${esc(r.expect)}</code>` : '')
  );
  await tgDm([
    `🛡️ <b>Invader Control — tarama sonucu</b>`,
    '─────────────────',
    ...lines,
    '─────────────────',
    `🔍 ${results.length} hedef tarandı`,
    `🕐 <i>${stamp()}</i>`
  ].join('\n'));

  // 2) her site icin tek kart gorseli
  for (const r of results) {
    const shotBot = await captureShot(r.url, BOT_UA, 'bot');
    const shotUsr = await captureShot(r.url, USER_UA, 'usr');
    const card = await buildSiteCard(r, shotBot, shotUsr);
    if (card) await tgDmPhoto(card, `<b>${esc(r.name)}</b>`);
  }
  return results;
}

module.exports = { initInvader, runChecks, testAndNotify };
