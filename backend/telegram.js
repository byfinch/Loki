/**
 * Telegram bildirim modulu
 * LOKI_TELEGRAM_BOT_TOKEN ve LOKI_TELEGRAM_CHAT_ID env degiskenleri ile calisir.
 * Ikisi de tanimli degilse modul sessizce devre disi kalir.
 */

const BOT_TOKEN = process.env.LOKI_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.LOKI_TELEGRAM_CHAT_ID || '';

function isEnabled() {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

function initTelegram() {
  if (isEnabled()) {
    console.log('[telegram] Bildirimler aktif');
  } else {
    console.log('[telegram] LOKI_TELEGRAM_BOT_TOKEN / LOKI_TELEGRAM_CHAT_ID tanimli degil; Telegram bildirimleri devre disi');
  }
}

// Hicbir zaman throw etmez; hatalar sadece loglanir.
async function sendTelegram(message) {
  if (!isEnabled()) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      console.error(`[telegram] Gonderim hatasi: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[telegram] Gonderim hatasi:', err.message);
  }
}

// Kullanici verisini (host, username vb.) HTML parse mode icin guvenli hale getirir.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { sendTelegram, initTelegram, isEnabled, esc };
