/**
 * demo-transitions/mock-api.cjs — saf http mock (bagimliliksiz).
 * Loki panelini gercek backend olmadan gormek icin. Sadece lokal demo.
 * Calistir: node demo-transitions/mock-api.cjs  (ardindan npm run dev)
 */
const http = require('http');

const SESSION = 'demo-sess';
const USER = { username: 'Yavrukurt1', role: 'user' };
const PLAN = { MaxTime: 300, Concurrents: 80 };

const ongoing = [
  { attack_id: 'a1', target: '194.39.149.156:443', method: 'STOMP', timeLeft: 96, concurrents: 60, layer: 'L4', loopId: 'L1' },
  { attack_id: 'a2', target: '194.39.149.156:443', method: 'HANDSHAKE', timeLeft: 88, concurrents: 50, layer: 'L4', loopId: 'L2' },
  { attack_id: 'a3', target: '65.181.120.58:443', method: 'UDP', timeLeft: 44, concurrents: 10, layer: 'L4' },
  { attack_id: 'a4', target: 'https://krknclothing.com/:443', method: 'CLOUDFLARE', timeLeft: 31, concurrents: 1, layer: 'L7', loopId: 'L3' }
];

const json = (res, obj) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
};

const routes = [
  ['POST', /^\/api\/stresse\/login$/, () => ({ status: 'success', sessionId: SESSION, user: USER, plan: PLAN })],
  ['GET', /^\/api\/stresse\/user\//, () => USER],
  ['GET', /^\/api\/stresse\/plan\//, () => PLAN],
  ['GET', /^\/api\/stresse\/methods$/, () => ([
    { method: 'FIVEM', description: 'UDP Flood emulating fivem connections', IsLayer4: true },
    { method: 'UDP', description: 'UDP Flood optimized for high output', IsLayer4: true },
    { method: 'CLOUDFLARE', description: 'HTTP/2 Flooder for cloudflare targets', IsLayer4: false }
  ])],
  ['GET', /^\/api\/stresse\/stats$/, () => ({ stats: { active: 4, total: 4, today: 4 } })],
  ['GET', /^\/api\/accounts$/, () => ({ status: 'success', accounts: [{ username: 'Yavrukurt1', sessionId: SESSION }] })],
  ['GET', /^\/api\/stresse\/loops$/, () => ({ loops: [
    { loopId: 'L1', running: true, note: '', params: { host: '194.39.149.156', port: 443, time: 150, method: 'STOMP', interval: 5, concurrents: 60, layer: 'L4', geo: 'worldwide' }, roundCount: 12, errors: 0 },
    { loopId: 'L2', running: true, note: '', params: { host: '194.39.149.156', port: 443, time: 150, method: 'HANDSHAKE', interval: 5, concurrents: 50, layer: 'L4', geo: 'worldwide' }, roundCount: 12, errors: 1 },
    { loopId: 'L3', running: true, note: '', params: { host: 'krknclothing.com', port: 443, time: 60, method: 'CLOUDFLARE', interval: 5, concurrents: 1, layer: 'L7', geo: 'worldwide' }, roundCount: 40, errors: 0 }
  ] })],
  ['GET', /^\/api\/stresse\/history\//, () => ({ records: [] })],
  ['POST', /^\/api\/stresse\/history$/, () => ({ records: [] })],
  ['GET', /^\/api\/impact$/, () => ({ targets: [] })],
  ['GET', /^\/api\/method-congestion$/, () => ({})],
  ['GET', /^\/api\/watch\/state$/, () => ({ status: 'success', keywords: [], sites: [], findings: [], scanning: false, lastScan: null })],
  ['GET', /^\/api\/phish\/stats$/, () => ({ enabled: false })],
  ['GET', /^\/api\/phish\/alerts$/, () => ({ alerts: [] })],
  ['GET', /^\/api\/stresse\/ongoing\//, () => ({ ongoing })],
  ['POST', /^\/api\/stresse\/stop$/, () => ({ status: 'success' })],
  ['POST', /^\/api\/stresse\/loop/, () => ({ status: 'success' })],
  ['PUT', /^\/api\/stresse\/loop/, () => ({ status: 'success' })]
];

http.createServer((req, res) => {
  // SSE canli akis
  if (req.method === 'GET' && /^\/api\/stresse\/live\//.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const tick = () => {
      ongoing.forEach((a) => { a.timeLeft = Math.max(1, a.timeLeft - 1); });
      res.write(`data: ${JSON.stringify({ ongoing })}\n\n`);
    };
    tick();
    const t = setInterval(tick, 1000);
    req.on('close', () => clearInterval(t));
    return;
  }
  for (const [m, re, fn] of routes) {
    if (req.method === m && re.test(req.url)) return json(res, fn());
  }
  json(res, { status: 'ok' });
}).listen(3001, () => console.log('mock api: http://localhost:3001'));
