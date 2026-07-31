/**
 * phish.js
 * PhishGuard SQLite veritabanina read-only erisim katmani.
 *
 * Veritabani dosyasi yoksa veya better-sqlite3 kurulu degilse modul
 * sessizce "devre disi" moda gecer; endpoint'ler bu durumda 503 doner,
 * sunucu calismaya devam eder.
 *
 * Semanin sahibi PhishGuard'dir (app/db/models.py). Burada sadece okuma yapilir.
 * Kullanilan kolonlar:
 *   alerts  : id, seq_no, keyword_id, registrable_domain, url, rank, score,
 *             level ('COK_YUKSEK'|'YUKSEK'|'ORTA'|'DUSUK'), created_at_utc, run_id
 *   keywords: id, brand_id, term
 *   brands  : id, slug
 *   runs    : id, started_at, finished_at, status
 * Tarih formati: 'YYYY-MM-DD HH:MM:SS UTC' (ilk 19 char ISO uyumlu).
 */

// better-sqlite3 native modul; VPS'te kurulur. Kurulu degilse sunucu yine de bootsun.
let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  Database = null;
}

const DB_PATH = process.env.LOKI_PHISH_DB_PATH || '/opt/phishguard/data/phishguard.db';
const MAX_LIMIT = 200;

let db = null;
let disabledReason = null;

function initDb() {
  if (!Database) {
    disabledReason = 'better-sqlite3 modulu kurulu degil';
    console.warn(`[phish] Devre disi: ${disabledReason}`);
    return;
  }
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: false });
    // Semayi yokla: alerts tablosu yoksa entegrasyonu devre disi birak
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alerts'")
      .get();
    if (!table) {
      disabledReason = `alerts tablosu bulunamadi (${DB_PATH})`;
      console.warn(`[phish] Devre disi: ${disabledReason}`);
      db.close();
      db = null;
      return;
    }
    console.log(`[phish] PhishGuard DB bagli: ${DB_PATH}`);
  } catch (err) {
    disabledReason = err.message;
    console.warn(`[phish] Devre disi: DB acilamadi (${DB_PATH}): ${err.message}`);
    db = null;
  }
}

initDb();

function isEnabled() {
  return db !== null;
}

function getDisabledReason() {
  return disabledReason;
}

// Skora gore band hesabi (PhishGuard RISK_BANDS ile ayni esikler: 85/60/40).
// level kolonu zaten kanonik degeri tutuyor; eksik/bilinmeyen degerlerde skora dus.
const LEVEL_TO_BAND = {
  COK_YUKSEK: 'critical',
  YUKSEK: 'high',
  ORTA: 'medium',
  DUSUK: 'low'
};
const BAND_TO_LEVEL = {
  critical: 'COK_YUKSEK',
  high: 'YUKSEK',
  medium: 'ORTA',
  low: 'DUSUK'
};

function scoreToBand(score) {
  if (score >= 85) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function rowToAlert(row) {
  return {
    id: row.seq_no,
    domain: row.registrable_domain,
    url: row.url,
    title: row.title,
    rank: row.rank,
    score: row.score,
    band: LEVEL_TO_BAND[row.level] || scoreToBand(row.score),
    brand: row.brand_slug || null,
    keyword: row.keyword_term || null,
    createdAt: row.created_at_utc
  };
}

/**
 * Uyari listesi: en yeni -> eski.
 * Filtreler: brand (brands.slug), band ('critical'|'high'|'medium'|'low').
 */
function getAlerts({ limit = 50, offset = 0, brand = null, band = null } = {}) {
  if (!isEnabled()) return { alerts: [], total: 0 };

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_LIMIT);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const where = [];
  const params = {};
  if (brand) {
    where.push('b.slug = @brand');
    params.brand = brand;
  }
  if (band && BAND_TO_LEVEL[band]) {
    where.push('a.level = @level');
    params.level = BAND_TO_LEVEL[band];
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const baseSql = `
    FROM alerts a
    LEFT JOIN keywords k ON k.id = a.keyword_id
    LEFT JOIN brands b ON b.id = k.brand_id
    ${whereSql}`;

  const total = db.prepare(`SELECT COUNT(*) AS c ${baseSql}`).get(params).c;
  const rows = db
    .prepare(
      `SELECT a.seq_no, a.registrable_domain, a.url, a.title, a.rank, a.score,
              a.level, a.created_at_utc, b.slug AS brand_slug, k.term AS keyword_term
       ${baseSql}
       ORDER BY a.seq_no DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: safeLimit, offset: safeOffset });

  return { alerts: rows.map(rowToAlert), total };
}

/**
 * Genel istatistikler: toplam, son 24 saat, band ve marka dagilimi, son tarama.
 */
function getStats() {
  if (!isEnabled()) return null;

  const total = db.prepare('SELECT COUNT(*) AS c FROM alerts').get().c;
  // created_at_utc formati 'YYYY-MM-DD HH:MM:SS UTC'; ilk 19 char ISO uyumlu
  const last24h = db
    .prepare(
      "SELECT COUNT(*) AS c FROM alerts WHERE substr(created_at_utc, 1, 19) >= datetime('now', '-24 hours')"
    )
    .get().c;

  const bandRows = db
    .prepare('SELECT level, COUNT(*) AS c FROM alerts GROUP BY level')
    .all();
  const bands = { critical: 0, high: 0, medium: 0, low: 0 };
  bandRows.forEach((row) => {
    const band = LEVEL_TO_BAND[row.level] || 'low';
    bands[band] += row.c;
  });

  const brands = db
    .prepare(
      `SELECT b.slug AS slug, COUNT(*) AS c
       FROM alerts a
       JOIN keywords k ON k.id = a.keyword_id
       JOIN brands b ON b.id = k.brand_id
       GROUP BY b.slug
       ORDER BY c DESC
       LIMIT 10`
    )
    .all();

  let lastRun = null;
  try {
    lastRun = db
      .prepare(
        'SELECT id, started_at, finished_at, status FROM runs ORDER BY id DESC LIMIT 1'
      )
      .get();
  } catch (err) {
    // runs tablosu yoksa son tarama bilgisi olmadan devam et
    lastRun = null;
  }

  return {
    total,
    last24h,
    bands,
    topBrands: brands.map((r) => ({ brand: r.slug, count: r.c })),
    lastRun: lastRun
      ? {
          id: lastRun.id,
          startedAt: lastRun.started_at,
          finishedAt: lastRun.finished_at,
          status: lastRun.status
        }
      : null
  };
}

module.exports = { isEnabled, getDisabledReason, getAlerts, getStats };
