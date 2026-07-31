import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { useStressTest } from '../context/StressTestContext';
import { copyTextToClipboard } from '../utils/clipboard';
import CyberCard from './CyberCard';

const REFRESH_INTERVAL_MS = 10000;

// Band rozet stilleri (panelin koyu/neon paletine uygun)
const BAND_STYLES = {
  critical: { label: 'KRİTİK', emoji: '🔴', className: 'bg-red-500/10 text-red-400 border-red-500/30' },
  high: { label: 'YÜKSEK', emoji: '🟠', className: 'bg-orange-500/10 text-orange-400 border-orange-500/30' },
  medium: { label: 'ORTA', emoji: '🟡', className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' },
  low: { label: 'DÜŞÜK', emoji: '⚪', className: 'bg-gray-500/10 text-gray-400 border-gray-500/30' }
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
  const [copiedId, setCopiedId] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const params = { limit: 100 };
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
  }, [bandFilter]);

  useEffect(() => {
    if (!state.isAuthenticated) return;
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [state.isAuthenticated, fetchData]);

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

  const statChips = stats
    ? [
        { label: 'Toplam Uyarı', value: stats.total, className: 'text-green-400 border-green-500/30 bg-green-500/10' },
        { label: 'Son 24 Saat', value: stats.last24h, className: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10' },
        { label: '🔴 Kritik', value: stats.bands?.critical ?? 0, className: 'text-red-400 border-red-500/30 bg-red-500/10' },
        { label: '🟠 Yüksek', value: stats.bands?.high ?? 0, className: 'text-orange-400 border-orange-500/30 bg-orange-500/10' },
        { label: '🟡 Orta', value: stats.bands?.medium ?? 0, className: 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10' }
      ]
    : [];

  return (
    <CyberCard className="p-6 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white">PhishGuard Uyarıları</h2>
          <p className="text-[11px] text-gray-500">
            Phishing / klon domain tespitleri
            {stats?.lastRun?.finishedAt ? ` · Son tarama: ${formatPhishDate(stats.lastRun.finishedAt)}` : ''}
          </p>
        </div>
        <div className="inline-flex gap-1 p-1 bg-black/40 border border-white/10 rounded-lg">
          {[
            { id: 'all', label: 'Tümü' },
            { id: 'critical', label: '🔴' },
            { id: 'high', label: '🟠' },
            { id: 'medium', label: '🟡' }
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setBandFilter(f.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all duration-300 ${
                bandFilter === f.id
                  ? 'bg-green-500 text-black shadow-[0_0_10px_rgba(0,255,65,0.4)]'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {statChips.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          {statChips.map((chip) => (
            <div
              key={chip.label}
              className={`px-3 py-1.5 rounded-lg border text-xs font-mono ${chip.className}`}
            >
              <span className="opacity-80">{chip.label}:</span>{' '}
              <span className="font-bold">{chip.value}</span>
            </div>
          ))}
        </div>
      )}

      {unavailable ? (
        <div className="text-center py-12 text-gray-500">
          <i className="ph ph-shield-warning text-3xl mb-3 block text-gray-600"></i>
          <p>PhishGuard entegrasyonu kullanılamıyor</p>
          <p className="text-[11px] text-gray-600 mt-1">Veritabanına ulaşılamadı veya entegrasyon devre dışı.</p>
        </div>
      ) : loading && alerts.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p>Uyarılar yükleniyor...</p>
        </div>
      ) : alerts.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p>Henüz uyarı bulunmuyor.</p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-2 px-2">
          <table className="cyber-table w-full text-sm border-separate border-spacing-y-2">
            <thead>
              <tr className="text-gray-500 border-b border-white/10 text-left">
                <th className="px-3 py-3.5 font-medium">#ID</th>
                <th className="px-3 py-3.5 font-medium">Domain</th>
                <th className="px-3 py-3.5 font-medium">Marka</th>
                <th className="px-3 py-3.5 font-medium text-center">Skor</th>
                <th className="px-3 py-3.5 font-medium text-center">Risk</th>
                <th className="px-3 py-3.5 font-medium">Tarih</th>
                <th className="px-3 py-3.5 font-medium text-center">Aksiyon</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => {
                const band = BAND_STYLES[alert.band] || BAND_STYLES.low;
                return (
                  <tr
                    key={alert.id}
                    className="border-b border-white/5 hover:bg-white/[0.03] transition-colors h-14"
                  >
                    <td className="px-3 py-3.5 text-gray-400 font-mono text-xs whitespace-nowrap">
                      #{alert.id}
                    </td>
                    <td className="px-3 h-14 align-middle">
                      <div className="flex items-center gap-2 h-full">
                        <span
                          title="Domain'i kopyala"
                          onClick={() => handleCopyDomain(alert.domain, alert.id)}
                          className="inline-block text-left text-gray-200 font-mono text-xs truncate w-[200px] hover:text-green-400 transition-colors cursor-pointer"
                        >
                          {alert.domain}
                        </span>
                        <button
                          onClick={() => handleCopyDomain(alert.domain, alert.id)}
                          title="Domain'i kopyala"
                          className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center border transition-colors duration-200 ${
                            copiedId === alert.id
                              ? 'bg-green-500/20 border-green-500/40 text-green-400'
                              : 'bg-white/5 border-white/10 text-gray-500 hover:text-green-400 hover:border-green-500/30'
                          }`}
                        >
                          {copiedId === alert.id ? (
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
                    </td>
                    <td className="px-3 py-3.5">
                      <span className="px-2 py-1 bg-black/60 border border-white/10 rounded-md text-xs text-white whitespace-nowrap">
                        {alert.brand || '-'}
                      </span>
                    </td>
                    <td className="px-3 py-3.5 text-gray-300 font-mono text-center text-xs">
                      {alert.score}
                    </td>
                    <td className="px-3 py-3.5 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border whitespace-nowrap ${band.className}`}>
                        {band.emoji} {band.label}
                      </span>
                    </td>
                    <td className="px-3 py-3.5 text-gray-400 text-[11px] whitespace-nowrap">
                      {formatPhishDate(alert.createdAt)}
                    </td>
                    <td className="px-3 py-3.5 text-center">
                      <button
                        onClick={() => handleTakeTarget(alert.domain)}
                        title="Bu domain'i saldırı hedefi yap"
                        className="px-3 py-1.5 rounded-md text-xs font-bold bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 hover:shadow-[0_0_15px_rgba(239,68,68,0.25)] transition-all duration-300 whitespace-nowrap"
                      >
                        Hedef Al
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[11px] text-gray-600 mt-3">
            {alerts.length} / {total} uyarı gösteriliyor · 10 saniyede bir yenilenir
          </p>
        </div>
      )}
    </CyberCard>
  );
};

export default PhishPanel;
