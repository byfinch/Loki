import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';

const USE_MOCK_HISTORY = false; // Lokal test icin true, deploy oncesi false yap

const MOCK_HISTORY = [
  {
    historyId: 'hist_mock_001',
    username: 'testuser',
    target: '1.1.1.1',
    port: 53,
    method: 'DNS',
    time: 120,
    concurrents: 5,
    loop: false,
    status: 'completed',
    startedAt: new Date(Date.now() - 120000).toISOString(),
    endedAt: new Date().toISOString(),
    attackIds: ['atk_001']
  },
  {
    historyId: 'hist_mock_002',
    username: 'testuser',
    target: 'example.com',
    port: 443,
    method: 'HTTP-TEMPESTA',
    time: 300,
    concurrents: 10,
    loop: true,
    status: 'active',
    startedAt: new Date(Date.now() - 60000).toISOString(),
    endedAt: null,
    attackIds: ['atk_loop_001']
  },
  {
    historyId: 'hist_mock_003',
    username: 'testuser',
    target: '8.8.8.8',
    port: 80,
    method: 'HOME',
    time: 60,
    concurrents: 1,
    loop: false,
    status: 'stopped',
    startedAt: new Date(Date.now() - 180000).toISOString(),
    endedAt: new Date(Date.now() - 150000).toISOString(),
    attackIds: ['atk_002']
  }
];

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

    if (USE_MOCK_HISTORY) {
      setAttackHistory(MOCK_HISTORY);
      return;
    }

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

  const fallbackCopy = (text) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      document.body.removeChild(ta);
      return false;
    }
  };

  const copyToClipboard = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return fallbackCopy(text);
  };

  const handleCopyTarget = async (target, key) => {
    try {
      const ok = await copyToClipboard(target);
      if (ok) {
        setCopiedKey(key);
        addLog(`Hedef kopyalandı: ${target}`);
        setTimeout(() => setCopiedKey(null), 1500);
      } else {
        throw new Error('Kopyalama başarısız');
      }
    } catch (err) {
      addLog(`Kopyalama hatası: ${err.message}`);
      showToast('Kopyalama başarısız', 'error');
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
    <div className="glass-panel rounded-xl p-6 hover-glow transition-all duration-300 w-full">
      <div className="flex items-center gap-4 mb-4">
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
          <table className="w-full text-sm border-separate border-spacing-y-1">
            <thead>
              <tr className="text-gray-500 border-b border-white/10 text-left">
                <th className="px-2 py-3 font-medium">Hedef</th>
                <th className="px-2 py-3 font-medium text-center">Port</th>
                <th className="px-2 py-3 font-medium">Yöntem</th>
                <th className="px-2 py-3 font-medium text-center">Süre</th>
                <th className="px-2 py-3 font-medium text-center">Conc.</th>
                <th className="px-2 py-3 font-medium text-center">Tür</th>
                <th className="px-2 py-3 font-medium text-center">Durum</th>
                <th className="px-2 py-3 font-medium">Başlangıç</th>
                <th className="px-2 py-3 font-medium">Bitiş</th>
              </tr>
            </thead>
            <tbody>
              {paginatedRecords.map((record) => (
                <tr
                  key={record.historyId}
                  className="border-b border-white/5 hover:bg-white/[0.03] transition-colors h-12"
                >
                  <td className="px-2 py-3">
                    <button
                      onClick={() => handleCopyTarget(record.target, record.historyId)}
                      title="Hedefi kopyala"
                      className="text-left text-gray-200 font-mono text-xs hover:text-green-400 transition-colors"
                    >
                      {copiedKey === record.historyId ? (
                        <span className="text-green-400 text-xs font-bold">Kopyalandı!</span>
                      ) : (
                        record.target
                      )}
                    </button>
                  </td>
                  <td className="px-2 py-3 text-gray-300 font-mono text-center text-xs">
                    {record.port || '-'}
                  </td>
                  <td className="px-2 py-3">
                    <span className="px-2 py-1 bg-black/60 border border-white/10 rounded-md text-xs text-white whitespace-nowrap">
                      {record.method}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-gray-300 font-mono text-center text-xs">
                    {record.time}s
                  </td>
                  <td className="px-2 py-3 text-gray-300 font-mono text-center text-xs">
                    x{record.concurrents}
                  </td>
                  <td className="px-2 py-3 text-center">
                    <span className={`inline-flex items-center justify-center w-12 px-1 py-0.5 rounded text-xs border ${record.loop ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' : 'bg-gray-500/10 text-gray-400 border-gray-500/30'}`}>
                      {record.loop ? 'Loop' : 'Tek'}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-center">
                    {statusBadge(record.status)}
                  </td>
                  <td className="px-2 py-3 text-gray-400 text-[11px] whitespace-nowrap">
                    {formatDate(record.startedAt)}
                  </td>
                  <td className="px-2 py-3 text-gray-400 text-[11px] whitespace-nowrap">
                    {record.status === 'active' ? '-' : formatDate(record.endedAt)}
                  </td>
                </tr>
              ))}
              {Array.from({ length: Math.max(0, itemsPerPage - paginatedRecords.length) }).map((_, idx) => (
                <tr key={`empty-${idx}`} className="border-b border-white/5 h-12">
                  <td className="px-2 py-3" colSpan="9"></td>
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
    </div>
  );
};

export default AttackHistory;
