import React, { useEffect, useState } from 'react';
import CyberCard from './CyberCard';
import { apiClient } from '../services/apiClient';

/**
 * Etki Monitoru (Faz 1)
 * Aktif saldiri/loop hedeflerinin check-host.net olcumlerini gosterir.
 * 30 sn'de bir /api/impact poll eder.
 */

const POLL_MS = 30000;

const STATE_BADGES = {
  up: { icon: '🟢', label: 'Ayakta', cls: 'text-green-400 border-green-500/30 bg-green-500/10' },
  degraded: { icon: '🟠', label: 'Yavaşlıyor', cls: 'text-orange-400 border-orange-500/30 bg-orange-500/10' },
  down: { icon: '🔴', label: 'Düştü', cls: 'text-red-400 border-red-500/30 bg-red-500/10' },
  measuring: { icon: '⚪', label: 'Ölçülüyor', cls: 'text-gray-400 border-gray-500/30 bg-gray-500/10' }
};

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('tr-TR', { hour12: false });
}

function formatNext(nextCheckAt) {
  if (!nextCheckAt) return null;
  const diffMs = nextCheckAt - Date.now();
  if (diffMs <= 0) return '<1 dk';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `~${Math.max(1, mins)} dk`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `~${hours} sa ${rem} dk` : `~${hours} sa`;
}

function shortenHost(host) {
  if (!host) return '—';
  return host.length > 28 ? `${host.slice(0, 25)}...` : host;
}

function nodeShortName(node) {
  // tr1.node.check-host.net -> tr1
  return String(node || '').split('.')[0] || node;
}

const ImpactMonitor = () => {
  const [targets, setTargets] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await apiClient.getImpact();
        if (cancelled) return;
        setTargets(data.targets || []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err.message);
      }
    };

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <CyberCard className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-green-400 font-mono flex items-center gap-2">
          <i className="ph ph-pulse text-base"></i>
          Etki Monitörü
        </h3>
        <span className="text-[10px] text-gray-500 font-mono">check-host.net · 30sn</span>
      </div>

      {error && (
        <div className="text-xs text-red-400 font-mono">Veri alınamadı: {error}</div>
      )}

      {!error && targets.length === 0 && (
        <div className="text-xs text-gray-500 font-mono py-6 text-center">
          Aktif saldırı yok — etki ölçümü saldırı başlayınca görünür.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {targets.map((t) => {
          const badge = STATE_BADGES[t.state] || STATE_BADGES.measuring;
          const next = formatNext(t.nextCheckAt);
          return (
            <div key={t.key} className="rounded-lg border border-white/10 bg-white/5 p-3 flex flex-col gap-2">
              {/* Hedef + durum rozeti */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-white font-mono truncate" title={t.host}>
                    {shortenHost(t.host)}
                  </span>
                  <span className="text-[10px] text-gray-500 font-mono shrink-0">{t.layer}</span>
                  {t.isLoop && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-purple-400 shrink-0">
                      <i className="ph ph-repeat"></i> Loop
                    </span>
                  )}
                  {t.final && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-gray-500/30 bg-gray-500/10 text-gray-400 shrink-0">
                      Final
                    </span>
                  )}
                </div>
                <span className={`text-[11px] font-mono px-2 py-0.5 rounded-full border shrink-0 ${badge.cls}`}>
                  {badge.icon} {badge.label}
                </span>
              </div>

              {/* Gecikme ozeti */}
              <div className="flex items-center gap-4 text-[11px] font-mono text-gray-400">
                <span>
                  Gecikme: <span className="text-white">{t.avgMs != null ? `${t.avgMs} ms` : '—'}</span>
                </span>
                <span>
                  Baseline: <span className="text-white">{t.baselineMs != null ? `${t.baselineMs} ms` : '—'}</span>
                </span>
              </div>

              {/* Node basina mini satirlar */}
              {t.perNode && t.perNode.length > 0 && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {t.perNode.map((n) => (
                    <div key={n.node} className="flex items-center justify-between text-[10px] font-mono">
                      <span className="text-gray-500">{nodeShortName(n.node)}</span>
                      <span className={n.ok ? 'text-green-400' : 'text-red-400'}>
                        {n.ok ? `${n.ms != null ? `${n.ms} ms` : 'ok'}${n.code ? ` · ${n.code}` : ''}` : 'timeout'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Zaman bilgisi */}
              <div className="text-[10px] text-gray-500 font-mono">
                Son ölçüm: {formatTime(t.lastCheckAt)}
                {next ? ` · Sıradaki: ${next}` : (t.final ? ' · Takip tamamlandı' : '')}
              </div>
            </div>
          );
        })}
      </div>
    </CyberCard>
  );
};

export default ImpactMonitor;
