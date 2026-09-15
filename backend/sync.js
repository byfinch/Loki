/**
 * sync.js — Senkron Tur Koordinatoru
 *
 * Secili loop'lari tek paylasilan saatle calistirir: ayni anda basla,
 * ayni anda bitir, ayni anda tekrar basla. Kullanicinin girdigi sure senkron
 * boyunca loop'larin SALDIRI SURESI olur (loop.syncTime); senkron bozulunca
 * loop'lar kendi params.time degerlerine doner.
 *
 * stresse dostu tasarim:
 * - Kademeli atesleme (launch'lar 400sn aralikla) — sert burst yok.
 * - Grup asla toplu retry yapmaz (firtina deseni olusmaz); hatali loop kendi
 *   backoff'unu ceker, saat sasilmadan sonraki turda yakalar.
 * - Kapasite on-kontrolu: hesap basina toplam concurrents plan limitini asmaz.
 *
 * Gruplar backend/data/sync-groups.json'da kalici; restart'ta geri yuklenir.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const GROUPS_FILE = path.join(DATA_DIR, 'sync-groups.json');

const STAGGER_MS = 400; // launch'lar arasi bosluk (burst yumusatma)

let deps = null;           // { activeLoops, sessions, getLoopOwner, fireLoopRound, runLoop, saveState, activeLoopRounds, waitLoopsDrained }
let groups = {};           // { id: { loopIds, time, createdAt, roundCount, timer } }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function persistGroups() {
  const out = {};
  Object.entries(groups).forEach(([id, g]) => {
    out[id] = { loopIds: g.loopIds, time: g.time, createdAt: g.createdAt, roundCount: g.roundCount };
  });
  writeJson(GROUPS_FILE, out);
}

/** Senkron tur: gruptaki tum loop'lari kademeli atesle (400sn aralikla). */
async function syncTick(groupId) {
  const g = groups[groupId];
  if (!g) return;
  const runningIds = g.loopIds.filter((id) => deps.activeLoops[id]?.running);
  if (runningIds.length === 0) {
    console.log(`[sync ${groupId}] grupta calisan loop kalmadi, koordinator duruyor`);
    clearTimeout(g.timer);
    delete groups[groupId];
    persistGroups();
    return;
  }
  g.roundCount += 1;
  console.log(`[sync ${groupId}] tur ${g.roundCount}: ${runningIds.length} loop atesleniyor (${g.time}s)`);
  // Faz 1 — paralel drain: tum loop'larin onceki tur saldirilari upstream'den
  // dusene kadar birlikte bekle (hesap basina tek poll). Sirayla beklemek
  // ilk loop'un atesini geciktirip hizayi bozardi; bu sekilde atesleme ani
  // tum loop'lar icin ayni kalir.
  if (deps.waitLoopsDrained) {
    await deps.waitLoopsDrained(runningIds, 90000);
  }
  for (const loopId of runningIds) {
    // Bagimsiz turu hala havada olan loop'u bu turda atla: ayni loop'un iki
    // turu ust uste binip slot tuketimini ikiye katlamasin (senkron baslarken
    // kuyruktaki son tur henuz bitmemis olabilir). Saat sasilmaz; loop
    // sonraki turda yakalar.
    if (deps.activeLoopRounds?.has(loopId)) {
      console.log(`[sync ${groupId}] ${loopId} onceki turu hala calisiyor, bu tur atlaniyor`);
      continue;
    }
    try {
      await deps.fireLoopRound(loopId);
    } catch (err) {
      console.error(`[sync ${groupId}] ${loopId} tur hatasi:`, err.message);
      // Grup asla toplu retry yapmaz; hatali loop kendi backoff'unda, saat devam eder.
    }
    await new Promise((r) => setTimeout(r, STAGGER_MS));
  }
  persistGroups();
  g.timer = setTimeout(() => syncTick(groupId).catch((e) => console.error(`[sync ${groupId}] tick hatasi:`, e)), g.time * 1000);
}

/** Kapasite kontrolu: hesap basina toplam concurrents plan limitini asmamali. */
function validateCapacity(loopIds) {
  const byOwner = {};
  for (const loopId of loopIds) {
    const loop = deps.activeLoops[loopId];
    if (!loop || !loop.running) return { ok: false, message: `Loop bulunamadı veya çalışmıyor: ${loopId}` };
    const owner = deps.getLoopOwner(loop) || 'bilinmiyor';
    byOwner[owner] = (byOwner[owner] || 0) + (parseInt(loop.params?.concurrents) || 1);
  }
  for (const [owner, total] of Object.entries(byOwner)) {
    // Plan limitini herhangi bir oturumdan coz (fallback 80)
    let limit = 80;
    for (const s of Object.values(deps.sessions)) {
      if (s?.username === owner && s?.plan?.Concurrents) { limit = parseInt(s.plan.Concurrents, 10) || limit; break; }
    }
    if (total > limit) {
      return { ok: false, message: `Senkron kapasitesi aşıldı: ${owner} toplam ${total}/${limit} concurrents. Bazı loop'ları çıkar veya adetleri düşür.` };
    }
  }
  return { ok: true };
}

/** Senkron grup baslat. loopIds: secili loop'lar, time: ortak tur suresi (sn). */
function startGroup(loopIds, time) {
  if (!Array.isArray(loopIds) || loopIds.length < 2) {
    return { error: 'Senkron için en az 2 loop seçmelisin' };
  }
  const t = parseInt(time, 10);
  if (!Number.isFinite(t) || t < 10) return { error: 'Geçerli bir süre gir (en az 10 saniye)' };
  const cap = validateCapacity(loopIds);
  if (!cap.ok) return { error: cap.message };

  const id = `sync_${Date.now()}`;
  groups[id] = { loopIds: [...loopIds], time: t, createdAt: new Date().toISOString(), roundCount: 0, timer: null };
  loopIds.forEach((loopId) => {
    const loop = deps.activeLoops[loopId];
    // syncTime: senkron suresince loop'un saldiri suresi BU deger olur —
    // kullanicinin girdigi sure baslangic/bitis hizasinin temelidir.
    if (loop) { loop.syncGroup = id; loop.syncTime = t; }
  });
  persistGroups();
  deps.saveState();
  console.log(`[sync ${id}] ${loopIds.length} loop senkronize edildi (tur: ${t}s)`);
  // Ilk tur hemen ateslenir, sonrasi saat diliminde
  syncTick(id).catch((e) => console.error(`[sync ${id}] ilk tur hatasi:`, e));
  return { ok: true, groupId: id };
}

/** Senkronu boz: loop'lar bagimsiz saatlerine doner. */
function stopGroup(groupId) {
  const g = groups[groupId];
  if (!g) return { error: 'senkron grup bulunamadi' };
  clearTimeout(g.timer);
  g.loopIds.forEach((loopId) => {
    const loop = deps.activeLoops[loopId];
    if (loop && loop.running) {
      delete loop.syncGroup;
      delete loop.syncTime;
      deps.runLoop(loopId).catch(() => {});
    }
  });
  delete groups[groupId];
  persistGroups();
  deps.saveState();
  console.log(`[sync ${groupId}] senkron bozuldu`);
  return { ok: true };
}

/** Tek loop'u senkrondan cikar (digerleri senkronlu kalir). */
function removeLoop(loopId) {
  for (const [id, g] of Object.entries(groups)) {
    if (!g.loopIds.includes(loopId)) continue;
    g.loopIds = g.loopIds.filter((x) => x !== loopId);
    const loop = deps.activeLoops[loopId];
    if (loop) {
      delete loop.syncGroup;
      delete loop.syncTime;
      if (loop.running) deps.runLoop(loopId).catch(() => {});
    }
    if (g.loopIds.length < 2) {
      stopGroup(id);
    } else {
      persistGroups();
    }
    deps.saveState();
    return { ok: true };
  }
  return { error: 'loop senkronda degil' };
}

function getGroupOf(loopId) {
  for (const [id, g] of Object.entries(groups)) {
    if (g.loopIds.includes(loopId)) return { id, time: g.time, size: g.loopIds.length };
  }
  return null;
}

function getState() {
  return Object.entries(groups).map(([id, g]) => ({
    id, loopIds: g.loopIds, time: g.time, createdAt: g.createdAt, roundCount: g.roundCount
  }));
}

function initSync(d) {
  deps = d;
  const saved = readJson(GROUPS_FILE, {});
  Object.entries(saved).forEach(([id, g]) => {
    const validIds = (g.loopIds || []).filter((loopId) => deps.activeLoops[loopId]?.running);
    if (validIds.length >= 2) {
      groups[id] = { ...g, loopIds: validIds, timer: null };
      validIds.forEach((loopId) => { deps.activeLoops[loopId].syncGroup = id; deps.activeLoops[loopId].syncTime = g.time; });
      syncTick(id).catch(() => {});
      console.log(`[sync ${id}] geri yuklendi (${validIds.length} loop, tur: ${g.time}s)`);
    }
  });
  if (Object.keys(groups).length) deps.saveState();
}

module.exports = { initSync, startGroup, stopGroup, removeLoop, getGroupOf, getState };
