import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';
import { renderNoteWithLinks } from '../utils/renderNoteWithLinks.jsx';

// stresse.st'in destekledigi geo degerleri (AttackForm ile ayni liste)
const LOOP_GEO_OPTIONS = [
  { value: 'worldwide', label: 'Worldwide' },
  { value: 'china', label: 'China' },
  { value: 'russia', label: 'Russia' },
  { value: 'brazil', label: 'Brazil' },
  { value: 'korea', label: 'Korea' },
  { value: 'turkey', label: 'Turkey' },
  { value: 'thailand', label: 'Thailand' },
  { value: 'japan', label: 'Japan' },
  { value: 'vietnam', label: 'Vietnam' },
  { value: 'indonesia', label: 'Indonesia' },
  { value: 'iran', label: 'Iran' }
];

const LoopManager = () => {
  const { state, setLoops, addLog, showToast } = useStressTest();
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [editingLoopId, setEditingLoopId] = useState(null);
  const [editDraft, setEditDraft] = useState({ note: '', time: 0, interval: 0, concurrents: 1, geo: 'worldwide' });
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = (loopId, loop) => {
    setEditingLoopId(loopId);
    setEditDraft({
      note: loop.note || '',
      time: parseInt(loop.params?.time, 10) || 0,
      interval: parseInt(loop.params?.interval, 10) || 0,
      concurrents: parseInt(loop.params?.concurrents, 10) || 1,
      geo: loop.params?.geo || 'worldwide'
    });
  };

  // Loop duzenlemesini kaydet: not + gelecek turlarin saldiri ayarlari.
  // Yeni degerler bir sonraki turdan itibaren gecerli olur.
  const handleSaveEdit = async (loopId) => {
    setSavingEdit(true);
    try {
      await apiClient.editLoop(loopId, {
        note: editDraft.note.trim(),
        time: parseInt(editDraft.time, 10),
        interval: parseInt(editDraft.interval, 10),
        concurrents: parseInt(editDraft.concurrents, 10),
        geo: editDraft.geo
      });
      await refreshLoops();
      setEditingLoopId(null);
      addLog(`Loop güncellendi: ${loopId}`);
      showToast('Loop ayarları kaydedildi (yeni turlarda geçerli)', 'success');
    } catch (err) {
      showToast(`Loop güncellenemedi: ${err.message}`, 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  const refreshLoops = async () => {
    try {
      const data = await apiClient.getLoops();
      const map = {};
      (data.loops || []).forEach((loop) => {
        map[loop.loopId] = loop;
      });
      setLoops(map);
      return data;
    } catch (err) {
      addLog(`Loop listesi alınamadı: ${err.message}`);
      return null;
    }
  };

  useEffect(() => {
    if (!state.isAuthenticated) return;
    refreshLoops();
    const interval = setInterval(refreshLoops, 3000);
    return () => clearInterval(interval);
  }, [state.isAuthenticated]);

  const formatTargetForDisplay = (target, layer = 'L7') => {
    if (!target || typeof target !== 'string') return target;
    let t = target.trim();
    const isL7 = layer === 'L7';
    if (isL7) {
      t = t.replace(/:(\d+)(?=\/|$)/, '');
      if (!/^https?:\/\//i.test(t)) {
        t = `https://${t}`;
      }
      t = t.replace(/^http:\/\//i, 'https://');
      if (!t.endsWith('/')) {
        t += '/';
      }
    } else {
      t = t.replace(/^https?:\/\//i, '');
      t = t.replace(/:(\d+)(?=\/|$)/, '');
    }
    return t;
  };

  // Goruntude sade domain; kopyalamada tam URL (formatTargetForDisplay).
  const formatTargetShort = (target) =>
    String(target || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  const handleCopyTarget = async (target, key, layer = 'L7') => {
    const copyTarget = formatTargetForDisplay(target, layer);
    try {
      const ok = await copyTextToClipboard(copyTarget);
      if (ok) {
        setCopiedKey(key);
        addLog(`Hedef kopyalandı: ${copyTarget}`);
        setTimeout(() => setCopiedKey(null), 4000);
      } else {
        throw new Error('Kopyalama başarısız');
      }
    } catch (err) {
      addLog(`Kopyalama hatası: ${err.message}`);
      showToast('Kopyalama başarısız', 'error');
    }
  };

  const handleStop = async (loopId) => {
    setLoading(loopId);
    try {
      await apiClient.stopLoop(loopId);
      // Hemen backendden yeni durumu cek; refreshLoops state'i gunceller,
      // durdurulan loop listeden duser (ayrica animateRemove/removeLoop'a gerek yok)
      await refreshLoops();
      addLog(`Loop durduruldu: ${loopId}`);
      setLoading(false);
    } catch (err) {
      addLog(`Loop durdurma hatası: ${err.message}`);
      setLoading(false);
    }
  };

  const handleStopAll = async () => {
    setLoading('__ALL__');
    try {
      await apiClient.stopLoop();
      const data = await refreshLoops();
      const remainingIds = new Set((data?.loops || []).map((loop) => loop.loopId));

      if (remainingIds.size === 0) {
        addLog('Tüm looplar durduruldu');
      } else {
        addLog(`Kısmi sonuç: ${remainingIds.size} loop hâlâ aktif`);
        showToast(`${remainingIds.size} loop durdurulamadı, hâlâ aktif`, 'warning');
      }
    } catch (err) {
      // Hata durumunda local state'e dokunma; backend gercegi bir sonraki refresh'te gelir
      addLog(`Loop durdurma hatası: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const loops = Object.entries(state.activeLoops);

  return (
    <div className="relative w-full overflow-hidden rounded border border-green-500/25 bg-[#020a04]/80 font-mono shadow-[0_0_40px_rgba(0,255,65,0.06)]">
      {/* CRT scanline dokusu */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{ background: 'repeating-linear-gradient(0deg, rgba(0,255,65,0.015) 0 1px, transparent 1px 3px)' }}
      />

      {/* Title bar */}
      <div className="relative z-10 flex items-center gap-2.5 border-b border-green-500/20 bg-green-500/5 px-4 py-2.5 text-xs text-green-400">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
        <span className="text-green-300/90">root@loki:~/aktif-looplar</span>
        <span className="text-green-500/60">$ watch -n3 loopctl list --count={loops.length}</span>
        <span className="animate-pulse">▊</span>
        {loops.length > 0 && (
          <button
            onClick={handleStopAll}
            disabled={loading === '__ALL__'}
            className="ml-auto inline-flex h-7 items-center justify-center rounded-sm border border-red-500/30 px-3 text-[11px] text-red-400 transition-all hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading === '__ALL__' ? (
              <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : 'Tümünü Kapat'}
          </button>
        )}
      </div>

      <div className="relative z-10 p-4 sm:p-5">
        {loops.length === 0 ? (
          <div className="py-12 text-center text-green-500/50">
            <p>aktif loop yok.</p>
            <p className="mt-2 text-[11px] text-green-500/30"># saldiri formundan loop baslatabilirsiniz</p>
          </div>
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-green-500/25 text-left text-[10px] text-green-500/50">
                  <th className="whitespace-nowrap px-3 py-2 font-normal">&gt; Hedef</th>
                  <th className="whitespace-nowrap px-3 py-2 font-normal">&gt; Yöntem</th>
                  <th className="whitespace-nowrap px-3 py-2 text-center font-normal">&gt; Süre</th>
                  <th className="whitespace-nowrap px-3 py-2 text-center font-normal">&gt; Bekleme</th>
                  <th className="whitespace-nowrap px-3 py-2 text-center font-normal">&gt; Set</th>
                  <th className="whitespace-nowrap px-3 py-2 text-center font-normal">&gt; Hata</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-normal">&gt; İşlem</th>
                </tr>
              </thead>
              <tbody>
                {loops.map(([loopId, loop]) => (
                  <React.Fragment key={loopId}>
                    <tr className="border-b border-dashed border-green-500/10 transition-colors hover:bg-green-500/5">
                      <td className="px-3 py-2.5 align-middle">
                        <div className="flex items-center gap-2">
                          <span
                            title="URL'yi kopyala"
                            onClick={() => handleCopyTarget(loop.displayTarget || loop.params?.host || '', loopId, loop.params?.layer)}
                            className="inline-block w-[210px] cursor-pointer truncate text-left text-green-200 transition-colors hover:text-green-400"
                          >
                            {formatTargetShort(formatTargetForDisplay(loop.displayTarget || loop.params?.host || '', loop.params?.layer))}
                          </span>
                          <button
                            onClick={() => handleCopyTarget(loop.displayTarget || loop.params?.host || '', loopId, loop.params?.layer)}
                            title="URL'yi kopyala"
                            className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm border transition-colors duration-200 ${
                              copiedKey === loopId
                                ? 'border-green-500/40 bg-green-500/20 text-green-400'
                                : 'border-green-500/15 bg-green-500/5 text-green-500/50 hover:border-green-500/40 hover:text-green-400'
                            }`}
                          >
                            {copiedKey === loopId ? (
                              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                            ) : (
                              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                              </svg>
                            )}
                          </button>
                        </div>
                        {loop.note && (
                          <div className="mt-1 flex max-w-[240px] items-center gap-1.5 truncate text-[10px] text-cyan-400/90">
                            <span className="text-gray-600">📝</span>
                            <span className="truncate" title={loop.note}>{renderNoteWithLinks(loop.note)}</span>
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-gray-200">{loop.params?.method?.toUpperCase()}</td>
                      <td className="px-3 py-2.5 text-center text-gray-400">{loop.params?.time}s</td>
                      <td className="px-3 py-2.5 text-center text-gray-400">{loop.params?.interval}s</td>
                      <td className="px-3 py-2.5 text-center font-bold text-cyan-400">{loop.roundCount || 0}</td>
                      <td className="px-3 py-2.5 text-center">
                        {(loop.errors || 0) > 0 ? (
                          <span className="font-bold text-[#ff2d2d] [text-shadow:0_0_8px_rgba(255,45,45,0.7)]">{loop.errors}</span>
                        ) : (
                          <span className="text-gray-600">0</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => (editingLoopId === loopId ? setEditingLoopId(null) : startEdit(loopId, loop))}
                            title="Not / saldırı ayarlarını düzenle"
                            className={`flex h-7 w-7 items-center justify-center rounded-sm border text-[11px] transition-all ${
                              editingLoopId === loopId
                                ? 'border-green-500/50 bg-green-500/15 text-green-400 shadow-[0_0_8px_rgba(0,255,65,0.3)]'
                                : 'border-green-500/20 text-green-500/50 hover:border-green-500/40 hover:text-green-400'
                            }`}
                          >
                            ✎
                          </button>
                          <button
                            onClick={() => handleStop(loopId)}
                            disabled={loading === loopId}
                            className="inline-flex h-7 w-16 items-center justify-center rounded-sm border border-red-500/30 text-[11px] text-red-400 transition-all hover:bg-red-500/10 disabled:opacity-50"
                          >
                            {loading === loopId ? (
                              <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                            ) : 'Çıkar'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {editingLoopId === loopId && (
                      <tr className="border-b border-dashed border-green-500/10">
                        <td colSpan={7} className="px-3 pb-3 pt-1">
                          <div className="rounded-sm border border-green-500/20 bg-black/50 p-3">
                            <div className="mb-2.5 text-[10px] text-green-500/50">
                              loopctl edit --target {formatTargetShort(formatTargetForDisplay(loop.displayTarget || loop.params?.host || '', loop.params?.layer))} --next-round
                            </div>
                            <div className="flex flex-wrap items-end gap-3">
                              <div className="min-w-[220px] flex-1">
                                <label className="mb-1 block text-[9px] uppercase tracking-wider text-gray-600">Not</label>
                                <input
                                  type="text"
                                  value={editDraft.note}
                                  maxLength={120}
                                  onChange={(e) => setEditDraft((d) => ({ ...d, note: e.target.value }))}
                                  placeholder="Marka / asıl site linki"
                                  className="w-full rounded-sm border border-dashed border-cyan-500/40 bg-black px-2.5 py-1.5 text-[11px] text-cyan-300 placeholder-gray-700 focus:outline-none focus:shadow-[0_0_10px_rgba(0,212,255,0.15)]"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-[9px] uppercase tracking-wider text-gray-600">Süre (sn)</label>
                                <input
                                  type="number"
                                  min={0}
                                  value={editDraft.time}
                                  onChange={(e) => setEditDraft((d) => ({ ...d, time: e.target.value }))}
                                  className="w-[70px] rounded-sm border border-green-500/30 bg-black px-2 py-1.5 text-[11px] text-green-400 focus:outline-none focus:shadow-[0_0_10px_rgba(0,255,65,0.2)]"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-[9px] uppercase tracking-wider text-gray-600">Bekleme (sn)</label>
                                <input
                                  type="number"
                                  min={0}
                                  value={editDraft.interval}
                                  onChange={(e) => setEditDraft((d) => ({ ...d, interval: e.target.value }))}
                                  className="w-[70px] rounded-sm border border-green-500/30 bg-black px-2 py-1.5 text-[11px] text-green-400 focus:outline-none focus:shadow-[0_0_10px_rgba(0,255,65,0.2)]"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-[9px] uppercase tracking-wider text-gray-600">Adet</label>
                                <input
                                  type="number"
                                  min={1}
                                  value={editDraft.concurrents}
                                  onChange={(e) => setEditDraft((d) => ({ ...d, concurrents: e.target.value }))}
                                  className="w-[55px] rounded-sm border border-green-500/30 bg-black px-2 py-1.5 text-[11px] text-green-400 focus:outline-none focus:shadow-[0_0_10px_rgba(0,255,65,0.2)]"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-[9px] uppercase tracking-wider text-gray-600">Geo</label>
                                <select
                                  value={editDraft.geo}
                                  onChange={(e) => setEditDraft((d) => ({ ...d, geo: e.target.value }))}
                                  className="appearance-none rounded-sm border border-green-500/30 bg-black px-2 py-1.5 text-[11px] text-green-400 focus:outline-none focus:shadow-[0_0_10px_rgba(0,255,65,0.2)]"
                                >
                                  {LOOP_GEO_OPTIONS.map((g) => (
                                    <option key={g.value} value={g.value}>{g.label}</option>
                                  ))}
                                </select>
                              </div>
                              <button
                                onClick={() => handleSaveEdit(loopId)}
                                disabled={savingEdit}
                                className="h-8 rounded-sm border border-green-500/40 bg-green-500/10 px-4 text-[11px] text-green-400 transition-all hover:bg-green-500/20 disabled:opacity-50"
                              >
                                {savingEdit ? 'kaydediliyor...' : 'Kaydet'}
                              </button>
                              <button
                                onClick={() => setEditingLoopId(null)}
                                disabled={savingEdit}
                                className="h-8 rounded-sm border border-white/10 px-4 text-[11px] text-gray-500 transition-colors hover:border-white/20 hover:text-gray-300 disabled:opacity-50"
                              >
                                İptal
                              </button>
                              <span className="w-full text-[10px] text-gray-700"># yeni ayarlar bir sonraki turdan itibaren geçerli olur</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    {loop.lastError && (
                      <tr className="border-b border-dashed border-green-500/10">
                        <td colSpan={7} className="px-3 pb-3 pt-1">
                          <div className="flex items-center gap-2 rounded-sm border border-[#ff2d2d]/45 border-l-[3px] border-l-[#ff2d2d] bg-[#ff2d2d]/10 px-3 py-2 text-[11px] text-[#ff5c5c] [text-shadow:0_0_6px_rgba(255,45,45,0.4)]">
                            <span className="flex-shrink-0 font-bold text-[#ff2d2d]">[ERR]</span>
                            <span className="truncate" title={loop.lastError}>son hata: {loop.lastError}</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default LoopManager;
