import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';

const REFRESH_INTERVAL_MS = 10000;
const ITEMS_PER_PAGE = 15;

// Risk bantlari: kritik kirmizi / yuksek turuncu / orta cyan (net ayrim)
const BAND_STYLES = {
  critical: { label: 'KRİTİK', className: 'text-[#ff2d2d] [text-shadow:0_0_8px_rgba(255,45,45,0.6)]' },
  high: { label: 'YÜKSEK', className: 'text-[#fb923c]' },
  medium: { label: 'ORTA', className: 'text-cyan-400' },
  low: { label: 'DÜŞÜK', className: 'text-gray-500' }
};

const BAND_DOTS = {
  critical: '#ff2d2d',
  high: '#fb923c',
  medium: '#00d4ff'
};

// 'YYYY-MM-DD HH:MM:SS UTC' -> tr-TR yerel tarih metni
function formatPhishDate(createdAt) {
  if (!createdAt) return '-';
  const iso = String(createdAt).slice(0, 19).replace(' ', 'T') + 'Z';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

const PhishPanel = () => {
  const { state, setAttackPrefill, setActiveTab, showToast } = useStressTest();
  const [stats, setStats] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [bandFilter, setBandFilter] = useState('all'); // all, critical, high, medium
  const [currentPage, setCurrentPage] = useState(1);
  const [copiedId, setCopiedId] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const params = { limit: ITEMS_PER_PAGE, offset: (currentPage - 1) * ITEMS_PER_PAGE };
      if (bandFilter !== 'all') params.band = bandFilter;
      const [statsData, alertsData] = await Promise.all([
        apiClient.getPhishStats(),
        apiClient.getPhishAlerts(params)
      ]);
      setStats(statsData.stats || null);
      setAlerts(alertsData.alerts || []);
      setTotal(alertsData.total ?? 0);
      setUnavailable(false);
    } catch (err) {
      // Backend 503 (entegrasyon devre disi) veya ag hatasi: bos durum goster
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, [bandFilter, currentPage]);

  useEffect(() => {
    if (!state.isAuthenticated) return;
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [state.isAuthenticated, fetchData]);

  // Filtre degisince ilk sayfaya don
  useEffect(() => {
    setCurrentPage(1);
  }, [bandFilter]);

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE) || 1;

  // Sayfa numarasi kisayollarinda bos sayfada kalmayi onle
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [totalPages, currentPage]);

  const handleCopyDomain = async (domain, id) => {
    const ok = await copyTextToClipboard(domain);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
    } else {
      showToast('Kopyalama başarısız', 'error');
    }
  };

  const handleTakeTarget = (domain) => {
    setAttackPrefill({ host: domain, layer: 'L7', port: 443 });
    setActiveTab('attack');
    showToast(`Hedef alındı: ${domain}`, 'success');
  };

  // Sayfa numaralari: aktif +-2, ilk/son ve ellipsis
  const pageNumbers = () => {
    const pages = [];
    const push = (v) => { if (!pages.includes(v)) pages.push(v); };
    push(1);
    for (let p = currentPage - 2; p <= currentPage + 2; p += 1) {
      if (p > 1 && p < totalPages) push(p);
    }
    if (totalPages > 1) push(totalPages);
    const out = [];
    pages.forEach((p, i) => {
      if (i > 0 && p - pages[i - 1] > 1) out.push('…');
      out.push(p);
    });
    return out;
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
        <span className="text-green-300/90">root@loki:~/phishguard</span>
        <span className="text-green-500/60">$ tail -f alerts.log</span>
        <span className="animate-pulse">▊</span>
        {stats?.lastRun?.finishedAt && (
          <span className="ml-auto whitespace-nowrap text-[10px] text-green-500/50">
            son tarama: {formatPhishDate(stats.lastRun.finishedAt)}
          </span>
        )}
      </div>

      <div className="relative z-10 p-4 sm:p-5">
        {/* Istatistik + filtre seridi */}
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[10px]">
          {stats && (
            <>
              <span className="rounded-sm border border-green-500/30 bg-green-500/[0.06] px-2.5 py-1 text-green-400">
                toplam: {stats.total}
              </span>
              <span className="rounded-sm border border-white/15 bg-white/[0.03] px-2.5 py-1 text-gray-400">
                24s: {stats.last24h}
              </span>
              <span className="rounded-sm border border-[#ff2d2d]/40 bg-[#ff2d2d]/[0.07] px-2.5 py-1 text-[#ff5c5c]">
                kritik: {stats.bands?.critical ?? 0}
              </span>
              <span className="rounded-sm border border-[#fb923c]/40 bg-[#fb923c]/[0.06] px-2.5 py-1 text-[#fb923c]">
                yüksek: {stats.bands?.high ?? 0}
              </span>
              <span className="rounded-sm border border-cyan-500/30 bg-cyan-500/[0.06] px-2.5 py-1 text-cyan-400">
                orta: {stats.bands?.medium ?? 0}
              </span>
            </>
          )}
          <span className="ml-auto inline-flex overflow-hidden rounded-sm border border-green-500/25">
            {[
              { id: 'all', label: 'tümü' },
              { id: 'critical', label: 'kritik' },
              { id: 'high', label: 'yüksek' },
              { id: 'medium', label: 'orta' }
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setBandFilter(f.id)}
                className={`px-3 py-1.5 text-[10px] transition-all ${
                  bandFilter === f.id
                    ? 'bg-green-500/15 text-green-400'
                    : 'text-green-500/50 hover:text-green-400'
                }`}
              >
                {f.id !== 'all' && (
                  <span
                    className="mr-1 inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: BAND_DOTS[f.id] }}
                  />
                )}
                {f.label}
              </button>
            ))}
          </span>
        </div>

        {unavailable ? (
          <div className="py-12 text-center text-green-500/50">
            <p>phishguard entegrasyonu kullanılamıyor.</p>
            <p className="mt-2 text-[10px] text-green-500/30"># veritabanına ulaşılamadı veya entegrasyon devre dışı</p>
          </div>
        ) : loading && alerts.length === 0 ? (
          <div className="py-12 text-center text-green-500/50">
            <p>uyarilar yukleniyor...</p>
          </div>
        ) : alerts.length === 0 ? (
          <div className="py-12 text-center text-green-500/50">
            <p>uyari bulunamadi.</p>
          </div>
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-green-500/25 text-left text-[10px] text-green-500/50">
                  <th className="whitespace-nowrap px-3 py-2 font-normal">&gt; #id</th>
                  <th className="whitespace-nowrap px-3 py-2 font-normal">&gt; domain</th>
                  <th className="whitespace-nowrap px-3 py-2 font-normal">&gt; marka</th>
                  <th className="whitespace-nowrap px-3 py-2 text-center font-normal">&gt; skor</th>
                  <th className="whitespace-nowrap px-3 py-2 font-normal">&gt; risk</th>
                  <th className="whitespace-nowrap px-3 py-2 font-normal">&gt; tarih</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-normal">&gt; aksiyon</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => {
                  const band = BAND_STYLES[alert.band] || BAND_STYLES.low;
                  return (
                    <tr
                      key={alert.id}
                      className="border-b border-dashed border-green-500/10 transition-colors hover:bg-green-500/5"
                    >
                      <td className="whitespace-nowrap px-3 py-2.5 text-[10px] text-gray-600">
                        #{alert.id}
                      </td>
                      <td className="px-3 py-2.5 align-middle">
                        <div className="flex items-center gap-2">
                          <span
                            title="Domain'i kopyala"
                            onClick={() => handleCopyDomain(alert.domain, alert.id)}
                            className="inline-block max-w-[220px] cursor-pointer truncate text-left text-green-200 transition-colors hover:text-green-400"
                          >
                            {alert.domain}
                          </span>
                          <button
                            onClick={() => handleCopyDomain(alert.domain, alert.id)}
                            title="Domain'i kopyala"
                            className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm border transition-colors duration-200 ${
                              copiedId === alert.id
                                ? 'border-green-500/40 bg-green-500/20 text-green-400'
                                : 'border-green-500/15 bg-green-500/5 text-green-500/50 hover:border-green-500/40 hover:text-green-400'
                            }`}
                          >
                            {copiedId === alert.id ? (
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
                      <td className="whitespace-nowrap px-3 py-2.5 text-gray-400">{alert.brand || '-'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-center text-gray-200">{alert.score}</td>
                      <td className={`whitespace-nowrap px-3 py-2.5 text-[11px] font-bold ${band.className}`}>
                        {band.label}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-[10px] text-gray-500">
                        {formatPhishDate(alert.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right">
                        <button
                          onClick={() => handleTakeTarget(alert.domain)}
                          title="Bu domain'i saldırı hedefi yap"
                          className="rounded-sm border border-red-500/35 bg-red-500/[0.08] px-3 py-1 text-[10px] text-red-400 transition-all hover:bg-red-500/15 hover:shadow-[0_0_12px_rgba(248,113,113,0.2)]"
                        >
                          &gt;&gt; hedef al
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Sayfalama */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between border-t border-green-500/20 pt-3 text-[10px] text-green-500/50">
                <span>sayfa {currentPage}/{totalPages} · {total} kayıt</span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="rounded-sm border border-green-500/20 px-3 py-1 text-green-500/60 transition-all hover:border-green-500/40 hover:text-green-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    &lt; önceki
                  </button>
                  {pageNumbers().map((p, i) =>
                    p === '…' ? (
                      <span key={`e${i}`} className="px-1 text-gray-600">…</span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => setCurrentPage(p)}
                        className={`rounded-sm px-2.5 py-1 transition-all ${
                          p === currentPage
                            ? 'border border-green-500/40 bg-green-500/[0.08] text-green-400'
                            : 'text-gray-500 hover:text-green-400'
                        }`}
                      >
                        {p}
                      </button>
                    )
                  )}
                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="rounded-sm border border-green-500/20 px-3 py-1 text-green-500/60 transition-all hover:border-green-500/40 hover:text-green-400 disabled:cursor-not-allowed disabled:opacity-40"
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

export default PhishPanel;
