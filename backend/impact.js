/**
 * impact.js
 * Etki Monitoru (Faz 1): baslatilan saldirilarin hedefini check-host.net
 * uzerinden seyrek kontrol noktalariyla olcer; sitenin dusup dusmedigini /
 * yavaslayip yavaslamadigini raporlar.
 *
 * Zamanlama:
 * - Normal saldiri: T+15sn, T+10dk, T+30dk, T+60dk; bitiste 1 final olcum.
 * - Loop: T+15sn, T+10dk, T+30dk, T+60dk, sonrasi saatte bir; final yok.
 *
 * check-host.net (ucretsiz, key yok):
 * - L7 -> /check-http?host=H, L4 -> /check-tcp?host=H:P
 * - Sonuc formati (canli dogrulandi):
 *   http: { node: [[ok(0|1), saniye, "OK", "200", ip]] } veya null (timeout)
 *   tcp:  { node: [{ address, time(saniye) }] } veya null (timeout)
 *
 * Bu modul asla throw etmez; tum hatalar console.warn ile gecistirilir.
 */

const TICK_MS = 5000;
const MAX_CONCURRENT_CHECKS = 2;
const POLL_FIRST_DELAY_MS = 6000;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 15000;
const CHECKS_KEEP = 10;
// Biten saldirinin final olcumu panelde bu kadar gorunur kalir, sonra silinir.
const FINAL_RETENTION_MS = 10 * 60 * 1000;
// Saldiri bitis tespitinde server.js cleanup ile ayni tolerans.
const EXPIRY_TOLERANCE_MS = 30 * 1000;

// Sabit seyrek node seti: TR (Istanbul) + yakin Avrupa + US.
const NODES = [
  'tr1.node.check-host.net',
  'de4.node.check-host.net',
  'fr2.node.check-host.net',
  'us1.node.check-host.net'
];

// Kontrol noktasi ofsetleri (ms). Loop'ta son ofsetten sonra saat basi devam.
const CP_15S = 15 * 1000;
const CP_10M = 10 * 60 * 1000;
const CP_30M = 30 * 60 * 1000;
const CP_60M = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BASE_CHECKPOINTS = [CP_15S, CP_10M, CP_30M, CP_60M];

// Takip kayitlari: key -> target
// key: owner|layer|host|port  (ayni hesabin ayni hedefe paralel saldirilari tek olcumde birlesir)
const targets = new Map();
let activeChecks = 0;
let timer = null;
let deps = null;

function warn(...args) {
  console.warn('[impact]', ...args);
}

/**
 * server.js referanslarini baglar ve scheduler'i baslatir.
 * deps: { activeAttacks, activeLoops, sessions, getLoopOwner }
 */
function initImpact({ activeAttacks, activeLoops, sessions, getLoopOwner }) {
  deps = { activeAttacks, activeLoops, sessions, getLoopOwner };
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick().catch((err) => warn('tick hatasi:', err.message));
  }, TICK_MS);
  timer.unref?.();
  console.log('[impact] Etki monitoru baslatildi');
}

// Aktif saldiri/loop kayitlarindan takip edilecek hedef setini cikarir.
// Donus: Map(key -> { key, host, port, layer, isLoop, owner, startedAt, expiresAt|null })
function buildDesiredTargets() {
  const desired = new Map();
  const now = Date.now();

  Object.values(deps.activeAttacks).forEach((a) => {
    if (!a.host) return;
    const expires = new Date(a.expiresAt || 0).getTime();
    if (now - expires > EXPIRY_TOLERANCE_MS) return; // suresi dolmus
    const owner = a.username || deps.sessions[a.sessionId]?.username || null;
    if (!owner) return;
    const layer = a.layer === 'L7' ? 'L7' : 'L4';
    const port = layer === 'L7' ? null : (parseInt(a.port) || null);
    const key = `${owner}|${layer}|${a.host}|${port || ''}`;
    const startedAt = new Date(a.startedAt || Date.now()).getTime();
    const existing = desired.get(key);
    // Ayni hedefe birden cok saldiri varsa en erken baslangici baz al;
    // bitis icin en gec expiresAt'i tut.
    if (existing) {
      existing.startedAt = Math.min(existing.startedAt, startedAt);
      existing.expiresAt = Math.max(existing.expiresAt || 0, expires || 0) || null;
    } else {
      desired.set(key, {
        key, host: a.host, port, layer, isLoop: false, owner,
        startedAt, expiresAt: expires || null
      });
    }
  });

  Object.entries(deps.activeLoops).forEach(([loopId, loop]) => {
    if (!loop || !loop.running) return;
    const host = loop.params?.host;
    if (!host) return;
    const owner = deps.getLoopOwner(loop) || null;
    if (!owner) return;
    const layer = loop.params?.layer === 'L7' ? 'L7' : 'L4';
    const port = layer === 'L7' ? null : (parseInt(loop.params?.port) || null);
    const key = `${owner}|${layer}|${host}|${port || ''}`;
    const startedAt = new Date(loop.startedAt || Date.now()).getTime();
    const existing = desired.get(key);
    if (existing) {
      // Ayni hedef hem normal saldiri hem loop'ta varsa loop olarak isaretle
      // (loop saatte bir olcume devam etsin) ve en erken baslangici koru.
      existing.isLoop = true;
      existing.expiresAt = null;
      existing.startedAt = Math.min(existing.startedAt, startedAt);
    } else {
      desired.set(key, {
        key, host, port, layer, isLoop: true, owner,
        startedAt, expiresAt: null
      });
    }
  });

  return desired;
}

// Siradaki kontrol noktasinin baslangictan itibaren ofseti (ms) veya null.
// Index bazli: kacirilan checkpoint atlanmaz, ilk tick'te telafi edilir.
function checkpointOffset(target, index) {
  if (index < BASE_CHECKPOINTS.length) return BASE_CHECKPOINTS[index];
  if (target.isLoop) {
    // Son baz noktasindan sonra saat basi devam.
    return CP_60M + (index - BASE_CHECKPOINTS.length + 1) * HOUR_MS;
  }
  return null; // normal saldiri: 60dk sonrasi olcum yok (final haric)
}

// check-host sonucunu normalize eder: perNode listesi.
// http: node -> [[ok, saniye, "OK", "200", ip]] | null
// tcp:  node -> [{ address, time }] | null
function parsePerNode(data, layer) {
  const perNode = [];
  for (const node of NODES) {
    const value = data ? data[node] : undefined;
    let ok = false;
    let ms = null;
    let code = null;
    if (Array.isArray(value) && value.length > 0) {
      if (layer === 'L7') {
        const first = value[0];
        if (Array.isArray(first)) {
          ok = first[0] === 1;
          if (typeof first[1] === 'number') ms = Math.round(first[1] * 1000);
          if (first[3] != null) code = String(first[3]);
        }
      } else {
        const first = value[0];
        if (first && typeof first === 'object' && typeof first.time === 'number') {
          ok = true;
          ms = Math.round(first.time * 1000);
        }
      }
    }
    perNode.push({ node, ok, ms, code });
  }
  return perNode;
}

// perNode'dan hedef durumunu hesaplar.
function computeState(perNode, baselineMs) {
  const total = perNode.length;
  const okNodes = perNode.filter((n) => n.ok);
  const okCount = okNodes.length;
  if (total === 0) return { state: 'down', avgMs: null };
  const avgMs = okCount > 0
    ? Math.round(okNodes.reduce((s, n) => s + (n.ms || 0), 0) / okCount)
    : null;
  // Cogu node timeout/hata -> down
  if (okCount * 2 <= total) return { state: 'down', avgMs };
  // Bazi node'lar timeout veya baseline'in 1.5 kati ustu -> degraded
  const slowed = baselineMs != null && avgMs != null && avgMs > baselineMs * 1.5;
  if (okCount < total || slowed) return { state: 'degraded', avgMs };
  return { state: 'up', avgMs };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'LokiImpactMonitor/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Tek hedef icin check-host olcumu yapar (kuyruk + poll). Asla throw etmez.
async function runCheck(target, { final = false } = {}) {
  // Eszamanli istek sinirina saygi: doluysa bir sonraki tick'e birak.
  if (activeChecks >= MAX_CONCURRENT_CHECKS) return false;
  activeChecks++;
  target.checking = true;
  try {
    const checkType = target.layer === 'L7' ? 'check-http' : 'check-tcp';
    const hostParam = target.layer === 'L7'
      ? target.host
      : `${target.host}:${target.port || 80}`;
    const nodeParams = NODES.map((n) => `node=${encodeURIComponent(n)}`).join('&');
    const initUrl = `https://check-host.net/${checkType}?host=${encodeURIComponent(hostParam)}&${nodeParams}`;

    const init = await fetchJson(initUrl);
    const requestId = init && init.request_id;
    if (!requestId) throw new Error('request_id alinamadi');

    // Ilk sonuclar ~5-8sn sonra hazir olur; tum node'lar dolana kadar poll et.
    let data = null;
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? POLL_FIRST_DELAY_MS : POLL_INTERVAL_MS));
      data = await fetchJson(`https://check-host.net/check-result/${requestId}`);
      const resolved = NODES.filter((n) => data && data[n] !== undefined && data[n] !== null).length;
      if (resolved >= NODES.length) break;
    }

    const perNode = parsePerNode(data, target.layer);
    const { state, avgMs } = computeState(perNode, target.baselineMs);
    const at = new Date().toISOString();

    // Baseline: hedefin ilk basarili olcumu.
    if (target.baselineMs == null && avgMs != null) {
      target.baselineMs = avgMs;
    }

    target.checks.push({ at, state, avgMs, perNode, ...(final ? { final: true } : {}) });
    if (target.checks.length > CHECKS_KEEP) {
      target.checks = target.checks.slice(-CHECKS_KEEP);
    }
    target.state = state;
    target.avgMs = avgMs;
    target.perNode = perNode;
    target.lastCheckAt = at;
    console.log(`[impact] ${target.host} (${target.layer}) state=${state} avgMs=${avgMs} final=${final}`);
    return true;
  } catch (err) {
    warn(`olcum basarisiz (${target.host}):`, err.message);
    return false;
  } finally {
    target.checking = false;
    activeChecks--;
  }
}

async function tick() {
  if (!deps) return;
  const now = Date.now();
  const desired = buildDesiredTargets();

  // 1) Yeni hedefleri ekle / mevcutlari guncelle.
  desired.forEach((d, key) => {
    const existing = targets.get(key);
    if (existing) {
      existing.isLoop = d.isLoop;
      existing.expiresAt = d.expiresAt;
      existing.endedAt = null;
    } else {
      targets.set(key, {
        ...d,
        baselineMs: null,
        checks: [],
        state: 'measuring',
        avgMs: null,
        perNode: [],
        lastCheckAt: null,
        nextCheckAt: d.startedAt + CP_15S,
        cpIndex: 0,
        checking: false,
        finalDone: false,
        endedAt: null
      });
    }
  });

  // 2) Aktifligi biten hedefleri isle.
  for (const [key, target] of targets) {
    if (desired.has(key)) continue;
    if (target.isLoop) {
      // Loop durunca takipten kaldir (final olcum yok).
      targets.delete(key);
      continue;
    }
    // Normal saldiri bitti: 1 final olcum yap, sonucu kisa sure sakla.
    if (!target.finalDone && !target.checking) {
      const done = await runCheck(target, { final: true });
      if (done) {
        target.finalDone = true;
        target.endedAt = now;
        target.nextCheckAt = null;
      }
    }
    if (target.finalDone && target.endedAt && now - target.endedAt > FINAL_RETENTION_MS) {
      targets.delete(key);
    }
  }

  // 3) Zamani gelen hedefleri olc.
  for (const target of targets.values()) {
    if (target.finalDone || target.checking) continue;
    if (!desired.has(target.key)) continue;
    const off = checkpointOffset(target, target.cpIndex);
    const next = off == null ? null : target.startedAt + off;
    target.nextCheckAt = next;
    if (next != null && now >= next) {
      const done = await runCheck(target);
      if (done) {
        target.cpIndex++;
        const nextOff = checkpointOffset(target, target.cpIndex);
        target.nextCheckAt = nextOff == null ? null : target.startedAt + nextOff;
      } else {
        // Eszamanlilik limiti veya gecici hata: checkpoint'i atlama, kisa
        // sure sonra tekrar dene.
        target.nextCheckAt = Date.now() + 15000;
      }
    }
  }
}

// Bir hesabin gorebilecegi etki listesi.
function getImpactForUser(username) {
  if (!username) return [];
  const list = [];
  for (const target of targets.values()) {
    if (target.owner !== username) continue;
    list.push({
      key: target.key,
      host: target.host,
      port: target.port,
      layer: target.layer,
      isLoop: target.isLoop,
      state: target.state,
      avgMs: target.avgMs,
      baselineMs: target.baselineMs,
      perNode: target.perNode,
      lastCheckAt: target.lastCheckAt,
      nextCheckAt: target.nextCheckAt,
      final: target.finalDone,
      checks: target.checks.slice(-CHECKS_KEEP)
    });
  }
  // En son olculen ustte
  list.sort((a, b) => new Date(b.lastCheckAt || 0) - new Date(a.lastCheckAt || 0));
  return list;
}

module.exports = { initImpact, getImpactForUser };
