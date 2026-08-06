import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';
import { renderNoteWithLinks } from '../utils/renderNoteWithLinks.jsx';
import CyberCard from './CyberCard';

const AttackHistory = () => {
  const { state, setAttackHistory, addLog, showToast } = useStressTest();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all'); // all, active, completed, stopped
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedKey, setCopiedKey] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => {
    if (!state.isAuthenticated) return;

    const username = apiClient.getUsername();
    if (!username) return;

    const fetchHistory = async () => {
      setLoading(true);
      try {
        const data = await apiClient.getHistory(username);
        setAttackHistory(data.records || []);
      } catch (err) {
        addLog(`Saldırı geçmişi alınamadı: ${err.message}`);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
    const interval = setInterval(fetchHistory, 5000);
    return () => clearInterval(interval);
  }, [state.isAuthenticated]);

  const filteredRecords = state.attackHistory.filter((record) => {
    const statusMatch = filter === 'all' || record.status === filter;
    if (!searchQuery.trim()) return statusMatch;

    const q = searchQuery.toLowerCase();
    const targetMatch = (record.target || '').toLowerCase().includes(q);
    const methodMatch = (record.method || '').toLowerCase().includes(q);
    const portMatch = String(record.port || '').includes(q);
    const statusLabelMap = {
      active: 'aktif',
      completed: 'tamamlandı',
      stopped: 'durduruldu'
    };
    const statusLabelMatch = (statusLabelMap[record.status] || '').includes(q);

    return statusMatch && (targetMatch || methodMatch || portMatch || statusLabelMatch);
  });

  const totalPages = Math.ceil(filteredRecords.length / itemsPerPage) || 1;
  const paginatedRecords = filteredRecords.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [filter, searchQuery]);

  // Poll ile kayit sayisi azalinca bos sayfada kalmayi onle
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(Math.max(1, totalPages));
    }
  }, [totalPages]);

  const L7_METHODS = ['CLOUDFLARE', 'HTTP-TEMPESTA', 'BROWSER', 'BYPASS', 'PPS', 'HTTP-RAWPACKET', 'HTTP-SOCKETS'];

  const formatTargetForDisplay = (target, layer, method) => {
    if (!target || typeof target !== 'string') return target;
    let effectiveLayer = layer;
    if (!effectiveLayer && method) {
      effectiveLayer = L7_METHODS.includes(method.toUpperCase()) ? 'L7' : 'L4';
    }
    let t = target.trim();
    const isL7 = effectiveLayer === 'L7' || /^https?:\/\//i.test(target);
    if (isL7) {
      // L7 hedeflerde portu kaldir, https:// ekle, trailing slash ekle
      t = t.replace(/:(\d+)(?=\/|$)/, '');
      if (!/^https?:\/\//i.test(t)) {
        t = `https://${t}`;
      }
      t = t.replace(/^http:\/\//i, 'https://');
      if (!t.endsWith('/')) {
        t += '/';
      }
    } else {
      // L4 hedeflerde protokol ve portu kaldir, sadece IP/domain birak
      t = t.replace(/^https?:\/\//i, '');
      t = t.replace(/:(\d+)(?=\/|$)/, '');
    }
    return t;
  };

  // Goruntude sade domain; kopyalamada tam URL (formatTargetForDisplay).
  const formatTargetShort = (target) =>
    String(target || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  const handleCopyTarget = async (target, key, layer, method) => {
    const copyTarget = formatTargetForDisplay(target, layer, method);
    try {
      const ok = await copyTextToClipboard(copyTarget);
      if (ok) {
        setCopiedKey(key);
        addLog(`Hedef kopyalandı: ${copyTarget}`);
        setTimeout(() => setCopiedKey(null), 3000);
      } else {
        throw new Error('Kopyalama başarısız');
      }
    } catch (err) {
      addLog(`Kopyalama hatası: ${err.message}`);
      showToast('Kopyalama başarısız', 'error');
    }
  };

  const handleClearHistory = async () => {
    if (!confirm('Tüm saldırı geçmişiniz silinecek. Emin misiniz?')) return;
    setLoading(true);
    try {
      await apiClient.deleteHistory({ all: true });
      setAttackHistory([]);
      addLog('Saldırı geçmişi temizlendi');
      showToast('Saldırı geçmişi temizlendi', 'success');
    } catch (err) {
      addLog(`Geçmiş temizleme hatası: ${err.message}`);
      showToast(`Hata: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleString('tr-TR');
  };

  const statusBadge = (status) => {
    const styles = {
      active: 'bg-green-500/20 text-green-400 border-green-500/30',
      completed: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
      stopped: 'bg-red-500/20 text-red-400 border-red-500/30'
    };
    const labels = {
      active: 'Aktif',
      completed: 'Tamamlandı',
      stopped: 'Durduruldu'
    };
    return (
      <span className={`inline-flex items-center justify-center w-28 px-2 py-1 rounded-md text-xs font-medium border ${styles[status] || 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
        {labels[status] || status}
      </span>
    );
  };

  return (
    <CyberCard className="p-6 sm:p-8 w-full">
      <div className="flex items-center gap-4 mb-6">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 whitespace-nowrap">
          Saldırı Geçmişi
          <span className="ml-2 px-2 py-0.5 bg-black/60 border border-white/10 rounded text-xs text-purple-400 font-mono">
            {state.attackHistory.length}
          </span>
        </h2>

        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Hedef, yöntem, port veya durum ara..."
          className="flex-1 min-w-0 bg-black/60 border border-white/10 rounded-lg px-4 py-2 text-sm text-white placeholder-gray-600 focus:border-purple-400/50 focus:outline-none focus:shadow-[0_0_15px_rgba(168,85,247,0.1)] transition"
        />

        <div className="flex gap-2 flex-shrink-0">
          {[
            { id: 'all', label: 'Tümü' },
            { id: 'active', label: 'Aktif' },
            { id: 'completed', label: 'Tamamlandı' },
            { id: 'stopped', label: 'Durduruldu' }
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`inline-flex items-center justify-center w-24 h-7 rounded-full text-xs font-medium transition-all duration-300 ${
                filter === f.id
                  ? 'bg-purple-500 text-black shadow-[0_0_10px_rgba(168,85,247,0.4)]'
                  : 'bg-white/5 text-gray-400 hover:bg-white/10'
              }`}
            >
              {f.label}
            </button>
          ))}
          <button
            onClick={handleClearHistory}
            disabled={loading || state.attackHistory.length === 0}
            className="inline-flex items-center justify-center px-3 h-7 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Temizle
          </button>
        </div>
      </div>

      {loading && state.attackHistory.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p>Geçmiş yükleniyor...</p>
        </div>
      ) : filteredRecords.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p>Henüz saldırı geçmişi bulunmuyor.</p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-2 px-2">
          <table className="cyber-table w-full text-sm border-separate border-spacing-y-2">
            <thead>
              <tr className="text-gray-500 border-b border-white/10 text-left">
                <th className="px-3 py-3.5 font-medium">Hedef</th>
                <th className="px-3 py-3.5 font-medium text-center">Port</th>
                <th className="px-3 py-3.5 font-medium">Yöntem</th>
                <th className="px-3 py-3.5 font-medium text-center">Süre</th>
                <th className="px-3 py-3.5 font-medium text-center">Conc.</th>
                <th className="px-3 py-3.5 font-medium text-center">Tür</th>
                <th className="px-3 py-3.5 font-medium text-center">Durum</th>
                <th className="px-3 py-3.5 font-medium">Başlangıç</th>
                <th className="px-3 py-3.5 font-medium">Bitiş</th>
              </tr>
            </thead>
            <tbody>
              {paginatedRecords.map((record) => (
                <tr
                  key={record.historyId}
                  className="border-b border-white/5 hover:bg-white/[0.03] transition-colors h-14"
                >
                  <td className="px-3 h-14 align-middle">
                    <div className="flex items-center gap-2 h-full">
                      <span
                        title="URL'yi kopyala"
                          onClick={() => handleCopyTarget(record.target, record.historyId, record.layer, record.method)}
                        className="inline-block text-left text-gray-200 font-mono text-xs truncate w-[180px] hover:text-green-400 transition-colors cursor-pointer"
                      >
                        {formatTargetShort(formatTargetForDisplay(record.target, record.layer, record.method))}
                      </span>
                      <button
                          onClick={() => handleCopyTarget(record.target, record.historyId, record.layer, record.method)}
                        title="URL'yi kopyala"
                        className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center border transition-colors duration-200 ${
                          copiedKey === record.historyId
                            ? 'bg-green-500/20 border-green-500/40 text-green-400'
                            : 'bg-white/5 border-white/10 text-gray-500 hover:text-green-400 hover:border-green-500/30'
                        }`}
                      >
                        {copiedKey === record.historyId ? (
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        ) : (
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                          </svg>
                        )}
                      </button>
                    </div>
                    {record.note && (
                      <div className="mt-0.5 flex items-center gap-1 text-[10px] font-mono text-cyan-400/90">
                        <span className="text-gray-600">📝</span>
                        <span className="truncate max-w-[200px]" title={record.note}>{renderNoteWithLinks(record.note)}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3.5 text-gray-300 font-mono text-center text-xs">
                    {record.port || '-'}
                  </td>
                  <td className="px-3 py-3.5">
                    <span className="px-2 py-1 bg-black/60 border border-white/10 rounded-md text-xs text-white whitespace-nowrap">
                      {record.method}
                    </span>
                  </td>
                  <td className="px-3 py-3.5 text-gray-300 font-mono text-center text-xs">
                    {record.time}s
                  </td>
                  <td className="px-3 py-3.5 text-gray-300 font-mono text-center text-xs">
                    x{record.concurrents}
                  </td>
                  <td className="px-3 py-3.5 text-center">
                    <span className={`inline-flex items-center justify-center w-12 px-1 py-0.5 rounded text-xs border ${record.loop ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' : 'bg-gray-500/10 text-gray-400 border-gray-500/30'}`}>
                      {record.loop ? 'Loop' : 'Tek'}
                    </span>
                  </td>
                  <td className="px-3 py-3.5 text-center">
                    {statusBadge(record.status)}
                  </td>
                  <td className="px-3 py-3.5 text-gray-400 text-[11px] whitespace-nowrap">
                    {formatDate(record.startedAt)}
                  </td>
                  <td className="px-3 py-3.5 text-gray-400 text-[11px] whitespace-nowrap">
                    {record.status === 'active' ? '-' : formatDate(record.endedAt)}
                  </td>
                </tr>
              ))}
              {Array.from({ length: Math.max(0, itemsPerPage - paginatedRecords.length) }).map((_, idx) => (
                <tr key={`empty-${idx}`} className="border-b border-white/5 h-14">
                  <td className="px-3 py-3.5" colSpan={9}></td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/10">
              <span className="text-xs text-gray-500">
                Sayfa {currentPage} / {totalPages} ({filteredRecords.length} kayıt)
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 text-gray-300 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  Önceki
                </button>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 text-gray-300 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  Sonraki
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </CyberCard>
  );
};

export default AttackHistory;
