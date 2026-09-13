/**
 * Loki Agent - background service worker
 *
 * Loki backend'inden is alir (long-poll), rackghost stresser_api.php'ye
 * bu tarayicinin oturumuyla iletir, sonucu backend'e postalar.
 * Boylece butun istekler gercek Chrome oturumundan cikar (CF sorunu yok).
 */

const LOKI_BASE = 'https://phishguard.click';
const AGENT_TOKEN = 'rg-agent-loki-2026';
const RG_API = 'https://rackghost.com/panel/stresser_api.php';

let running = true;
let lastError = null;
let lastJobAt = 0;
let completedJobs = 0;

async function pollLoop() {
  while (running) {
    try {
      const res = await fetch(`${LOKI_BASE}/api/rackghost/agent/poll`, {
        headers: { 'x-agent-token': AGENT_TOKEN }
      });
      if (!res.ok) {
        lastError = `poll HTTP ${res.status}`;
        await sleep(5000);
        continue;
      }
      const { job } = await res.json();
      lastError = null;
      if (!job) continue; // long-poll timeout; hemen yeniden baglan

      const result = await executeJob(job.payload);
      completedJobs += 1;
      lastJobAt = Date.now();

      await fetch(`${LOKI_BASE}/api/rackghost/agent/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': AGENT_TOKEN },
        body: JSON.stringify({ id: job.id, result })
      });
    } catch (err) {
      lastError = String(err && err.message || err).slice(0, 200);
      await sleep(5000);
    }
  }
}

async function executeJob(payload) {
  try {
    const res = await fetch(RG_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, error: `JSON degil (HTTP ${res.status}): ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err).slice(0, 300) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Service worker uykuya dalmasin diye periyodik alarm
chrome.alarms.create('loki-agent-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  // alarm sadece worker'i uyandirir; pollLoop kendini toparlar
  if (!pollLoop._started) {
    pollLoop._started = true;
    pollLoop();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  if (!pollLoop._started) {
    pollLoop._started = true;
    pollLoop();
  }
});

chrome.runtime.onStartup.addListener(() => {
  if (!pollLoop._started) {
    pollLoop._started = true;
    pollLoop();
  }
});
