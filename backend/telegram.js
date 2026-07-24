/**
 * Telegram bildirim modulu
 * LOKI_TELEGRAM_BOT_TOKEN ve LOKI_TELEGRAM_CHAT_ID env degiskenleri ile calisir.
 * Ikisi de tanimli degilse modul sessizce devre disi kalir.
 *
 * "Herkesi etiketleme" yaklasimi: Telegram'da @everyone yoktur; bunun yerine
 * her bildirim gonderildikten sonra pinChatMessage ile sabitlenir. Sabitlenen
 * mesaj tum grup uyelerine bildirim duser. Sabit cubugu temiz kalsin diye
 * bir onceki bildirimin sabiti kaldirilir. Botun grupta "mesaj sabitleme"
 * yetkisine sahip yonetici olmasi gerekir.
 */

const BOT_TOKEN = process.env.LOKI_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.LOKI_TELEGRAM_CHAT_ID || '';

let lastPinnedMessageId = null;

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

async function telegramApi(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  return res.json();
}

// Bildirimi sabitleyerek tum uyelere bildirim dusmesini saglar (@everyone yerine).
async function pinMessage(messageId) {
  try {
    if (lastPinnedMessageId) {
      await telegramApi('unpinChatMessage', { chat_id: CHAT_ID, message_id: lastPinnedMessageId });
    }
    const result = await telegramApi('pinChatMessage', {
      chat_id: CHAT_ID,
      message_id: messageId,
      disable_notification: false
    });
    if (result.ok) {
      lastPinnedMessageId = messageId;
    } else {
      console.error('[telegram] Sabitleme hatasi:', result.description || 'bilinmiyor');
    }
  } catch (err) {
    console.error('[telegram] Sabitleme hatasi:', err.message);
  }
}

// Hicbir zaman throw etmez; hatalar sadece loglanir.
async function sendTelegram(message) {
  if (!isEnabled()) return;
  try {
    const result = await telegramApi('sendMessage', {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    if (!result.ok) {
      console.error('[telegram] Gonderim hatasi:', result.description || 'bilinmiyor');
      return;
    }
    await pinMessage(result.result?.message_id);
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
