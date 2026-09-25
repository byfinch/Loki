/**
 * semrush.js — Semrush API v4 entegrasyonu (Backlinks + Overview)
 *
 * Anahtar: env LOKI_SEMRUSH_KEY veya backend/data/semrush.json {"key":"..."}
 * Auth: Authorization: Apikey <KEY> basligi
 * Uc baz maliyet: overview 45 unit, backlinks 45 unit/satir
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const KEY_FILE = path.join(__dirname, 'data', 'semrush.json');
const BASE = 'https://api.semrush.com/apis/v4/backlinks/v1';

function getKey() {
  if (process.env.LOKI_SEMRUSH_KEY) return process.env.LOKI_SEMRUSH_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    return cfg.key || '';
  } catch {
    return '';
  }
}

function isConfigured() {
  return Boolean(getKey());
}

async function call(endpoint, params) {
  const key = getKey();
  if (!key) throw new Error('Semrush API anahtari tanimli degil');
  const res = await axios.get(`${BASE}/${endpoint}`, {
    params,
    headers: { Authorization: `Apikey ${key}` },
    timeout: 30000
  });
  return res.data;
}

const SCOPES = ['ROOT_DOMAIN', 'SUBDOMAIN', 'SUBFOLDER', 'PAGE'];

function normScope(scope) {
  return SCOPES.includes(String(scope).toUpperCase()) ? String(scope).toUpperCase() : 'ROOT_DOMAIN';
}

/** Backlink listesi. opts: {scope, limit, offset, anchor, orderBy, direction} */
async function backlinks(target, opts = {}) {
  const p = {
    url: target,
    scope: normScope(opts.scope),
    limit: Math.min(parseInt(opts.limit, 10) || 25, 200),
    format: 'json'
  };
  if (opts.offset) p.offset = parseInt(opts.offset, 10);
  if (opts.orderBy) p.order_by = String(opts.orderBy);
  if (opts.direction) p.direction = String(opts.direction);
  if (opts.anchor) p.filter = `anchor LIKE '%${String(opts.anchor).replace(/['\\]/g, '')}%'`;
  const data = await call('links', p);
  return {
    total: data.meta?.total ?? (data.data || []).length,
    rows: (data.data || []).map((r) => ({
      source_url: r.source_url,
      source_domain: r.source_domain,
      source_title: r.source_title,
      anchor: r.anchor,
      target_url: r.target_url,
      domain_score: r.domain_score,
      page_score: r.page_score,
      is_nofollow: r.is_nofollow,
      is_lost: r.is_lost,
      is_new: r.is_new,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at
    }))
  };
}

/** Ozet metrikler (backlinks_count, score, ...) */
async function overview(target, scope) {
  const data = await call('overview', { url: target, scope: normScope(scope), format: 'json' });
  return data.data || {};
}

/** Referring domainlar */
async function refDomains(target, opts = {}) {
  const data = await call('ref-domains', {
    url: target,
    scope: normScope(opts.scope),
    limit: Math.min(parseInt(opts.limit, 10) || 25, 200),
    format: 'json'
  });
  return (data.data || []).map((r) => ({
    domain: r.domain,
    domain_score: r.domain_score,
    backlinks_count: r.backlinks_count,
    country: r.country,
    is_follow: r.is_follow
  }));
}

module.exports = { backlinks, overview, refDomains, isConfigured, getKey, normScope, SCOPES };
