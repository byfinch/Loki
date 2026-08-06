import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';
import { renderNoteWithLinks } from '../utils/renderNoteWithLinks.jsx';

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

  const statusText = (status) => {
    if (status === 'active') return <span className="text-green-400 [text-shadow:0_0_6px_rgba(0,255,65,0.6)]">[OK] aktif</span>;
    if (status === 'stopped') return <span className="text-red-400">[!!] durd.</span>;
    if (status === 'completed') return <span className="text-gray-500">[--] tamam</span>;
    return <span className="text-gray-500">{status}</span>;
  };

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
        <span className="text-green-300/90">root@loki:~/saldiri-gecmisi</span>
        <span className="text-green-500/60">$ tail -f --lines={state.attackHistory.length}</span>
        <span className="animate-pulse">▊</span>
      </div>

      <div className="relative z-10 p-4 sm:p-5">
        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="grep -i 'hedef|yontem|port|durum'..."
            className="min-w-0 flex-1 rounded-sm border border-green-500/30 bg-black px-3 py-2 text-xs text-green-400 placeholder-green-500/40 transition focus:outline-none focus:shadow-[0_0_12px_rgba(0,255,65,0.2)]"
          />
          <div className="flex flex-shrink-0 gap-2">
            {[
              { id: 'all', label: 'Tümü' },
              { id: 'active', label: 'Aktif' },
              { id: 'completed', label: 'Tamamlandı' },
              { id: 'stopped', label: 'Durduruldu' }
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`inline-flex h-7 items-center justify-center rounded-sm border px-3 text-[11px] transition-all ${
                  filter === f.id
                    ? 'border-green-500/50 bg-green-500/15 text-green-400 shadow-[0_0_8px_rgba(0,255,65,0.3)]'
                    : 'border-green-500/20 text-green-500/50 hover:border-green-500/40 hover:text-green-400'
                }`}
              >
                {f.label}
              </button>
            ))}
            <button
              onClick={handleClearHistory}
              disabled={loading || state.attackHistory.length === 0}
              className="inline-flex h-7 items-center justify-center rounded-sm border border-red-500/30 px-3 text-[11px] text-red-400 transition-all hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Temizle
            </button>
          </div>
        </div>

        {loading && state.attackHistory.length === 0 ? (
          <div className="py-12 text-center text-green-500/50">
            <p>gecmis yukleniyor...</p>
          </div>
        ) : filteredRecords.length === 0 ? (
          <div className="py-12 text-center text-green-500/50">
            <p>kayit bulunamadi.</p>
          </div>
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-green-500/25 text-left text-[10px] text-green-500/50">
                  <th className="px-3 py-2 font-normal">&gt; Hedef</th>
                  <th className="px-3 py-2 font-normal">&gt; Not</th>
                  <th className="px-3 py-2 text-center font-normal">&gt; Port</th>
                  <th className="px-3 py-2 font-normal">&gt; Yöntem</th>
                  <th className="px-3 py-2 text-center font-normal">&gt; Süre</th>
                  <th className="px-3 py-2 text-center font-normal">&gt; Conc.</th>
                  <th className="px-3 py-2 text-center font-normal">&gt; Tür</th>
                  <th className="px-3 py-2 font-normal">&gt; Durum</th>
                  <th className="px-3 py-2 font-normal">&gt; Başlangıç</th>
                  <th className="px-3 py-2 font-normal">&gt; Bitiş</th>
                </tr>
              </thead>
              <tbody>
                {paginatedRecords.map((record) => (
                  <tr
                    key={record.historyId}
                    className="border-b border-dashed border-green-500/10 transition-colors hover:bg-green-500/5"
                  >
                    <td className="px-3 py-2.5 align-middle">
                      <div className="flex items-center gap-2">
                        <span
                          title="URL'yi kopyala"
                          onClick={() => handleCopyTarget(record.target, record.historyId, record.layer, record.method)}
                          className="inline-block w-[180px] cursor-pointer truncate text-left text-green-200 transition-colors hover:text-green-400"
                        >
                          {formatTargetShort(formatTargetForDisplay(record.target, record.layer, record.method))}
                        </span>
                        <button
                          onClick={() => handleCopyTarget(record.target, record.historyId, record.layer, record.method)}
                          title="URL'yi kopyala"
                          className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm border transition-colors duration-200 ${
                            copiedKey === record.historyId
                              ? 'border-green-500/40 bg-green-500/20 text-green-400'
                              : 'border-green-500/15 bg-green-500/5 text-green-500/50 hover:border-green-500/40 hover:text-green-400'
                          }`}
                        >
                          {copiedKey === record.historyId ? (
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
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2.5 text-[11px]">
                      {record.note ? (
                        <span title={record.note}>{renderNoteWithLinks(record.note)}</span>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center text-gray-400">{record.port || '-'}</td>
                    <td className="px-3 py-2.5 text-gray-200">{record.method}</td>
                    <td className="px-3 py-2.5 text-center text-gray-400">{record.time}s</td>
                    <td className="px-3 py-2.5 text-center text-gray-400">x{record.concurrents}</td>
                    <td className="px-3 py-2.5 text-center">
                      {record.loop ? <span className="text-cyan-400">loop</span> : <span className="text-gray-500">tek</span>}
                    </td>
                    <td className="px-3 py-2.5">{statusText(record.status)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[11px] text-gray-500">{formatDate(record.startedAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[11px] text-gray-500">
                      {record.status === 'active' ? '-' : formatDate(record.endedAt)}
                    </td>
                  </tr>
                ))}
                {Array.from({ length: Math.max(0, itemsPerPage - paginatedRecords.length) }).map((_, idx) => (
                  <tr key={`empty-${idx}`} className="h-9 border-b border-dashed border-green-500/10">
                    <td className="px-3 py-2.5" colSpan={10}></td>
                  </tr>
                ))}
              </tbody>
            </table>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between border-t border-green-500/20 pt-4">
                <span className="text-[11px] text-green-500/50">
                  sayfa {currentPage}/{totalPages} · {filteredRecords.length} kayit
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="rounded-sm border border-green-500/20 px-3 py-1.5 text-[11px] text-green-500/60 transition-all hover:border-green-500/40 hover:text-green-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    &lt; onceki
                  </button>
                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="rounded-sm border border-green-500/20 px-3 py-1.5 text-[11px] text-green-500/60 transition-all hover:border-green-500/40 hover:text-green-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    sonraki &gt;
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default AttackHistory;
