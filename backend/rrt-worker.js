/**
 * rrt-worker.js
 * Uzak RRT worker servisi (standalone).
 *
 * Amac: Google Rich Results Test'in tarayici kismini residential IP'li bir
 * makinede (or. ev PC'si, Windows + sistem Chrome) kosmak. VPS backend'i
 * (rrt.js, LOKI_RRT_WORKER_URL tanimliysa) testi HTTP ile buraya devreder.
 *
 * Calistirma (Windows):
 *   set LOKI_RRT_SECRET=<paylasilan-gizli-anahtar>
 *   set LOKI_RRT_WORKER_BIND=100.x.y.z        (Tailscale IP; 0.0.0.0 KULLANMA)
 *   node backend/rrt-worker.js
 *
 * Endpoint:
 *   POST /run  { "url": "https://ornek.com/", "secret": "..." }
 *   -> 200: record { host, testedAt, verdict, items, crawlError, partialLoad, resultUrl, durationSec }
 *   -> 403: yanlis/eksik secret
 *
 * Ayni anda tek test kosar (basit promise zinciri kuyrugu); diger istekler bekler.
 */

const express = require('express');
const core = require('./rrt-core');

const PORT = parseInt(process.env.LOKI_RRT_WORKER_PORT || '3777', 10);
// Guvenlik: varsayilan sadece localhost; Tailscale IP'si env ile verilir.
const BIND = process.env.LOKI_RRT_WORKER_BIND || '127.0.0.1';
const SECRET = process.env.LOKI_RRT_SECRET || '';

function log(...args) {
  console.log('[rrt-worker]', ...args);
}

if (!SECRET) {
  console.error('[rrt-worker] LOKI_RRT_SECRET tanimli degil; servis guvenlik nedeniyle baslatilmadi.');
  process.exit(1);
}
if (BIND === '0.0.0.0' || BIND === '::') {
  console.error('[rrt-worker] Tum arayuzlerde dinleme (0.0.0.0) yasak; LOKI_RRT_WORKER_BIND ile Tailscale IP verin.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '64kb' }));

// url -> "https://host/" normalizasyonu (rrt.js toTestUrl ile ayni mantik)
function normalize(body) {
  const url = body && typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return null;
  let h = url;
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  try {
    const u = new URL(h);
    return { key: u.host.toLowerCase().replace(/^www\./, ''), url: u.origin + '/' };
  } catch (e) {
    return null;
  }
}

// Tek seferde tek test: gelen istekler promise zincirine girer.
let chain = Promise.resolve();
let busy = false;

app.post('/run', (req, res) => {
  if (!SECRET || req.body?.secret !== SECRET) {
    return res.status(403).json({ status: 'error', message: 'forbidden' });
  }
  const target = normalize(req.body);
  if (!target) {
    return res.status(400).json({ status: 'error', message: 'url gerekli' });
  }

  log(`Test istegi alindi: ${target.url}${busy ? ' (kuyruga girdi)' : ''}`);
  const job = chain.then(async () => {
    busy = true;
    try {
      return await core.runRrtTest(target.key, target.url);
    } finally {
      busy = false;
    }
  });
  // Zincir bir sonraki istek icin hatasiz devam etsin
  chain = job.catch(() => {});

  job
    .then((record) => res.json(record))
    .catch((err) => res.status(500).json({ status: 'error', message: err.message }));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', busy });
});

app.listen(PORT, BIND, () => {
  log(`Worker ayakta: http://${BIND}:${PORT} (secret korumali, tek test kuyrugu)`);
});
