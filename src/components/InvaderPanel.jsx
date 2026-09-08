import React, { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';

/**
 * InvaderPanel.jsx — Invader Control bölümü: izlenen sitelerin
 * Googlebot/Kullanici durumlari (backend 30dk'da bir tarar).
 */
const InvaderPanel = () => {
  const { addLog, showToast } = useStressTest();
  const [data, setData] = useState({ sites: [] });
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await apiClient.getInvaderState();
      setData(d);
    } catch (err) {
      addLog(`Invader durumu alınamadı: ${err.message}`);
    }
  }, [addLog]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [refresh]);

  const manualScan = async () => {
    setScanning(true);
    try {
      await apiClient.triggerInvaderScan();
      showToast('Tarama başlatıldı (sonuçlar Telegram\'a düşer)', 'success');
      setTimeout(() => { refresh(); setScanning(false); }, 15000);
    } catch (err) { setScanning(false); showToast(err.message, 'error'); }
  };

  const badge = (st) => {
    const map = { OK: ['text-green-400 border-green-500/30 bg-green-500/10', 'OK'], DOWN: ['text-red-400 border-red-500/30 bg-red-500/10', 'DOWN'], BLOCKED: ['text-yellow-400 border-yellow-500/30 bg-yellow-500/10', 'BLOCKED'], OBSERVED: ['text-sky-300 border-sky-500/30 bg-sky-500/10', 'OBSERVED'] };
    const [cls, txt] = map[st] || ['text-gray-400 border-white/10 bg-white/5', st || '—'];
    return <span className={`px-2 py-0.5 rounded-sm border text-[10px] font-bold ${cls}`}>{txt}</span>;
  };

  return (
    <div className="relative w-full overflow-hidden rounded border border-green-500/25 bg-[#020a04]/80 font-mono shadow-[0_0_40px_rgba(0,255,65,0.06)]">
      <div className="pointer-events-none absolute inset-0 z-0" style={{ background: 'repeating-linear-gradient(0deg, rgba(0,255,65,0.015) 0 1px, transparent 1px 3px)' }} />
      <div className="relative z-10 flex items-center gap-2.5 border-b border-green-500/20 bg-green-500/5 px-4 py-2.5 text-xs text-green-400">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
        <span className="text-green-300/90">root@loki:~/invader-control</span>
        <span className="text-green-500/60">$ watch -n1800 --both-views</span>
        <span className="animate-pulse">▊</span>
        <span className="ml-auto">
          <button
            onClick={manualScan}
            disabled={scanning}
            className="px-4 py-1.5 rounded-sm text-xs font-bold tracking-wider bg-green-500/15 border border-green-500/40 text-green-400 hover:bg-green-500/25 transition disabled:opacity-40"
          >
            ŞİMDİ TARA
          </button>
        </span>
      </div>
      <div className="relative z-10 p-4 sm:p-5 overflow-x-auto">
        {data.sites.length === 0 ? (
          <div className="py-12 text-center text-green-500/50"><p>izlenen site yok.</p></div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-600 text-[10px] uppercase tracking-wider border-b border-green-500/15">
                <th className="px-2 py-2">&gt; Etiket</th>
                <th className="px-2 py-2">&gt; Site</th>
                <th className="px-2 py-2">&gt; Beklenen</th>
                <th className="px-2 py-2">&gt; Googlebot</th>
                <th className="px-2 py-2">&gt; Kullanıcı</th>
                <th className="px-2 py-2">&gt; Son değişim</th>
              </tr>
            </thead>
            <tbody>
              {data.sites.map((s) => (
                <tr key={s.name || s.url} className="border-b border-dashed border-green-500/10 hover:bg-green-500/5 transition-colors">
                  <td className="px-2 py-2.5 text-green-300">{s.name}</td>
                  <td className="px-2 py-2.5"><a href={s.url} target="_blank" rel="noopener noreferrer" className="text-sky-300/90 hover:underline break-all">{s.url}</a></td>
                  <td className="px-2 py-2.5 text-cyan-300/80">{s.expect || '—'}</td>
                  <td className="px-2 py-2.5">{badge(s.status)}</td>
                  <td className="px-2 py-2.5">{badge(s.ustatus)}</td>
                  <td className="px-2 py-2.5 text-[10px] text-gray-500">{s.since ? new Date(s.since).toLocaleString('tr-TR') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default InvaderPanel;
