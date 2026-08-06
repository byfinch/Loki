import React, { useEffect, useMemo, useState } from 'react';
import CyberCard from './CyberCard';
import { apiClient } from '../services/apiClient';

/**
 * Etki Monitoru (Faz 1)
 * Aktif saldiri/loop hedeflerinin check-host.net olcumlerini gosterir.
 * 30 sn'de bir /api/impact poll eder (yalnizca kart gorunurken, lg ve ustu).
 *
 * Liste her zaman onem sirasina gore dizilir:
 * down -> degraded -> redirect -> up -> measuring (kritik durumlar ustte).
 * 4'ten fazla hedef varsa kart sabit yukseklikte kalir, liste dahili kayar
 * (.impact-scroll, index.css).
 */

const POLL_MS = 30000;
const MAX_VISIBLE = 4;

// Onem sirasi: dusuk deger ustte
const STATE_ORDER = { down: 0, degraded: 1, redirect: 2, up: 3, measuring: 4 };

// "Kritik" sayaci: saldirinin etki ettigi durumlar
const CRITICAL_STATES = new Set(['down', 'degraded', 'redirect']);

const STATE_CONFIG = {
  down: {
    icon: '🔴',
    label: 'Düştü',
    pill: 'text-red-400 border-red-500/40 bg-red-500/10',
    accent: 'rgba(248, 113, 113, 0.8)'
  },
  degraded: {
    icon: '🟠',
    label: 'Yavaşlıyor',
    pill: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
    accent: 'rgba(251, 191, 36, 0.8)'
  },
  redirect: {
    icon: '🟠',
    label: 'Yönlendirme',
    pill: 'text-yellow-300 border-yellow-500/40 bg-yellow-500/10',
    accent: 'rgba(250, 204, 21, 0.8)'
  },
  up: {
    icon: '🟢',
    label: 'Ayakta',
    pill: 'text-green-400 border-green-500/40 bg-green-500/10',
    accent: 'rgba(0, 255, 65, 0.8)'
  },
  measuring: {
    icon: '⚪',
    label: 'Ölçülüyor',
    pill: 'text-gray-400 border-gray-500/40 bg-gray-500/10',
    accent: 'rgba(156, 163, 175, 0.5)'
  }
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
  // Goruntude sade domain (protokol ve sondaki / kirpilir)
  const bare = String(host).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return bare.length > 28 ? `${bare.slice(0, 25)}...` : bare;
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
    let interval = null;
    // Panel 'hidden lg:block' wrapper'da: poll yalnizca kart gorunurken
    // (min-width: 1024px) calissin; media query degisimini de dinle.
    const mql = window.matchMedia('(min-width: 1024px)');

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

    const startPolling = () => {
      if (interval) return;
      load();
      interval = setInterval(load, POLL_MS);
    };

    const stopPolling = () => {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
    };

    const onMediaChange = (e) => (e.matches ? startPolling() : stopPolling());

    if (mql.matches) startPolling();
    mql.addEventListener('change', onMediaChange);
    return () => {
      cancelled = true;
      stopPolling();
      mql.removeEventListener('change', onMediaChange);
    };
  }, []);

  // Her zaman onem sirasina gore dizilmis liste (kritik durumlar ustte)
  const sortedTargets = useMemo(
    () =>
      [...targets].sort(
        (a, b) => (STATE_ORDER[a.state] ?? 99) - (STATE_ORDER[b.state] ?? 99)
      ),
    [targets]
  );

  const criticalCount = useMemo(
    () => targets.filter((t) => CRITICAL_STATES.has(t.state)).length,
    [targets]
  );

  const scrollable = sortedTargets.length > MAX_VISIBLE;

  return (
    <CyberCard className="p-5 flex flex-col gap-4">
      {/* Baslik: ikon + sayac + atif */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-green-400 font-mono flex items-center gap-2 shrink-0">
          <i className="ph ph-pulse text-base"></i>
          Etki Monitörü
        </h3>
        <div className="flex items-center gap-2 min-w-0">
          {targets.length > 0 && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-white/10 bg-white/5 text-gray-400 whitespace-nowrap">
              {targets.length} hedef
              {criticalCount > 0 && (
                <span className="text-red-400"> · {criticalCount} kritik</span>
              )}
            </span>
          )}
          <span className="text-[10px] text-gray-500 font-mono whitespace-nowrap">
            check-host.net · 30sn
          </span>
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-400 font-mono flex items-center gap-2">
          <i className="ph ph-warning-circle"></i>
          Veri alınamadı: {error}
        </div>
      )}

      {/* Bos durum */}
      {!error && targets.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <span className="impact-empty-icon flex items-center justify-center w-12 h-12 rounded-full border border-green-500/20 bg-green-500/5 text-green-400/70">
            <i className="ph ph-radar text-2xl"></i>
          </span>
          <p className="text-xs text-gray-500 font-mono max-w-[260px] leading-relaxed">
            Aktif saldırı yok — etki ölçümü saldırı başlayınca görünür.
          </p>
        </div>
      )}

      {/* Hedef listesi: 4'ten fazlaysa sabit yukseklikte dahili scroll */}
      <div
        className={`flex flex-col gap-2.5 ${
          scrollable ? 'max-h-[420px] overflow-y-auto impact-scroll pr-1.5' : ''
        }`}
      >
        {sortedTargets.map((t) => {
          const state = STATE_CONFIG[t.state] || STATE_CONFIG.measuring;
          const next = formatNext(t.nextCheckAt);
          return (
            <div
              key={t.key}
              className="impact-row rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 flex flex-col gap-2"
              style={{ '--impact-accent': state.accent }}
            >
              {/* Hedef + durum rozeti */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="text-[13px] text-white font-mono truncate tracking-tight"
                    title={t.host}
                  >
                    {shortenHost(t.host)}
                  </span>
                  <span className="text-[9px] font-mono px-1.5 py-px rounded-full border border-cyan-500/30 bg-cyan-500/10 text-cyan-400/90 shrink-0">
                    {t.layer}
                  </span>
                  {t.isLoop && (
                    <span className="text-[9px] font-mono px-1.5 py-px rounded-full border border-purple-500/30 bg-purple-500/10 text-purple-400 shrink-0 inline-flex items-center gap-1">
                      <i className="ph ph-repeat"></i> Loop
                    </span>
                  )}
                  {t.final && (
                    <span className="text-[9px] font-mono px-1.5 py-px rounded-full border border-gray-500/30 bg-gray-500/10 text-gray-400 shrink-0 inline-flex items-center gap-1">
                      <i className="ph ph-flag-checkered"></i> Final
                    </span>
                  )}
                </div>
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded-full border shrink-0 whitespace-nowrap ${state.pill}`}
                >
                  {state.icon} {state.label}
                </span>
              </div>

              {/* Gecikme ozeti */}
              <div className="flex items-center gap-4 text-[11px] font-mono">
                <span className="text-gray-500">
                  Gecikme{' '}
                  <span className="text-white">
                    {t.avgMs != null ? `${t.avgMs} ms` : '—'}
                  </span>
                </span>
                <span className="text-gray-700 select-none">/</span>
                <span className="text-gray-500">
                  Baseline{' '}
                  <span className="text-white">
                    {t.baselineMs != null ? `${t.baselineMs} ms` : '—'}
                  </span>
                </span>
              </div>

              {/* Node basina mini satirlar: ad solda, ms/code sagda */}
              {t.perNode && t.perNode.length > 0 && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-white/5 pt-1.5">
                  {t.perNode.map((n) => (
                    <div
                      key={n.node}
                      className="flex items-center justify-between text-[10px] font-mono"
                    >
                      <span className="text-gray-500">{nodeShortName(n.node)}</span>
                      <span className={n.ok ? 'text-green-400' : 'text-red-400'}>
                        {n.ok
                          ? `${n.ms != null ? `${n.ms} ms` : 'ok'}${n.code ? ` · ${n.code}` : ''}`
                          : 'timeout'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Zaman bilgisi */}
              <div className="flex items-center gap-1.5 text-[10px] text-gray-500 font-mono">
                <i className="ph ph-clock text-gray-600"></i>
                <span>
                  Son ölçüm {formatTime(t.lastCheckAt)}
                  {next
                    ? ` · Sıradaki ${next}`
                    : t.final
                      ? ' · Takip tamamlandı'
                      : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </CyberCard>
  );
};

export default ImpactMonitor;
