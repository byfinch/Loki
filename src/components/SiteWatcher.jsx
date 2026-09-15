import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';

/**
 * SiteWatcher — uptime izleme paneli.
 * Site ekle/kaldir, yarim saatlik otomatik tur, manuel tarama (toplu/tekli).
 * Telegram bildirimleri backend'de (sitewatch.js) uretilir.
 */
const SiteWatcher = () => {
  const { showToast } = useStressTest();
  const [state, setState] = useState({ sites: [], nextScanAt: null, scanning: false });
  const [newUrl, setNewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanningOne, setScanningOne] = useState(null);

  const load = async () => {
    try {
      const data = await apiClient.getSitewatchState();
      setState(data);
    } catch { /* sessiz */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newUrl.trim()) return;
    setBusy(true);
    try {
      await apiClient.addSitewatchSite(newUrl.trim());
      setNewUrl('');
      showToast('Site eklendi', 'success');
      await load();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (url) => {
    try {
      await apiClient.removeSitewatchSite(url);
      showToast('Site kaldırıldı', 'success');
      await load();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleScanAll = async () => {
    setBusy(true);
    try {
      await apiClient.triggerSitewatchScan();
      showToast('Manuel tarama başlatıldı', 'success');
      setTimeout(load, 3000);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleScanOne = async (url) => {
    setScanningOne(url);
    try {
      await apiClient.triggerSitewatchScan(url);
      showToast('Tarama başlatıldı', 'success');
      setTimeout(load, 3000);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setScanningOne(null);
    }
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('tr-TR', { hour12: false });
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-green-500/25 bg-black/90 backdrop-blur">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-green-500/5 via-transparent to-cyan-500/5" />

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1 border-b border-green-500/20 bg-green-500/5 px-3 sm:px-4 py-2.5 text-xs text-green-400">
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
          <span className="text-green-300/90">root@loki:~/site-watcher</span>
          <span className="hidden sm:inline text-green-500/60">$ watch --sites --uptime</span>
          <span className="animate-pulse">▊</span>
        </div>
        <button
          onClick={handleScanAll}
          disabled={busy}
          className="shrink-0 rounded-sm border border-green-500/40 bg-green-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-green-400 transition hover:bg-green-500/20 disabled:opacity-50"
        >
          {busy ? '...' : 'ŞİMDİ TARA'}
        </button>
      </div>

      <div className="relative z-10 p-4 sm:p-5">
        <form onSubmit={handleAdd} className="mb-4 flex gap-2">
          <input
            type="text"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="site.com veya https://site.com/"
            className="flex-1 rounded-sm border border-green-500/30 bg-black px-3 py-2.5 text-[13px] text-green-400 placeholder-green-500/30 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-sm border border-green-500/40 bg-green-500/10 px-4 text-[11px] font-bold uppercase tracking-wider text-green-400 transition hover:bg-green-500/20 disabled:opacity-50"
          >
            Ekle
          </button>
        </form>

        <div className="space-y-2">
          {state.sites.length === 0 && (
            <div className="py-6 text-center text-[11px] text-gray-600">İzlenen site yok — yukarıdan ekle.</div>
          )}
          {state.sites.map((s) => (
            <div key={s.url} className="flex items-center gap-3 rounded-sm border border-green-500/15 bg-green-500/[0.03] px-3 py-2.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${
                s.status === 'up' ? 'bg-green-400 shadow-[0_0_8px_rgba(0,255,65,0.8)]'
                : s.status === 'down' ? 'bg-[#ff2d2d] shadow-[0_0_8px_rgba(255,45,45,0.8)] animate-pulse'
                : 'bg-gray-600'
              }`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-green-300">{s.url}</div>
                <div className="text-[9px] text-gray-600">
                  {s.status === 'up' ? `UP · ${s.ms} ms` : s.status === 'down' ? 'DOWN' : 'henüz taranmadı'}
                  {' · son: '}{fmtDate(s.lastCheckedAt)}
                </div>
              </div>
              <button
                onClick={() => handleScanOne(s.url)}
                disabled={scanningOne === s.url}
                className="shrink-0 rounded-sm border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-cyan-400 transition hover:bg-cyan-500/20 disabled:opacity-50"
              >
                {scanningOne === s.url ? '...' : 'Tara'}
              </button>
              <button
                onClick={() => handleRemove(s.url)}
                className="shrink-0 rounded-sm border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-red-400 transition hover:bg-red-500/20"
              >
                Kaldır
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between text-[9px] text-gray-600">
          <span>{state.sites.length} site izleniyor · 30 dk'da bir otomatik tur</span>
          <span>sıradaki: {state.nextScanAt ? fmtDate(state.nextScanAt) : '—'}</span>
        </div>
      </div>
    </div>
  );
};

export default SiteWatcher;
