import React from 'react';
import { apiClient } from '../services/apiClient';

// Yakalanmayan render hatalari React 18'de TUM agaci soker; geriye siyah body
// kalirdi ("panel bir sure sonra siyah oluyor, F5 duzeltiyor" vakasi).
// Boundary hatayi yakalar: hata karti gosterir, loga bildirir, kendini
// iyilestirir. Ust uste 3 hizli cokus olursa sayfa otomatik yenilenir
// (kullanicinin elle F5 yapmasi gerekmez).
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.crashCount = 0;
    this.firstCrashAt = 0;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const now = Date.now();
    if (now - this.firstCrashAt > 30000) { // 30sn penceresinde sayac sifir
      this.firstCrashAt = now;
      this.crashCount = 0;
    }
    this.crashCount += 1;
    console.error('[panel] render hatasi:', error, info);
    // Backend loguna dusur: pm2 uzerinden kok neden okunabilir
    try {
      const sid = apiClient.getSessionId();
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sid ? { sessionid: sid } : {}) },
        body: JSON.stringify({
          source: `boundary#${this.crashCount}`,
          message: String(error?.message || error),
          stack: String(info?.componentStack || error?.stack || '').slice(0, 2000)
        })
      }).catch(() => {});
    } catch { /* bildirim hatasi paneli ikinci kez kirmasin */ }
    // 3 hizli cokus: veri durumundan deterministik patlama — yenile
    if (this.crashCount >= 3) {
      setTimeout(() => window.location.reload(), 1200);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-4 font-mono p-6">
          <div className="text-red-400 text-sm tracking-[3px]">PANEL HATASI — KURTARILDI</div>
          <div className="text-[11px] text-gray-400 max-w-2xl text-center break-all border border-red-500/20 rounded p-3 bg-red-500/5">
            {String(this.state.error?.message || this.state.error)}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="border border-green-500/40 rounded px-4 py-1.5 text-xs text-green-400 hover:bg-green-500/10 transition-colors"
            >
              Devam et
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="border border-white/20 rounded px-4 py-1.5 text-xs text-gray-300 hover:bg-white/5 transition-colors"
            >
              Sayfayı yenile
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
