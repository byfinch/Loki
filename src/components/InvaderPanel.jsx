import React, { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';

/**
 * InvaderPanel.jsx — Invader Control: site yonetimi + tekli/toplus tarama +
 * gecmis + aralik ayari. Backend 30dk'da (ayarlanabilir) bir tarar.
 */
const InvaderPanel = () => {
  const { addLog, showToast } = useStressTest();
  const [data, setData] = useState({ sites: [], intervalMin: 30 });
  const [history, setHistory] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [rowScanning, setRowScanning] = useState(null);
  const [form, setForm] = useState({ name: '', url: '', expect: '' });
  const [intervalDraft, setIntervalDraft] = useState('');

  const refresh = useCallback(async () => {
    try {
      const d = await apiClient.getInvaderState();
      setData(d);
      setIntervalDraft(String(d.intervalMin || 30));
    } catch (err) {
      addLog(`Invader durumu alınamadı: ${err.message}`);
    }
  }, [addLog]);

  const refreshHistory = useCallback(async () => {
    try { setHistory(await apiClient.getInvaderHistory()); } catch { /* sessiz */ }
  }, []);

  useEffect(() => {
    refresh();
    refreshHistory();
    const t = setInterval(() => { refresh(); refreshHistory(); }, 20000);
    return () => clearInterval(t);
  }, [refresh, refreshHistory]);

  const badge = (st) => {
    const map = { OK: ['text-green-400 border-green-500/30 bg-green-500/10'], DOWN: ['text-red-400 border-red-500/30 bg-red-500/10'], BLOCKED: ['text-yellow-400 border-yellow-500/30 bg-yellow-500/10'], OBSERVED: ['text-sky-300 border-sky-500/30 bg-sky-500/10'] };
    const [cls] = map[st] || ['text-gray-400 border-white/10 bg-white/5'];
    return <span className={`px-2 py-0.5 rounded-sm border text-[10px] font-bold ${cls}`}>{st || '—'}</span>;
  };

  const manualScan = async () => {
    setScanning(true);
    try {
      await apiClient.triggerInvaderScan();
      showToast('Toplu tarama başlatıldı (sonuçlar Telegram\'a düşer)', 'success');
      setTimeout(() => { refresh(); refreshHistory(); setScanning(false); }, 20000);
    } catch (err) { setScanning(false); showToast(err.message, 'error'); }
  };

  const scanOne = async (url) => {
    setRowScanning(url);
    try {
      await apiClient.triggerInvaderScan(url);
      showToast('Tekli tarama başlatıldı', 'success');
      setTimeout(() => { refresh(); refreshHistory(); setRowScanning(null); }, 15000);
    } catch (err) { setRowScanning(null); showToast(err.message, 'error'); }
  };

  const addSite = async () => {
    if (!form.url.trim()) return;
    try {
      await apiClient.addInvaderSite(form);
      setForm({ name: '', url: '', expect: '' });
      refresh();
      showToast('Site eklendi', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  };

  const removeSite = async (name) => {
    try { await apiClient.removeInvaderSite(name); refresh(); showToast('Site kaldırıldı', 'success'); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const saveInterval = async () => {
    const min = parseInt(intervalDraft, 10);
    if (!Number.isFinite(min) || min < 1) { showToast('Geçersiz aralık', 'error'); return; }
    try {
      await apiClient.setInvaderInterval(min);
      showToast(`Tarama aralığı: ${min} dk`, 'success');
      refresh();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const inputCls = 'bg-black/60 border border-green-500/20 rounded-sm px-2.5 py-1.5 text-[11px] font-mono text-green-100 placeholder-gray-600 focus:outline-none focus:border-green-500/50';

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* izlenen siteler */}
      <div className="relative w-full overflow-hidden rounded border border-green-500/25 bg-[#020a04]/80 font-mono shadow-[0_0_40px_rgba(0,255,65,0.06)]">
        <div className="pointer-events-none absolute inset-0 z-0" style={{ background: 'repeating-linear-gradient(0deg, rgba(0,255,65,0.015) 0 1px, transparent 1px 3px)' }} />
        <div className="relative z-10 flex items-center gap-2.5 border-b border-green-500/20 bg-green-500/5 px-4 py-2.5 text-xs text-green-400">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
          <span className="text-green-300/90">root@loki:~/invader-control</span>
          <span className="text-green-500/60">$ watch --both-views</span>
          <span className="animate-pulse">▊</span>
          <span className="ml-auto flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
              aralık:
              <input
                className="w-14 bg-black/60 border border-green-500/20 rounded-sm px-1.5 py-1 text-[10px] text-green-300 text-center focus:outline-none focus:border-green-500/50"
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveInterval()}
              />
              dk
              <button onClick={saveInterval} className="px-2 py-1 rounded-sm border border-green-500/30 bg-green-500/10 text-green-400 text-[10px] hover:bg-green-500/20">kaydet</button>
            </span>
            <button
              onClick={manualScan}
              disabled={scanning}
              className="px-4 py-1.5 rounded-sm text-xs font-bold tracking-wider bg-green-500/15 border border-green-500/40 text-green-400 hover:bg-green-500/25 transition disabled:opacity-40"
            >
              ŞİMDİ TARA
            </button>
          </span>
        </div>
        <div className="relative z-10 p-4 sm:p-5">
          {/* site ekleme */}
          <div className="flex flex-wrap gap-2 mb-4">
            <input className={inputCls + ' w-40'} placeholder="etiket (örn. herabetguncel)" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <input className={inputCls + ' flex-1 min-w-[220px]'} placeholder="site url (https://...)" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && addSite()} />
            <input className={inputCls + ' w-44'} placeholder="beklenen domain" value={form.expect} onChange={(e) => setForm((f) => ({ ...f, expect: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && addSite()} />
            <button onClick={addSite} className="px-4 rounded-sm text-[11px] border border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/20 transition">EKLE</button>
          </div>

          {data.sites.length === 0 ? (
            <div className="py-10 text-center text-green-500/50"><p>izlenen site yok.</p></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-600 text-[10px] uppercase tracking-wider border-b border-green-500/15">
                    <th className="px-2 py-2">&gt; Etiket</th>
                    <th className="px-2 py-2">&gt; Site</th>
                    <th className="px-2 py-2">&gt; Beklenen</th>
                    <th className="px-2 py-2">&gt; Googlebot</th>
                    <th className="px-2 py-2">&gt; Kullanıcı</th>
                    <th className="px-2 py-2">&gt; Son değişim</th>
                    <th className="px-2 py-2">&gt; İşlem</th>
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
                      <td className="px-2 py-2.5">
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => scanOne(s.url)}
                            disabled={rowScanning === s.url}
                            title="Sadece bu siteyi tara"
                            className="px-2.5 py-1 rounded-sm border border-green-500/25 text-green-400/80 text-[10px] hover:bg-green-500/10 transition disabled:opacity-40"
                          >
                            {rowScanning === s.url ? '...' : 'tara'}
                          </button>
                          <button
                            onClick={() => removeSite(s.name || s.url)}
                            title="Listeden kaldır"
                            className="px-2.5 py-1 rounded-sm border border-red-500/25 text-red-400/80 text-[10px] hover:bg-red-500/10 transition"
                          >
                            kaldır
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* gecmis */}
      <div className="relative w-full overflow-hidden rounded border border-green-500/25 bg-[#020a04]/80 font-mono shadow-[0_0_40px_rgba(0,255,65,0.06)]">
        <div className="relative z-10 flex items-center gap-2.5 border-b border-green-500/20 bg-green-500/5 px-4 py-2.5 text-xs text-green-400">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
          <span className="text-green-300/90">root@loki:~/invader-control</span>
          <span className="text-green-500/60">$ tail -50 history.log</span>
          <span className="animate-pulse">▊</span>
        </div>
        <div className="relative z-10 p-4 sm:p-5 overflow-x-auto">
          {history.length === 0 ? (
            <div className="py-8 text-center text-gray-600 text-xs"># geçmiş kaydı yok — ilk tarama sonrası dolar</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-600 text-[10px] uppercase tracking-wider border-b border-green-500/15">
                  <th className="px-2 py-2">&gt; Zaman</th>
                  <th className="px-2 py-2">&gt; Etiket</th>
                  <th className="px-2 py-2">&gt; Googlebot</th>
                  <th className="px-2 py-2">&gt; Kullanıcı</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i} className="border-b border-dashed border-green-500/10">
                    <td className="px-2 py-2 text-[10px] text-gray-500 whitespace-nowrap">{new Date(h.ts).toLocaleString('tr-TR')}</td>
                    <td className="px-2 py-2 text-green-300">{h.name}</td>
                    <td className="px-2 py-2">{badge(h.status)}</td>
                    <td className="px-2 py-2">{badge(h.ustatus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

export default InvaderPanel;
