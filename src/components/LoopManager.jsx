import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';

const LoopManager = () => {
  const { state, setLoops, addLog, showToast } = useStressTest();
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);

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
    <div className="glass-panel rounded-xl p-6 hover-glow transition-all duration-300">
      <div className="flex items-center justify-between mb-4">
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
          <p>Aktif loop bulunmuyor.</p>
          <p className="text-xs mt-2">Saldırı formundan loop başlatabilirsiniz.</p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-2 px-2">
          <table className="w-full min-w-[800px] text-sm border-separate border-spacing-y-1">
            <thead>
              <tr className="text-gray-500 border-b border-white/10 text-left">
                <th className="px-4 py-3 font-medium min-w-[260px]">Hedef</th>
                <th className="px-4 py-3 font-medium">Yöntem</th>
                <th className="px-4 py-3 font-medium text-center whitespace-nowrap">Süre (sn)</th>
                <th className="px-4 py-3 font-medium text-center whitespace-nowrap">Bekleme (sn)</th>
                <th className="px-4 py-3 font-medium text-center whitespace-nowrap">Set</th>
                <th className="px-4 py-3 font-medium text-center whitespace-nowrap">Hata</th>
                <th className="px-4 py-3 font-medium text-right">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {loops.map(([loopId, loop]) => (
                <tr key={loopId} className="border-b border-white/5 hover:bg-white/[0.03] transition-all duration-300">
                  <td className="px-4 py-3.5 pr-4">
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
                        {formatTargetForDisplay(loop.displayTarget || loop.params?.host || '', loop.params?.layer)}
                      </span>
                      <span
                        className={`absolute inset-0 flex items-center text-left text-green-400 text-xs font-bold transition-opacity duration-200 ${
                          copiedKey === loopId ? 'opacity-100' : 'opacity-0'
                        }`}
                      >
                        Kopyalandı!
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="px-3 py-1.5 bg-black/60 border border-white/10 rounded-md text-xs text-white whitespace-nowrap">
                      {loop.params?.method?.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-gray-300 font-mono text-center whitespace-nowrap">{loop.params?.time}s</td>
                  <td className="px-4 py-3.5 text-gray-300 font-mono text-center whitespace-nowrap">{loop.params?.interval}s</td>
                  <td className="px-4 py-3.5 text-cyan-400 font-mono font-bold text-center whitespace-nowrap">{loop.roundCount || 0}</td>
                  <td className="px-4 py-3.5 text-red-400 font-mono text-center whitespace-nowrap">{loop.errors || 0}</td>
                  <td className="px-4 py-3.5 text-right">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default LoopManager;
