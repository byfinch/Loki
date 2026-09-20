import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Panel crash teshisi: React boundary'ye dusmeyen hatalar (setInterval/
// setTimeout callback'leri, promise rejection'lar, EventSource callback'leri)
// buradan backend loguna bildirilir. Siyah-ekran vakalarinin kok nedenini
// pm2 logundan okunur kilar. Firtina onlemi: 5sn'de en fazla 1 bildirim.
let lastReportAt = 0;
const reportClientError = (source, message, stack) => {
  const now = Date.now();
  if (now - lastReportAt < 5000) return;
  lastReportAt = now;
  try {
    const sid = window.__lokiSessionId || null;
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sid ? { sessionid: sid } : {}) },
      body: JSON.stringify({ source, message: String(message || '?').slice(0, 400), stack: String(stack || '').slice(0, 1500) })
    }).catch(() => {});
  } catch { /* yoksay */ }
};
window.__lokiReportError = reportClientError;
window.addEventListener('error', (e) => {
  reportClientError('window', e.message, e.error?.stack || '');
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  reportClientError('promise', r?.message || String(r), r?.stack || '');
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
