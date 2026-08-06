import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';
import { renderNoteWithLinks } from '../utils/renderNoteWithLinks.jsx';
import CyberCard from './CyberCard';

const LoopManager = () => {
  const { state, setLoops, addLog, showToast } = useStressTest();
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [editingLoopId, setEditingLoopId] = useState(null);
  const [editDraft, setEditDraft] = useState({ note: '', time: 0, interval: 0, concurrents: 1 });
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = (loopId, loop) => {
    setEditingLoopId(loopId);
    setEditDraft({
      note: loop.note || '',
      time: parseInt(loop.params?.time, 10) || 0,
      interval: parseInt(loop.params?.interval, 10) || 0,
      concurrents: parseInt(loop.params?.concurrents, 10) || 1
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
        concurrents: parseInt(editDraft.concurrents, 10)
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
    <CyberCard className="p-6 sm:p-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          Aktif Looplar
          <span className="ml-2 px-2 py-0.5 bg-black/60 border border-white/10 rounded text-xs text-cyan-400 font-mono">
            {loops.length}
          </span>
        </h2>
        {loops.length > 0 && (
          <button
            onClick={handleStopAll}
            disabled={loading === '__ALL__'}
            className="text-xs bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 px-3 py-1.5 rounded-full transition-all duration-300 hover:shadow-[0_0_15px_rgba(239,68,68,0.25)] disabled:opacity-50 flex items-center justify-center h-7 w-28"
          >
            {loading === '__ALL__' ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : 'Tümünü Kapat'}
          </button>
        )}
      </div>

      {loops.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p>Bu hesapta aktif loop yok.</p>
          <p className="text-xs mt-2">Saldırı formundan loop başlatabilirsiniz.</p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-2 px-2">
          <table className="cyber-table w-full min-w-[800px] text-sm border-separate border-spacing-y-2">
            <thead>
              <tr className="text-gray-500 border-b border-white/10 text-left">
                <th className="px-5 py-4 font-medium min-w-[260px]">Hedef</th>
                <th className="px-5 py-4 font-medium">Yöntem</th>
                <th className="px-5 py-4 font-medium text-center whitespace-nowrap">Süre (sn)</th>
                <th className="px-5 py-4 font-medium text-center whitespace-nowrap">Bekleme (sn)</th>
                <th className="px-5 py-4 font-medium text-center whitespace-nowrap">Set</th>
                <th className="px-5 py-4 font-medium text-center whitespace-nowrap">Hata</th>
                <th className="px-5 py-4 font-medium text-right">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {loops.map(([loopId, loop]) => (
                <React.Fragment key={loopId}>
                <tr className="border-b border-white/5 hover:bg-white/[0.03] transition-all duration-300">
                  <td className="px-5 py-4 pr-4">
                    <button
                      onClick={() => handleCopyTarget(loop.displayTarget || loop.params?.host || '', loopId, loop.params?.layer)}
                      title="URL'yi kopyala"
                      className="relative block text-left w-[220px] h-5 cursor-pointer"
                    >
                      <span
                        className={`absolute inset-0 text-left text-gray-200 font-mono text-[13px] truncate hover:text-green-400 transition-opacity duration-200 ${
                          copiedKey === loopId ? 'opacity-0' : 'opacity-100'
                        }`}
                      >
                        {formatTargetShort(formatTargetForDisplay(loop.displayTarget || loop.params?.host || '', loop.params?.layer))}
                      </span>
                      <span
                        className={`absolute inset-0 flex items-center text-left text-green-400 text-xs font-bold transition-opacity duration-200 ${
                          copiedKey === loopId ? 'opacity-100' : 'opacity-0'
                        }`}
                      >
                        Kopyalandı!
                      </span>
                    </button>
                    {loop.note && (
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] font-mono text-cyan-400">
                        <span className="text-gray-600">📝</span>
                        <span className="truncate max-w-[240px]" title={loop.note}>{renderNoteWithLinks(loop.note)}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <span className="px-3 py-1.5 bg-black/60 border border-white/10 rounded-md text-xs text-white whitespace-nowrap">
                      {loop.params?.method?.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-gray-300 font-mono text-center whitespace-nowrap">{loop.params?.time}s</td>
                  <td className="px-5 py-4 text-gray-300 font-mono text-center whitespace-nowrap">{loop.params?.interval}s</td>
                  <td className="px-5 py-4 text-cyan-400 font-mono font-bold text-center whitespace-nowrap">{loop.roundCount || 0}</td>
                  <td className="px-5 py-4 text-red-400 font-mono text-center whitespace-nowrap">{loop.errors || 0}</td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => (editingLoopId === loopId ? setEditingLoopId(null) : startEdit(loopId, loop))}
                        title="Not / saldırı ayarlarını düzenle"
                        className={`text-xs border rounded-full transition-all duration-300 flex items-center justify-center h-8 w-8 ${
                          editingLoopId === loopId
                            ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-400'
                            : 'bg-white/5 hover:bg-cyan-500/10 border-white/10 hover:border-cyan-500/30 text-gray-400 hover:text-cyan-400'
                        }`}
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => handleStop(loopId)}
                        disabled={loading === loopId}
                        className="text-xs bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 rounded-full transition-all duration-300 hover:shadow-[0_0_15px_rgba(239,68,68,0.25)] disabled:opacity-50 whitespace-nowrap flex items-center justify-center h-8 w-20"
                      >
                        {loading === loopId ? (
                          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                        ) : 'Çıkar'}
                      </button>
                    </div>
                  </td>
                </tr>
                {editingLoopId === loopId && (
                  <tr className="border-b border-white/5">
                    <td colSpan={7} className="px-5 pb-4 pt-1">
                      <div className="flex flex-wrap items-end gap-3 bg-black/40 border border-cyan-500/20 rounded-lg p-3">
                        <div className="flex-1 min-w-[220px]">
                          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Not</label>
                          <input
                            type="text"
                            value={editDraft.note}
                            maxLength={120}
                            onChange={(e) => setEditDraft((d) => ({ ...d, note: e.target.value }))}
                            placeholder="Marka / asıl site linki"
                            className="w-full bg-black/60 border border-dashed border-cyan-500/35 rounded px-2.5 py-1.5 text-xs text-cyan-300 font-mono placeholder-gray-600 focus:outline-none focus:border-cyan-400/60"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Süre (sn)</label>
                          <input
                            type="number"
                            min={0}
                            value={editDraft.time}
                            onChange={(e) => setEditDraft((d) => ({ ...d, time: e.target.value }))}
                            className="w-20 bg-black/60 border border-white/10 rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-green-400/50"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Bekleme (sn)</label>
                          <input
                            type="number"
                            min={0}
                            value={editDraft.interval}
                            onChange={(e) => setEditDraft((d) => ({ ...d, interval: e.target.value }))}
                            className="w-20 bg-black/60 border border-white/10 rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-green-400/50"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Adet</label>
                          <input
                            type="number"
                            min={1}
                            value={editDraft.concurrents}
                            onChange={(e) => setEditDraft((d) => ({ ...d, concurrents: e.target.value }))}
                            className="w-16 bg-black/60 border border-white/10 rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-green-400/50"
                          />
                        </div>
                        <button
                          onClick={() => handleSaveEdit(loopId)}
                          disabled={savingEdit}
                          className="text-xs bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/30 rounded-full px-4 h-8 transition-all duration-300 hover:shadow-[0_0_15px_rgba(0,255,65,0.25)] disabled:opacity-50"
                        >
                          {savingEdit ? 'Kaydediliyor...' : 'Kaydet'}
                        </button>
                        <button
                          onClick={() => setEditingLoopId(null)}
                          disabled={savingEdit}
                          className="text-xs bg-white/5 hover:bg-white/10 text-gray-400 border border-white/10 rounded-full px-4 h-8 transition-colors disabled:opacity-50"
                        >
                          İptal
                        </button>
                        <span className="w-full text-[10px] text-gray-600 font-mono">Yeni ayarlar bir sonraki turdan itibaren geçerli olur; çalışan tur etkilenmez.</span>
                      </div>
                    </td>
                  </tr>
                )}
                {loop.lastError && (
                  <tr className="border-b border-white/5">
                    <td colSpan={7} className="px-5 pb-3 pt-0 text-[11px] text-red-400/90 font-mono truncate" title={loop.lastError}>
                      Son hata: {loop.lastError}
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CyberCard>
  );
};

export default LoopManager;
