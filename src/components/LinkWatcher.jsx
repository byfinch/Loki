import React, { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';

/**
 * LinkWatcher.jsx — Link Gözcüsü bölümü (Loki terminal-karti stili).
 * Backend saat degil 30dk'da bir tarar; bu bolum yonetim + rapor ekranidir.
 */

// Loki terminal penceresi kalibi (AttackForm ile ayni gorunum)
const TermCard = ({ title, cmd, children, className = '' }) => (
  <div className={`relative w-full overflow-hidden rounded border border-green-500/25 bg-[#020a04]/80 font-mono shadow-[0_0_40px_rgba(0,255,65,0.06)] ${className}`}>
    <div
      className="pointer-events-none absolute inset-0 z-0"
      style={{ background: 'repeating-linear-gradient(0deg, rgba(0,255,65,0.015) 0 1px, transparent 1px 3px)' }}
    />
    <div className="relative z-10 flex items-center gap-2.5 border-b border-green-500/20 bg-green-500/5 px-4 py-2.5 text-xs text-green-400">
      <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
      <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
      <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
      <span className="text-green-300/90">{title}</span>
      <span className="text-green-500/60">{cmd}</span>
      <span className="animate-pulse">▊</span>
    </div>
    <div className="relative z-10 p-4 sm:p-5">{children}</div>
  </div>
);

const LinkWatcher = () => {
  const { addLog, showToast } = useStressTest();
  const [data, setData] = useState({ keywords: [], sites: [], findings: [], scanning: false, lastScan: null });
  const [newKw, setNewKw] = useState('');
  const [newSite, setNewSite] = useState('');
  const [copiedKey, setCopiedKey] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const d = await apiClient.getWatchState();
      setData(d);
    } catch (err) {
      addLog(`Link gözcüsü durumu alınamadı: ${err.message}`);
    }
  }, [addLog]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('tr-TR') : '—');
  const live = data.findings.filter((f) => !f.gone);

  const addKeyword = async () => {
    const v = newKw.trim();
    if (!v) return;
    try {
      await apiClient.addWatchKeyword(v);
      setNewKw('');
      refresh();
    } catch (err) { showToast(err.message, 'error'); }
  };
  const removeKeyword = async (k) => {
    try { await apiClient.removeWatchKeyword(k); refresh(); } catch (err) { showToast(err.message, 'error'); }
  };
  const addSite = async () => {
    const v = newSite.trim();
    if (!v) return;
    try {
      await apiClient.addWatchSite(v);
      setNewSite('');
      refresh();
    } catch (err) { showToast(err.message, 'error'); }
  };
  const removeSite = async (s) => {
    try { await apiClient.removeWatchSite(s); refresh(); } catch (err) { showToast(err.message, 'error'); }
  };
  const manualScan = async () => {
    try {
      await apiClient.triggerWatchScan();
      showToast('Tarama başlatıldı', 'success');
      setTimeout(refresh, 4000);
    } catch (err) { showToast(err.message, 'error'); }
  };
  const handleCopy = async (href, key) => {
    try {
      await copyTextToClipboard(href);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch { showToast('Kopyalama başarısız', 'error'); }
  };

  const labelCls = 'block text-[10px] text-green-500/70 mb-1.5';
  const inputCls = 'w-full bg-black/60 border border-green-500/20 rounded-sm px-3 py-2 text-xs font-mono text-green-100 placeholder-gray-600 focus:outline-none focus:border-green-500/50 focus:shadow-[0_0_10px_rgba(0,255,65,0.15)]';

  return (
    <div className="flex flex-col gap-8 w-full">
      {/* durum + manuel tarama */}
      <TermCard title="root@loki:~$" cmd="watcher -i 30m" className="w-full">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-5 text-xs text-gray-400">
            <span>&gt; siteler: <b className="text-green-400 font-semibold">{data.sites.length}</b></span>
            <span>&gt; keyword: <b className="text-green-400 font-semibold">{data.keywords.length}</b></span>
            <span>&gt; aktif ikili: <b className="text-green-400 font-semibold">{live.length}</b></span>
            <span>&gt; son tarama: <b className="text-green-400 font-semibold">{fmt(data.lastScan)}</b></span>
            {data.scanning && <span className="text-green-400 animate-pulse">taranıyor...</span>}
          </div>
          <button
            onClick={manualScan}
            disabled={data.scanning}
            className="px-5 py-2 rounded-sm text-xs font-mono font-bold tracking-wider bg-green-500/15 border border-green-500/40 text-green-400 hover:bg-green-500/25 hover:shadow-[0_0_12px_rgba(0,255,65,0.25)] transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ŞİMDİ TARA
          </button>
        </div>
      </TermCard>

      {/* yonetim kartlari */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
        <TermCard title="root@loki:~/keywords" cmd="$ ./edit --list">
          <label className={labelCls}>&gt; keyword_ekle</label>
          <div className="flex gap-2 mb-4">
            <input
              className={inputCls} value={newKw} placeholder="herabet"
              onChange={(e) => setNewKw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
            />
            <button className="px-4 rounded-sm text-xs font-mono border border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/20 transition" onClick={addKeyword}>EKLE</button>
          </div>
          <div className="flex flex-wrap gap-1.5 min-h-[28px]">
            {data.keywords.length === 0 && <span className="text-xs text-gray-600"># henüz keyword yok</span>}
            {data.keywords.map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5 bg-green-500/10 border border-green-500/20 rounded-sm px-2 py-1 text-xs text-green-200">
                {k}
                <button onClick={() => removeKeyword(k)} className="text-red-400/70 hover:text-red-400 font-bold" title="Kaldır">×</button>
              </span>
            ))}
          </div>
        </TermCard>

        <TermCard title="root@loki:~/watchlist" cmd="$ ./edit --sites">
          <label className={labelCls}>&gt; site_ekle</label>
          <div className="flex gap-2 mb-4">
            <input
              className={inputCls} value={newSite} placeholder="domain.com veya tam link yapıştır"
              onChange={(e) => setNewSite(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addSite()}
            />
            <button className="px-4 rounded-sm text-xs font-mono border border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/20 transition" onClick={addSite}>EKLE</button>
          </div>
          <ul className="divide-y divide-dashed divide-green-500/10 min-h-[28px]">
            {data.sites.length === 0 && <li className="text-xs text-gray-600 py-1"># henüz site yok</li>}
            {data.sites.map((s) => (
              <li key={s} className="flex items-center justify-between gap-2 py-1.5 text-xs text-green-100/90">
                <span className="truncate">{s}</span>
                <button onClick={() => removeSite(s)} className="text-red-400/70 hover:text-red-400 font-bold flex-shrink-0" title="Kaldır">×</button>
              </li>
            ))}
          </ul>
        </TermCard>
      </div>

      {/* bulgular */}
      <TermCard title="root@loki:~/bulgular" cmd="$ tail -f findings.log" className="w-full">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-600 text-[10px] uppercase tracking-wider border-b border-green-500/15">
                <th className="px-2 py-2">&gt; Keyword</th>
                <th className="px-2 py-2">&gt; Link</th>
                <th className="px-2 py-2">&gt; Site</th>
                <th className="px-2 py-2">&gt; İlk / Son</th>
                <th className="px-2 py-2">&gt; Durum</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.findings.length === 0 && (
                <tr><td colSpan={6} className="text-center text-gray-600 py-10"># bulgu yok — site ve keyword ekle, ilk tarama kısa süre içinde başlar</td></tr>
              )}
              {data.findings.map((f) => {
                const isNew = Date.now() - new Date(f.firstSeen).getTime() < 2 * 3600 * 1000;
                return (
                  <tr key={f.key} className="border-b border-dashed border-green-500/10 hover:bg-green-500/5 transition-colors">
                    <td className="px-2 py-2.5 text-green-400">{f.keyword}</td>
                    <td className="px-2 py-2.5">
                      <a href={f.href} target="_blank" rel="noopener noreferrer" className="text-sky-300/90 hover:underline break-all">{f.href}</a>
                      {f.anchor && <div className="text-[10px] text-gray-600 mt-0.5">{f.anchor}</div>}
                    </td>
                    <td className="px-2 py-2.5 text-green-100/80">{f.site}</td>
                    <td className="px-2 py-2.5 text-[10px] text-gray-500 whitespace-nowrap">{fmt(f.firstSeen)}<br />{fmt(f.lastSeen)}</td>
                    <td className="px-2 py-2.5">
                      {f.gone
                        ? <span className="px-1.5 py-0.5 rounded-sm text-[10px] bg-red-500/15 text-red-400 border border-red-500/25">KAYBOLDU</span>
                        : isNew
                          ? <span className="px-1.5 py-0.5 rounded-sm text-[10px] bg-green-500/15 text-green-400 border border-green-500/25">YENİ</span>
                          : <span className="px-1.5 py-0.5 rounded-sm text-[10px] bg-sky-500/10 text-sky-300 border border-sky-500/20">AKTİF</span>}
                    </td>
                    <td className="px-2 py-2.5">
                      <button
                        onClick={() => handleCopy(f.href, f.key)}
                        title="Linki kopyala"
                        className={`flex h-6 w-6 items-center justify-center rounded-sm border transition-colors duration-200 ${
                          copiedKey === f.key
                            ? 'border-green-500/40 bg-green-500/20 text-green-400'
                            : 'border-green-500/15 bg-green-500/5 text-green-500/50 hover:border-green-500/40 hover:text-green-400'
                        }`}
                      >
                        {copiedKey === f.key ? (
                          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                        ) : (
                          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </TermCard>
    </div>
  );
};

export default LinkWatcher;
